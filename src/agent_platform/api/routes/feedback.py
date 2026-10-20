"""反馈：对整次运行或其中一步的评价（分数 + 问题类型 + 说明）。一人一步一条，再提交即覆盖。

    PUT    /v1/runs/{id}/feedback                 评价整次运行 {score: 1|-1, reasons, comment}
    DELETE /v1/runs/{id}/feedback                 撤回
    PUT    /v1/runs/{id}/events/{seq}/feedback    评价某一步（同上）
    DELETE /v1/runs/{id}/events/{seq}/feedback    撤回
    GET    /v1/feedback                           反馈收件箱：score service env task reason hours limit

整次运行的评价会调整这次运行沉淀的知识、案例、方法的召回权重；单步评价只留档。
新的 👎 按通知规则（事件 feedback_negative）推送；改说明不重复推送。
问题类型的取值与中文名见 GET /v1/meta 的 feedback_reasons。
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import FEEDBACK_REASONS, WHOLE_RUN, Feedback, Rejected
from ...notify import Message
from ...store import feedback as feedback_store
from ...store import runs
from ..deps import RT, WHO, Caller, Runtime

router = APIRouter(prefix="/v1")


async def _announce_negative(rt: Runtime, run: dict, step_seq: int, fb: Feedback, who: Caller) -> None:
    """👎 按通知规则（事件 feedback_negative）推出去，让任务的负责人看到。"""
    where = "整次运行" if step_seq == WHOLE_RUN else f"第 {step_seq} 步"
    lines = [f"**{who.name}** 对 {run['task']}（{run['service'] or '平台'} · {run['env']}）的{where}点了 👎",
             f"> {run['summary']}"]
    if fb.reasons:
        lines.append("问题：" + "、".join(FEEDBACK_REASONS[r] for r in fb.reasons))
    if fb.comment:
        lines.append(f"说明：{fb.comment}")
    msg = Message(title="收到负反馈", text="\n\n".join(lines), link=rt.notifier.link(f"/runs/{run['run_id']}"),
                  link_title="查看运行")
    await rt.notifier.emit("feedback_negative", msg, service=run["service"], env=run["env"], task=run["task"],
                           trigger=run.get("trigger_type"))


async def _run(run_id: str) -> dict:
    run = await runs.get(run_id)
    if run is None:
        raise Rejected.not_found(f"运行 {run_id}")
    return run


async def _step(run_id: str, seq: int) -> None:
    await _run(run_id)
    if seq < 1 or not await runs.has_event(run_id, seq):
        raise Rejected.not_found(f"运行 {run_id} 的第 {seq} 步")


@router.put("/runs/{run_id}/feedback")
async def rate_run(run_id: str, body: Feedback, rt: Runtime = RT, who: Caller = WHO):
    run = await _run(run_id)
    saved, old = await feedback_store.put(run_id, WHOLE_RUN, who.name, body)
    await feedback_store.shift_memory_weight(run["env"], run_id, old, body.score)
    if body.score < 0 and old != -1:
        await _announce_negative(rt, run, WHOLE_RUN, body, who)
    return saved


@router.delete("/runs/{run_id}/feedback", status_code=204)
async def unrate_run(run_id: str, who: Caller = WHO):
    run = await _run(run_id)
    old = await feedback_store.remove(run_id, WHOLE_RUN, who.name)
    await feedback_store.shift_memory_weight(run["env"], run_id, old, None)


@router.put("/runs/{run_id}/events/{seq}/feedback")
async def rate_step(run_id: str, seq: int, body: Feedback, rt: Runtime = RT, who: Caller = WHO):
    await _step(run_id, seq)
    saved, old = await feedback_store.put(run_id, seq, who.name, body)
    if body.score < 0 and old != -1:
        await _announce_negative(rt, await _run(run_id), seq, body, who)
    return saved


@router.delete("/runs/{run_id}/events/{seq}/feedback", status_code=204)
async def unrate_step(run_id: str, seq: int, who: Caller = WHO):
    await _step(run_id, seq)
    await feedback_store.remove(run_id, seq, who.name)


@router.get("/feedback")
async def inbox(score: int | None = None, service: str | None = None, env: str | None = None,
                task: str | None = None, reason: str | None = None, hours: int | None = None,
                limit: int = 100, _: Caller = WHO):
    return await feedback_store.listing(score=score, service=service, env=env, task=task, reason=reason,
                                        hours=hours, limit=limit)
