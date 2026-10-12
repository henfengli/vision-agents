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
from .base import render


def make_router(env: str, langfuse=None,
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
    async def run_state(run_id: str, request: Request):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        events = await runs.get_events(run_id)
        # ?since=<seq> 增量轮询：只回新事件——事件 append-only，长 run
        # （成百上千步）全量轮询会让 2s 一次的传输量变成 O(N²)
        since = int(request.query_params.get("since") or 0)
        state = {
            "run": {k: run.get(k) for k in
                    ("run_id", "task_type", "task_version", "role",
                     "role_version", "status", "trigger_source",
                     "target_env", "duration_ms", "output", "session_id")},
            "created_at": str(run["created_at"]),
            "events": [_event_summary(e) for e in events if e["seq"] > since],
            "graph": None,
        }
        # 只有资产图 run 有运行图：拓扑与节点状态来自台账 graph 事件 +
        # artifacts 表。普通 agent run 的深层观测一律走 Langfuse（硬依赖，
        # 整套栈一起部署），不再自研降级轨迹图
        graph_event = next((e["payload"] for e in reversed(events)
                            if e["kind"] == "graph"
                            and isinstance(e["payload"], dict)), None)
        if graph_event is not None:
            from ...store import artifacts as artifacts_store
            arts = await artifacts_store.list_by_run(run_id)
            state["graph"] = {**graph_event,
                              "statuses": {a["name"]: a["status"]
                                           for a in arts}}
        # ?trace=1：trace 瀑布数据（Langfuse 为数据源，viewer 自绘视图）。
        # 客户端只在首拉与 run 终态各要一次；span→步骤 seq 映射复用
        # match_observation 的对齐规则，点 span 可跳到对应时间线步骤
        if request.query_params.get("trace") and langfuse is not None \
                and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                obs = await langfuse.observations(tid)
                seq_of = {}
                for e in events:
                    if e["kind"] in ("tool_call", "tool_result", "llm",
                                     "final"):
                        oid = match_observation(events, e["seq"], obs)
                        if oid and oid not in seq_of:
                            seq_of[oid] = e["seq"]
                state["trace"] = {
                    "url": await langfuse.trace_url(tid),
                    "spans": [_span_summary(o, seq_of) for o in obs],
                }
        return state

    @router.get("/runs/{run_id}", response_class=HTMLResponse)
    async def run_detail(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        # trace 瀑布卡：有 trace_id 就渲染容器，span 数据由 state.json?trace=1
        # 异步填充；右侧外链直达 Langfuse 官方 UI（Annotate 等深操作去那里）
        trace = {"tid": "", "url": ""}
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                trace = {"tid": tid, "url": await langfuse.trace_url(tid)}
        pending = await approvals.find_pending(run_id)
        return render(
            "run_detail.html", f"Run {run_id[:8]}", active="/runs",
            run_id=run_id, pending=pending, trace=trace,
            input_question=(run.get("input") or {}).get("question") or "",
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

    return router


def _clip_io(v, limit: int = 1500) -> str:
    """span 输入/输出截断为可读文本（瀑布详情面板用，防大 payload 撑爆首屏）。"""
    if v is None:
        return ""
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False,
                                                default=str)
    return s if len(s) <= limit else s[:limit] + " …（截断）"


def _span_summary(o: dict, seq_of: dict) -> dict:
    """Langfuse observation → 瀑布行数据。io 截断；seq = 对应时间线步骤。"""
    usage = o.get("usage") or {}
    return {"id": o.get("id"), "name": o.get("name") or "",
            "type": o.get("type") or "SPAN",
            "parent": o.get("parentObservationId") or "",
            "start": o.get("startTime"), "end": o.get("endTime"),
            "model": o.get("model") or "", "level": o.get("level") or "",
            "tokens": usage.get("totalTokens"),
            "cost": o.get("calculatedTotalCost"),
            "seq": seq_of.get(o.get("id")),
            "input": _clip_io(o.get("input")), "output": _clip_io(o.get("output"))}


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
