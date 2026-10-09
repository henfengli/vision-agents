"""Run 详情页 + 状态 JSON + 图拓扑（运行图 2s 轮询局部刷新）。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...store import feedback as feedback_store
from ...store import runs
from .base import esc, page, status_pill


def make_router(env: str, engine=None, langfuse=None,
                target_envs: list[str] | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/runs", response_class=HTMLResponse)
    async def runs_list(request: Request):
        # 目标环境过滤：?env=xxx；单环境部署（无 target_envs）不出过滤器
        qenv = request.query_params.get("env") or None
        rows = await runs.list_recent(target_env=qenv, limit=100)
        filt = ""
        if target_envs:
            opts = ['<option value="">全部环境</option>'] + [
                f'<option value="{esc(e)}"'
                f'{" selected" if e == qenv else ""}>{esc(e)}</option>'
                for e in target_envs]
            filt = (f'<form method="get" action="/runs" class="filter-bar">'
                    f'<select name="env" class="inline" onchange="this.form.submit()"'
                    f'>{"".join(opts)}</select></form>')
        body_rows = "".join(
            f'<tr><td><a class="run-link" href="/runs/{r["run_id"]}">'
            f'{r["run_id"][:8]}</a></td>'
            f'<td>{esc(r["task_type"])}</td><td>{esc(r["role"])}</td>'
            f'<td>{esc(r["target_env"] or "-")}</td>'
            f'<td>{status_pill(r["status"])}</td>'
            f'<td>{esc(r["trigger_source"])}</td>'
            f'<td class="meta">{r["created_at"]}</td></tr>'
            for r in rows)
        return page("Runs", f"""
        <div class="page-head">
          <div class="eyebrow">EXECUTIONS</div>
          <h2>最近 Runs</h2>
          <div class="meta">近 100 条 · 点击 run id 查看执行过程与运行图</div>
        </div>
        {filt}
        <div class="card"><table class="grid">
          <thead><tr><th>run</th><th>任务</th><th>角色</th><th>目标环境</th>
            <th>状态</th><th>来源</th><th>时间</th></tr></thead>
          <tbody>{body_rows or '<tr><td colspan="7" class="meta">暂无</td></tr>'}</tbody>
        </table></div>""", active="/runs")

    @router.get("/runs/{run_id}/state.json")
    async def run_state(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        events = await runs.get_events(run_id)
        state = {
            "run": {k: run.get(k) for k in
                    ("run_id", "task_type", "task_version", "role",
                     "role_version", "status", "trigger_source",
                     "target_env", "duration_ms", "output")},
            "created_at": str(run["created_at"]),
            "events": [_event_summary(e) for e in events],
            "graph": None,
        }
        # 资产图 run：拓扑与节点状态来自台账 graph 事件 + artifacts 表
        graph_event = next((e["payload"] for e in reversed(events)
                            if e["kind"] == "graph"
                            and isinstance(e["payload"], dict)), None)
        if graph_event is not None:
            from ...store import artifacts as artifacts_store
            arts = await artifacts_store.list_by_run(run_id)
            state["graph"] = {**graph_event,
                              "statuses": {a["name"]: a["status"]
                                           for a in arts}}
        else:
            # 普通 agent run：轨迹图按本 run 事件流构建——每个 run 形状不同；
            # 引擎静态骨架只在 /graph 拓扑页，详情页不再触发引擎构建
            pending = await approvals.find_pending(run_id)
            state["graph"] = _trace_graph(events, run["status"],
                                          pending=pending is not None)
        return state

    @router.get("/runs/{run_id}", response_class=HTMLResponse)
    async def run_detail(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        trace_link = ""
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                url = await langfuse.trace_url(tid)
                inner = (f'<a href="{url}" target="_blank">'
                         f'在 Langfuse 打开完整 trace ↗</a>'
                         f'（<code>{tid}</code>）' if url else
                         f'<a href="{langfuse.host}" target="_blank">Langfuse</a>'
                         f' 中搜索 <code>{tid}</code>')
                trace_link = f'<p class="meta">深度 trace：{inner}</p>'
        body = f"""
        <div id="run-head"><div class="meta">加载中…</div></div>
        {trace_link}
        <div class="graph-shell" id="graph-card" style="display:none">
          <div class="cy" id="graph"></div>
          <div class="graph-overlay graph-legend">
            <div><span class="sw" style="background:#34d399"></span>已执行</div>
            <div><span class="sw" style="background:#fbbf24"></span>进行中</div>
            <div><span class="sw" style="background:#f87171"></span>失败点</div>
            <div><span class="sw" style="background:#2a3a5f"></span>未执行</div>
            <div class="meta" style="margin-top:6px">点击节点 → 跳到对应步骤</div>
          </div>
          <div class="graph-overlay graph-tools">
            <button data-act="in">+</button><button data-act="out">−</button>
            <button data-act="fit">fit</button>
          </div>
        </div>
        <div class="card"><b>输入</b><pre>{esc(json.dumps(run.get('input'), ensure_ascii=False, indent=2))}</pre></div>
        <div class="page-head" style="margin-top:22px">
          <div class="eyebrow">TIMELINE</div><h3>执行过程</h3>
        </div>
        <div id="steps"></div>
        <div class="card"><b>最终输出</b><pre id="output"></pre></div>
        <div class="card">
          <b>这个结论有帮助吗？</b>
          <form method="post" action="/runs/{run_id}/feedback" class="filter-bar">
            <button name="score" value="1" class="ok">有用</button>
            <button name="score" value="-1" class="danger">有问题</button>
            <input name="comment" class="inline" placeholder="补充说明（可选）">
          </form>
        </div>
        <script src="/static/cytoscape.min.js"></script>
        <script src="/static/cytoscape-dagre.min.js"></script>
        <script src="/static/graph.js"></script>
        <script>watchRun("{run_id}");</script>"""
        return page(f"Run {run_id[:8]}", body, active="/runs")

    @router.post("/runs/{run_id}/feedback")
    async def run_feedback(run_id: str, request: Request):
        form = await request.form()
        score = int(form["score"])
        await feedback_store.add(run_id, score, str(form.get("comment", "")))
        # 记忆按目标环境分区：反馈传播到该 run 实际操作的环境
        run = await runs.get(run_id)
        await feedback_store.propagate_to_memory(
            (run or {}).get("target_env") or env, run_id, score)
        return page("反馈", '<div class="card"><b>已记录，感谢。</b>'
                            '<p><a href="javascript:history.back()">← 返回</a></p></div>',
                    active="/runs")

    @router.get("/graph", response_class=HTMLResponse)
    async def graph_page():
        if engine is None:
            raise HTTPException(501, "未接入引擎")
        return page("Agent 图", """
        <div class="page-head">
          <div class="eyebrow">TOPOLOGY</div>
          <h2>Agent 图拓扑</h2>
          <div class="meta"><a href="/">← 总览</a> · 引擎静态结构（与具体 run 无关）·
            拖拽平移 · 滚轮缩放 · 点击节点高亮邻接关系</div>
        </div>
        <div class="graph-shell tall">
          <div class="cy" id="graph"></div>
          <div class="graph-overlay graph-legend">
            <div><span class="sw" style="background:#22d3ee"></span>hover / 选中</div>
            <div><span class="sw" style="background:#2a3a5f"></span>节点</div>
          </div>
          <div class="graph-overlay graph-tools">
            <button data-act="in">+</button><button data-act="out">−</button>
            <button data-act="fit">fit</button>
          </div>
        </div>
        <script src="/static/cytoscape.min.js"></script>
        <script src="/static/cytoscape-dagre.min.js"></script>
        <script src="/static/graph.js"></script>
        <script>showTopology();</script>""", active="/graph")

    @router.get("/graph.json")
    async def graph_json():
        if engine is None:
            raise HTTPException(501, "未接入引擎")
        return await engine.graph_json()

    return router


def _trace_graph(events: list[dict], status: str,
                 pending: bool = False) -> dict | None:
    """普通 agent run 的执行轨迹图：按本 run 实际事件画出走过的步骤链。

    节点 = 开始 + 每次工具调用（工具名 + 参数首行预览）+ 结论（llm 收尾事件），
    边 = 事件先后；节点 id 与时间线步骤元素 id（seq-N）一致，点击可联动滚动。
    状态沿用运行图三态：已执行 / 进行中（末节点，run 未完结）/ 失败点；
    pending=True（有未决审批）时位置节点加 ⏸ 待审批——业务状态，Langfuse
    与 Temporal 都没有，只能在这里标。每步耗时/成败详情不归本图（Langfuse）。
    无事件（排队中）返回 None——详情页不显示图卡。
    """
    real = [e for e in events if e["kind"] != "graph"]
    if not real:
        return None
    nodes, edges = [{"id": "start", "label": "开始"}], []
    prev = "start"
    for e in real:
        if e["kind"] != "tool_call":
            continue
        p = e["payload"] if isinstance(e["payload"], dict) else {}
        nid = f"seq-{e['seq']}"
        label = p.get("tool") or "tool"
        args = str(p.get("args") or "").splitlines()[0][:48]
        if args:
            label += f"\n{args}"
        nodes.append({"id": nid, "label": label})
        edges.append({"source": prev, "target": nid})
        prev = nid
    final = next((e for e in reversed(real) if e["kind"] == "llm"), None)
    if final is not None:
        nodes.append({"id": f"seq-{final['seq']}", "label": "结论"})
        edges.append({"source": prev, "target": f"seq-{final['seq']}"})
        prev = f"seq-{final['seq']}"
    if len(nodes) == 1:  # 无工具调用（纯问答 / 模型即失败）：末事件兜底一个节点
        last = real[-1]
        label = {"thought": "思考", "llm": "结论", "note": "备注"}.get(
            last["kind"], last["kind"])
        nodes.append({"id": f"seq-{last['seq']}", "label": label})
        edges.append({"source": "start", "target": f"seq-{last['seq']}"})
        prev = f"seq-{last['seq']}"
    statuses = {n["id"]: "executed" for n in nodes}
    if status in ("running", "queued"):
        statuses[prev] = "active"
    elif status == "failed":
        statuses[prev] = "failed"
    if pending and len(nodes) > 1:
        for n in nodes:
            if n["id"] == prev:
                n["label"] += "\n⏸ 待审批"
    return {"nodes": nodes, "edges": edges, "statuses": statuses, "trace": True}


def _event_summary(e: dict) -> dict:
    """事件 → 前端渲染用的精简结构。"""
    p = e["payload"] if isinstance(e["payload"], dict) else {}
    out = {"seq": e["seq"], "kind": e["kind"], "node": p.get("node", ""),
           "created_at": e["created_at"]}
    if e["kind"] == "tool_call":
        out.update(tool=p.get("tool", ""), text=p.get("args", ""))
    elif e["kind"] == "tool_result":
        out.update(tool=p.get("tool", ""), text=p.get("output", ""))
    else:
        out["text"] = p.get("content") or p.get("error") or str(p)
    return out
