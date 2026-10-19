"""Run 列表/详情页：列表页是全套过滤（chips+下拉+关键词+时间范围）+
可排序表头 + keyset 分页；详情页状态 JSON + 图拓扑（2s 轮询局部刷新）。

列表页交互遵守「URL 即状态」：所有过滤/排序/光标都在 query string，
可分享、刷新不丢（page_url 助手，见 base.py）。
"""

from __future__ import annotations

import json
from functools import partial

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ...agent import approvals
from ...orchestration.submitter import TaskRejected
from ...store import feedback as feedback_store
from ...store import runs
from .base import page_url, qint, render

_PAGE = 50
_STATUSES = [("", "全部"), ("running", "运行中"), ("queued", "排队"),
             ("success", "成功"), ("failed", "失败"), ("cancelled", "已取消")]
_SOURCES = [("", "全部来源"), ("web_chat", "对话"), ("schedule", "调度"),
            ("sensor", "传感器"), ("sdk", "SDK"), ("webhook", "Webhook")]
_RANGES = [("", "全部时间"), ("24", "24 小时"), ("168", "7 天"),
           ("720", "30 天")]


def make_router(env: str, langfuse=None,
                target_envs: list[str] | None = None,
                submitter=None, defs_store=None,
                domains: list[str] | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/runs", response_class=HTMLResponse)
    async def runs_list(request: Request):
        p = request.query_params
        status = p.get("status") or ""
        hours = qint(p.get("range"), 0, "range")
        try:
            rows, total, next_c, prev_c = await runs.list_filtered(
                target_env=p.get("env") or None, status=status or None,
                domain=p.get("domain") or None, task=p.get("task") or None,
                source=p.get("source") or None,
                session=p.get("session") or None,
                q=p.get("q") or None,
                hours=hours or None,
                sort=p.get("sort") or "created_at", asc=p.get("dir") == "asc",
                after=p.get("c") or None, before=p.get("b") or None,
                limit=_PAGE)
        except ValueError as e:  # 手改的非法分页光标
            raise HTTPException(400, str(e)) from None
        u = partial(page_url, request)
        pager = None
        if total:
            pager = {
                "total": total, "count": len(rows),
                "prev_url": u(b=prev_c, c="") if prev_c else None,
                "next_url": u(c=next_c, b="") if next_c else None,
            }
        return render("runs.html", "Runs", active="/runs",
                      rows=rows, pager=pager, u=u,
                      f_status=status, f_range=p.get("range") or "",
                      f_env=p.get("env") or "", f_domain=p.get("domain") or "",
                      f_task=p.get("task") or "", f_q=p.get("q") or "",
                      f_source=p.get("source") or "",
                      f_session=p.get("session") or "",
                      sort=p.get("sort") or "created_at",
                      dir=p.get("dir") or "desc",
                      statuses=_STATUSES, sources=_SOURCES, ranges=_RANGES,
                      target_envs=target_envs or [], domains=domains or [])

    @router.get("/runs/{run_id}/state.json")
    async def run_state(run_id: str, request: Request):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        # ?since=<seq> 增量轮询：只回新事件——事件 append-only，过滤推进
        # SQL（get_events 的 after_seq），长 run（成百上千步）的 2s 轮询
        # 不再每轮全量搬运事件表。缺省 -1 = 全量（seq>−1 含直插的 seq=0）
        since = qint(request.query_params.get("since"), -1, "since")
        events = await runs.get_events(run_id, after_seq=since)
        state = {
            "run": {k: run.get(k) for k in
                    ("run_id", "task_type", "task_version", "role",
                     "role_version", "status", "trigger_source",
                     "target_env", "duration_ms", "output", "session_id")},
            "created_at": str(run["created_at"]),
            "events": [_event_summary(e) for e in events],
            "graph": None,
        }
        # 只有资产图 run 有运行图：拓扑与节点状态来自台账 graph 事件 +
        # artifacts 表。普通 agent run 的深层观测一律走 Langfuse（硬依赖，
        # 整套栈一起部署），不再自研降级轨迹图。graph 事件单独查（一行），
        # 与事件增量拉取解耦
        graph_event = await runs.get_graph_event(run_id)
        if graph_event is not None:
            from ...store import artifacts as artifacts_store
            arts = await artifacts_store.list_by_run(run_id)
            state["graph"] = {**graph_event,
                              "statuses": {a["name"]: a["status"]
                                           for a in arts}}
        # ?trace=1：Langfuse span 元信息按步骤 seq 回填（模型名/token/成本/
        # 真实耗时，时间线步骤行内联展示）。客户端只在首拉与终态各要一次——
        # span 入库有延迟，终态补拉保证完整。模型步骤与 GENERATION span 按
        # 各自时序第 n 次对齐（展示用途；反馈写回的精确映射仍走
        # match_observation）
        if request.query_params.get("trace") and langfuse is not None \
                and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                # span 对齐按同类事件的第 n 次出现计算，需要全量事件
                # （低频路径：客户端只在首拉与终态各要一次）
                full_events = await runs.get_events(run_id)
                state["trace"] = {
                    "url": await langfuse.trace_url(tid),
                    "meta": _span_meta(full_events,
                                       await langfuse.observations(tid)),
                }
        return state

    @router.get("/runs/{run_id}", response_class=HTMLResponse)
    async def run_detail(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        # trace 外链：有 trace_id 就在「执行过程」标题行给直达 Langfuse 官方
        # UI 的链接（Annotate/队列等深操作去那里）；span 元信息由
        # state.json?trace=1 异步回填到步骤行
        trace = {"tid": "", "url": ""}
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                trace = {"tid": tid, "url": await langfuse.trace_url(tid)}
        pending = await approvals.find_pending(run_id)
        context = await _run_context(run, run_id, defs_store, env)
        return render(
            "run_detail.html", f"Run {run_id[:8]}", active="/runs",
            run_id=run_id, pending=pending, trace=trace, ctx=context,
            input_question=(run.get("input") or {}).get("question") or "",
            input_json=json.dumps(run.get("input"),
                                  ensure_ascii=False, indent=2))

    @router.post("/runs/{run_id}/feedback")
    async def run_feedback(run_id: str, request: Request):
        form = await request.form()
        score = qint(form.get("score"), 0, "score")
        if score not in (1, -1):
            raise HTTPException(400, "score 只能是 +1 或 -1")
        await feedback_store.add(run_id, score, str(form.get("comment", "")))
        # 记忆按目标环境分区：反馈传播到该 run 实际操作的环境
        run = await runs.get(run_id)
        await feedback_store.propagate_to_memory(
            (run or {}).get("target_env") or env, run_id, score)
        return render("msg.html", "反馈", active="/runs",
                      heading="已记录，感谢。",
                      back_href="javascript:history.back()")

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


async def _run_context(run: dict, run_id: str, defs_store,
                       env: str) -> dict:
    """run 详情「上下文与沉淀」卡：这次 run 召回/产生/关联了什么。

    五块：任务档案（run 当时生效的任务定义版本上的 context，确定性
    挂载）→ 召回的知识（recall_hits 反查）→ 召回的任务资产（prepare
    事件里的 asset_ids）→ 本次沉淀（knowledge/assets 的 source_run
    反查）→ 同会话的其他 run（故障周期/续聊链）。全部有出处可查，
    不从 prompt 文本里猜。
    """
    from ...orchestration.tasks import profile_lines
    from ...store import assets as assets_store
    from ...store import knowledge as knowledge_store

    ctx: dict = {"task_profile": [], "profile_text": "",
                 "knowledge_hits": [], "assets_recalled": [],
                 "assets_saved": [], "knowledge_saved": [],
                 "session_id": run.get("session_id") or "",
                 "session_runs": []}

    # 档案：prepare 把注入的原文（服务档案 + 任务档案）落成 stage=profile
    # 事件，有就原样展示；老 run 没有这条事件时按 task_version 回读子任务
    # 定义并与父任务 context 合并（近似回推，只覆盖任务档案）
    try:
        for e in await runs.get_events(run_id):
            p = e["payload"] if isinstance(e["payload"], dict) else {}
            if p.get("stage") == "profile" and p.get("content"):
                ctx["profile_text"] = p["content"]
    except Exception:  # noqa: BLE001 —— 档案缺失不挡详情页
        pass
    try:
        if not ctx["profile_text"] and defs_store is not None \
                and run.get("task_version") \
                and run.get("task_type"):
            definition = await defs_store.get_version(
                "task", env, run["task_type"], run["task_version"]) or {}
            parent_name = definition.get("extends")
            if parent_name:
                parent = await defs_store.get_active("task", env,
                                                     parent_name) or {}
                merged = dict(parent.get("context") or {})
                merged.update(definition.get("context") or {})
                definition = {**definition, "context": merged}
            ctx["task_profile"] = profile_lines(definition)
    except Exception:  # noqa: BLE001 —— 档案缺失不挡详情页
        pass

    ctx["knowledge_hits"] = await knowledge_store.hits_for_run(run_id)
    ctx["assets_saved"] = await assets_store.by_source_run(run_id)
    ctx["knowledge_saved"] = await knowledge_store.by_source_run(run_id)

    # 召回的任务资产：prepare 阶段把 asset_ids 写进了 stage=assets 事件
    try:
        events = await runs.get_events(run_id)
        ids: list[int] = []
        for e in events:
            p = e["payload"] if isinstance(e["payload"], dict) else {}
            if p.get("stage") == "assets" and p.get("asset_ids"):
                ids.extend(p["asset_ids"])
        if ids:
            ctx["assets_recalled"] = await assets_store.by_ids(ids)
    except Exception:  # noqa: BLE001 —— 上下文卡失败不挡详情页主体
        pass

    sid = ctx["session_id"]
    if sid and sid != run_id:
        ctx["session_runs"] = await runs.list_by_session(sid, exclude=run_id)
    return ctx


def _span_meta(events: list[dict], observations: list[dict]) -> dict:
    """模型步骤 seq → Langfuse span 元信息（model/tokens/cost/真实毫秒）。

    展示用途的对齐：模型类步骤（thought/llm/final）按 seq 排序、
    GENERATION span 按 startTime 排序，第 n 个对第 n 个——与反馈写回
    的 match_observation 同源规则，但覆盖 thought（展示无写副作用，
    映射不上只是少一行元信息）。
    """
    gens = sorted((o for o in observations if o.get("type") == "GENERATION"),
                  key=lambda o: o.get("startTime") or "")
    meta = {}
    i = 0
    for e in events:
        if e["kind"] not in ("thought", "llm", "final"):
            continue
        if i >= len(gens):
            break
        o = gens[i]
        i += 1
        ms = None
        if o.get("startTime") and o.get("endTime"):
            from datetime import datetime
            try:
                ms = int((datetime.fromisoformat(
                    o["endTime"].replace("Z", "+00:00"))
                    - datetime.fromisoformat(
                        o["startTime"].replace("Z", "+00:00"))
                ).total_seconds() * 1000)
            except ValueError:  # 时间格式异常就缺省，不挡主流程
                ms = None
        meta[e["seq"]] = {
            "model": o.get("model") or "",
            "tokens": (o.get("usage") or {}).get("totalTokens"),
            "cost": o.get("calculatedTotalCost"),
            "ms": ms,
        }
    return meta


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
