"""控制台（SPA）数据端点：/v1/console/*。

SPA（web/，React+Vite 静态构建）的一切数据从这里出；与 SDK 用的 /v1/*
同进程同鉴权（bearer）。本模块只做"store/引擎 → JSON"的整形，不含业务
判断；run 详情的轨迹图构建（_trace_graph/_event_summary）也在这里——
它是详情数据的唯一出处，前端只管渲染。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import __version__
from ..agent import approvals
from ..langfuse import match_observation
from ..orchestration.submitter import Submitter, TaskRejected
from ..store import feedback as feedback_store
from ..store import knowledge as knowledge_store
from ..store import runs


class StepFeedbackRequest(BaseModel):
    score: int
    comment: str = ""


class MemoryUpdateRequest(BaseModel):
    content: str


def make_console_router(settings, submitter: Submitter, auth,
                        engine=None, langfuse=None) -> APIRouter:
    """auth：与 /v1 其余端点同一个 bearer 依赖（main 装配时传入）。"""
    router = APIRouter(prefix="/v1/console", dependencies=[Depends(auth)])

    @router.get("/meta")
    async def meta():
        """SPA 引导信息：环境、可选目标环境、业务域、版本、Langfuse 能力。"""
        return {"env": settings.env,
                "target_envs": settings.target_envs or [],
                "domains": list(settings.domains),
                "version": __version__,
                "langfuse": {
                    "enabled": bool(langfuse is not None and langfuse.enabled),
                    "publish": bool(langfuse is not None and langfuse.publish)}}

    @router.get("/overview")
    async def overview():
        return await runs.overview()

    @router.get("/runs/{run_id}")
    async def run_detail(run_id: str):
        """详情页一整屏数据：run + 事件 + 轨迹图 + 待审批 + Langfuse trace。

        trace.embed 为 true 时前端直接 iframe 内嵌（publish/frame_check 已
        在服务端做完）；否则前端画自研轨迹图 + 给外链。"""
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        events = await runs.get_events(run_id)
        graph = None
        graph_event = next((e["payload"] for e in reversed(events)
                            if e["kind"] == "graph"
                            and isinstance(e["payload"], dict)), None)
        if graph_event is not None:
            from ..store import artifacts as artifacts_store
            arts = await artifacts_store.list_by_run(run_id)
            graph = {**graph_event,
                     "statuses": {a["name"]: a["status"] for a in arts}}
        else:
            pending_ev = await approvals.find_pending(run_id)
            graph = _trace_graph(events, run["status"],
                                 pending=pending_ev is not None)
        pending = await approvals.find_pending(run_id)
        trace = None
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                url = await langfuse.trace_url(tid)
                embed = bool(url and langfuse.embed
                             and await langfuse.publish_trace(tid)
                             and await langfuse.frame_check(url))
                trace = {"url": url, "embed": embed,
                         "publish": langfuse.publish}
        return {"run": {k: run.get(k) for k in
                        ("run_id", "task_type", "task_version", "role",
                         "role_version", "status", "trigger_source",
                         "target_env", "duration_ms", "input", "output")},
                "created_at": str(run["created_at"]),
                "events": [_event_summary(e) for e in events],
                "graph": graph,
                "pending": ({"command": pending["command"]}
                            if pending else None),
                "trace": trace}

    @router.post("/runs/{run_id}/rerun")
    async def rerun(run_id: str):
        """重跑：失败/终止 → 同 id 断点续跑；成功 → 同输入新开 run。"""
        try:
            return await submitter.rerun(run_id)
        except TaskRejected as e:
            raise HTTPException(409, str(e))

    @router.post("/runs/{run_id}/steps/{seq}/feedback")
    async def step_feedback(run_id: str, seq: int, req: StepFeedbackRequest):
        """节点级反馈：挂 Langfuse 对应 span（Annotate 的 API 等价），
        映射不上降级 trace 级。"""
        await feedback_store.add_step(run_id, seq, req.score, req.comment)
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                events = await runs.get_events(run_id)
                obs = await langfuse.observations(tid)
                oid = match_observation(events, seq, obs)
                await langfuse.score(tid, f"step#{seq}", float(req.score),
                                     req.comment, observation_id=oid)
        return {"ok": True}

    @router.get("/approvals")
    async def pending_approvals():
        items = await approvals.list_pending()
        return {"count": await approvals.pending_count(), "items": items}

    @router.get("/memory/entries")
    async def memory_entries(env: str | None = None, domain: str | None = None,
                             include_inactive: bool = False):
        # 记忆按目标环境分区：缺省看实例默认环境
        return await knowledge_store.list_all(
            env or settings.env, domain or None,
            include_inactive=include_inactive)

    @router.post("/memory/entries/{entry_id}")
    async def memory_update(entry_id: int, req: MemoryUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        await knowledge_store.update_content(entry_id, req.content)
        return {"ok": True}

    @router.get("/graph")
    async def graph_topology():
        """引擎静态拓扑（与具体 run 无关）；首次构建约 30s。"""
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
    无事件（排队中）返回 None——前端不显示图卡。
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
