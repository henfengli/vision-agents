"""审批（默认关闭，设置 → 审批）。两类人工门共用一张单子：command（危险命令）/ process（进程启停）。

    GET  /v1/approvals            列表：status=pending|decided  kind  service  env
    GET  /v1/approvals/{id}
    POST /v1/approvals/{id}/approve   {comment}
    POST /v1/approvals/{id}/reject    {comment}

运行中途的门（command / 运行里发起的 process）由等待中的运行自己继续；
控制台发起的进程启停放行后在这里执行。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from ...domain import Rejected
from ...store import approvals as approvals_store
from ..deps import ADMIN, RT, WHO, Caller, Runtime
from ..schemas import DecisionBody
from .services import perform

router = APIRouter(prefix="/v1/approvals")
log = logging.getLogger(__name__)


@router.get("")
async def list_approvals(status: str | None = None, kind: str | None = None, service: str | None = None,
                         env: str | None = None, _: Caller = WHO):
    return await approvals_store.listing(status=status, kind=kind, service=service, env=env)


@router.get("/{approval_id}")
async def get_approval(approval_id: int, _: Caller = WHO):
    a = await approvals_store.get(approval_id)
    if a is None:
        raise Rejected.not_found(f"审批单 {approval_id}")
    return a


@router.post("/{approval_id}/approve")
async def approve(approval_id: int, body: DecisionBody, rt: Runtime = RT, who: Caller = ADMIN):
    return await _decide(rt, approval_id, True, body.comment, who)


@router.post("/{approval_id}/reject")
async def reject(approval_id: int, body: DecisionBody, rt: Runtime = RT, who: Caller = ADMIN):
    return await _decide(rt, approval_id, False, body.comment, who)


async def _decide(rt: Runtime, approval_id: int, approved: bool, comment: str, who: Caller) -> dict:
    current = await approvals_store.get(approval_id)
    if current is None:
        raise Rejected.not_found(f"审批单 {approval_id}")
    decided = await approvals_store.decide(approval_id, approved, who.name, comment)
    if decided is None:
        raise Rejected("already_decided", f"已被 {current['decided_by'] or '系统'} 处理（{current['status']}）", 409)

    if decided["kind"] == "process" and decided["payload"].get("executor") == "api" and approved:
        p = decided["payload"]
        try:
            await perform(rt, p["action"], p["service"], p["env"], p["process"], p.get("hours"), p.get("by") or who.name)
        except Rejected as e:
            log.warning("审批放行后执行进程%s失败：%s", p["action"], e.message)
            return {**decided, "result": {"error": {"code": e.code, "message": e.message}}}
    return decided
