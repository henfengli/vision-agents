"""Run 详情页 + 状态 JSON + 图拓扑（运行图 2s 轮询局部刷新）。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ...agent import approvals
from ...langfuse import match_observation
from ...orchestration.submitter import TaskRejected
from ...store import feedback as feedback_store
from ...store import runs
from .base import esc, render


def make_router(env: str, engine=None, langfuse=None,
                target_envs: list[str] | None = None,
                submitter=None) -> APIRouter:
    router = APIRouter()

    @router.get("/runs", response_class=HTMLResponse)
    async def runs_list(request: Request):
        # 目标环境过滤：?env=xxx；单环境部署（无 target_envs）不出过滤器
        qenv = request.query_params.get("env") or None
        rows = await runs.list_recent(target_env=qenv, limit=100)
        return render("runs.html", "Runs", active="/runs",
                      rows=rows, qenv=qenv, target_envs=target_envs or [])

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
        # 只有资产图 run 有运行图：拓扑与节点状态来自台账 graph 事件 +
        # artifacts 表。普通 agent run 的深层观测一律走 Langfuse（硬依赖，
        # 整套栈一起部署），不再自研降级轨迹图；引擎静态骨架只在 /graph 拓扑页
        graph_event = next((e["payload"] for e in reversed(events)
                            if e["kind"] == "graph"
                            and isinstance(e["payload"], dict)), None)
        if graph_event is not None:
            from ...store import artifacts as artifacts_store
            arts = await artifacts_store.list_by_run(run_id)
            state["graph"] = {**graph_event,
                              "statuses": {a["name"]: a["status"]
                                           for a in arts}}
        return state

    @router.get("/runs/{run_id}", response_class=HTMLResponse)
    async def run_detail(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        # Langfuse trace 区：embed 开启时把官方 trace 页整页内嵌（先自动设为
        # 公开链接免登，再探测网关是否放行 iframe）；任一条件不满足降级外链。
        trace = {"mode": "", "embedded": False}
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                url = await langfuse.trace_url(tid)
                if (url and langfuse.embed
                        and await langfuse.publish_trace(tid)
                        and await langfuse.frame_check(url)):
                    # publish=false：同站点登录态部署，iframe 里是完整登录态
                    # UI（Annotate 可用）；否则是免登公开链接（只读）
                    trace = {"mode": "embedded", "embedded": True, "url": url,
                             "hint": ("公开链接 · 免登" if langfuse.publish
                                      else "登录会话 · Annotate 可用")}
                elif url and langfuse.embed:
                    trace = {"mode": "blocked", "url": url}
                else:
                    inner = (f'<a href="{esc(url)}" target="_blank">'
                             f'在 Langfuse 打开完整 trace ↗</a>'
                             f'（<code>{esc(tid)}</code>）' if url else
                             f'<a href="{esc(langfuse.host)}" target="_blank">'
                             f'Langfuse</a> 中搜索 <code>{esc(tid)}</code>')
                    trace = {"mode": "link", "inner": inner}
        pending = await approvals.find_pending(run_id)
        return render(
            "run_detail.html", f"Run {run_id[:8]}", active="/runs",
            run_id=run_id, pending=pending, trace=trace,
            input_json=json.dumps(run.get("input"),
                                  ensure_ascii=False, indent=2))

    @router.post("/runs/{run_id}/feedback")
    async def run_feedback(run_id: str, request: Request):
        form = await request.form()
        score = int(form["score"])
        await feedback_store.add(run_id, score, str(form.get("comment", "")))
        # 记忆按目标环境分区：反馈传播到该 run 实际操作的环境
        run = await runs.get(run_id)
        await feedback_store.propagate_to_memory(
            (run or {}).get("target_env") or env, run_id, score)
        return render("msg.html", "反馈", active="/runs",
                      heading="已记录，感谢。",
                      back_href="javascript:history.back()")

    @router.post("/runs/{run_id}/steps/{seq}/feedback")
    async def step_feedback(run_id: str, seq: int, request: Request):
        """节点级反馈：时间线某一步的 👍👎。Langfuse 回写优先挂到对应 span
        （match_observation：seq → observation id，等价 Annotate）；映射不上
        降级为 trace 级 score（名字带 step#seq 定位）。"""
        form = await request.form()
        score = int(form["score"])
        comment = str(form.get("comment", ""))
        await feedback_store.add_step(run_id, seq, score, comment)
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                events = await runs.get_events(run_id)
                obs = await langfuse.observations(tid)
                oid = match_observation(events, seq, obs)
                await langfuse.score(tid, f"step#{seq}", float(score), comment,
                                     observation_id=oid)
        return {"ok": True}

    @router.post("/runs/{run_id}/rerun")
    async def run_rerun(run_id: str):
        """详情页重跑：失败/终止 → 断点续跑（同 id）；成功 → 同输入新开 run。"""
        if submitter is None:
            raise HTTPException(501, "未接入提交端")
        try:
            result = await submitter.rerun(run_id)
        except TaskRejected as e:
            return render("msg.html", "重跑", active="/runs",
                          heading="无法重跑", message=str(e),
                          back_href=f"/runs/{run_id}")
        return RedirectResponse(f"/runs/{result['run_id']}", status_code=303)

    @router.get("/graph", response_class=HTMLResponse)
    async def graph_page():
        if engine is None:
            raise HTTPException(501, "未接入引擎")
        return render("graph.html", "Agent 图", active="/graph")

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
