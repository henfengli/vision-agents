"""Run 详情页 + 状态 JSON + 图拓扑（运行图 2s 轮询局部刷新）。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

from ...store import feedback as feedback_store
from ...store import runs
from .base import esc, page


def make_router(env: str, engine=None, langfuse=None) -> APIRouter:
    router = APIRouter()

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
                     "duration_ms", "output")},
            "created_at": str(run["created_at"]),
            "events": [_event_summary(e) for e in events],
            "graph": None,
        }
        if engine is not None:
            try:
                state["graph"] = await engine.graph_json()
            except Exception:  # noqa: BLE001 —— 图失败不影响步骤时间线
                pass
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
                trace_link = (f'<p class="meta">🔍 深度 trace：'
                              f'<a href="{langfuse.host}" target="_blank">Langfuse</a>'
                              f' 中搜索 <code>{tid}</code></p>')
        body = f"""
        <div id="run-head"></div>
        {trace_link}
        <div class="card" id="graph-card" style="display:none">
          <b>运行图</b>
          <span class="meta">绿=已执行 · 黄=进行中 · 红=失败点 · 点击节点跳到对应步骤</span>
          <div id="graph"></div>
        </div>
        <div class="card"><b>输入</b><pre>{esc(str(run.get('input')))}</pre></div>
        <h3>执行过程</h3><div id="steps"></div>
        <div class="card"><b>最终输出</b><pre id="output"></pre></div>
        <div class="card">
          <form method="post" action="/runs/{run_id}/feedback">
            <b>这个结论有帮助吗？</b><br>
            <button name="score" value="1">👍 有用</button>
            <button name="score" value="-1">👎 有问题</button><br>
            <input name="comment" placeholder="补充说明（可选）">
          </form>
        </div>
        <script src="/static/dagre.min.js"></script>
        <script src="/static/graph.js"></script>
        <script>watchRun("{run_id}");</script>"""
        return page(f"Run {run_id}", body)

    @router.post("/runs/{run_id}/feedback")
    async def run_feedback(run_id: str, request: Request):
        form = await request.form()
        score = int(form["score"])
        await feedback_store.add(run_id, score, str(form.get("comment", "")))
        await feedback_store.propagate_to_memory(env, run_id, score)
        return page("反馈", "<p>已记录，感谢。</p>"
                           "<p><a href='javascript:history.back()'>返回</a></p>")

    @router.get("/graph", response_class=HTMLResponse)
    async def graph_page():
        if engine is None:
            raise HTTPException(501, "未接入引擎")
        return page("Agent 图", """
        <h2>Agent 图拓扑</h2>
        <div class="card"><div id="graph"></div></div>
        <script src="/static/dagre.min.js"></script>
        <script src="/static/graph.js"></script>
        <script>showTopology();</script>""")

    @router.get("/graph.json")
    async def graph_json():
        if engine is None:
            raise HTTPException(501, "未接入引擎")
        return await engine.graph_json()

    return router


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
