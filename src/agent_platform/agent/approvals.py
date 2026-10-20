"""人工门：运行中途需要人放行的地方（危险命令、受保护环境的进程启停、任务图闸门节点）。

一处实现"发起 → 通知 → 挂起等待 → 放行 / 拒绝 / 超时"：
- DB 行是事实源；决定后 pg_notify 毫秒唤醒，轮询兜底（notify 只是提示）
- 等待期间运行状态是 awaiting_approval，放行后回到 running，列表与详情实时可见
- 在 Temporal activity 里等待时持续 heartbeat，长时间等待不会被判定卡死
- 超时视同拒绝（安全侧默认）
哪些命令算危险、哪些环境必审、多久超时：设置 → 审批。
"""

from __future__ import annotations

import asyncio
import re
import time

from ..domain import ApprovalsConfig
from ..notify import Message, Notifier
from ..registry import Registry
from ..store import approvals as approvals_store
from ..store import db, runs
from . import scope as run_scope


class ApprovalRejected(PermissionError):
    """被拒或超时：工具把它转成给模型的文本，图节点把它转成跳过。"""


def _heartbeat() -> None:
    try:
        from temporalio import activity
        activity.heartbeat("waiting-approval")
    except Exception:  # noqa: BLE001 —— 不在 activity 里（API 进程直接调用）时空操作
        pass


async def wait_decision(approval_id: int, timeout_s: float, poll_s: float = 10.0) -> str:
    """等审批单离开 pending，返回最终状态：approved / rejected / expired。"""
    import psycopg

    deadline = time.monotonic() + timeout_s
    try:
        listener = await psycopg.AsyncConnection.connect(db.dsn(), autocommit=True)
        await listener.execute("LISTEN approvals")
    except Exception:  # noqa: BLE001 —— 建不起监听就纯轮询
        listener = None
    try:
        while True:
            _heartbeat()
            status = await approvals_store.status_of(approval_id)
            if status and status != "pending":
                return status
            if time.monotonic() >= deadline:
                await approvals_store.expire_overdue()
                return await approvals_store.status_of(approval_id) or "expired"
            wait = min(poll_s, max(0.5, deadline - time.monotonic()))
            if listener is None:
                await asyncio.sleep(wait)
                continue
            try:
                async for _ in listener.notifies(timeout=wait, stop_after=1):
                    break
            except Exception:  # noqa: BLE001 —— 监听断了，退化为轮询
                listener = None
    finally:
        if listener is not None:
            await listener.close()


class Gatekeeper:
    def __init__(self, registry: Registry, notifier: Notifier):
        self._reg = registry
        self._notifier = notifier

    async def review(self, tool: str, text: str) -> None:
        """工具执行前调用：危险就挂起等审批，被拒抛 ApprovalRejected。"""
        s = run_scope.current()
        cfg: ApprovalsConfig = await self._reg.config("approvals")
        if cfg.required_in == "protected" and not s.protected:
            return
        pattern = next((p for p in cfg.danger_patterns if re.search(p, text, re.IGNORECASE)), None)
        if pattern is None:
            return
        await self.hold(kind="command", title=f"{tool} · {s.service or '平台'}@{s.env}", detail=text,
                        payload={"tool": tool, "pattern": pattern})

    async def hold(self, *, kind: str, title: str, detail: str, payload: dict | None = None) -> None:
        """在当前运行里发起审批并挂起，直到有结论。"""
        s = run_scope.current()
        cfg: ApprovalsConfig = await self._reg.config("approvals")
        a = await approvals_store.create(kind=kind, title=title, detail=detail, run_id=s.run_id, service=s.service,
                                         env=s.env, task=s.task, payload=payload, requested_by=f"run:{s.run_id}",
                                         timeout_s=cfg.timeout_minutes * 60)
        await runs.set_status(s.run_id, "awaiting_approval")
        await runs.log_event(s.run_id, "approval", {"approval_id": a["id"], "title": title, "content": detail[:2000]})
        await self.announce(a)

        status = await wait_decision(a["id"], cfg.timeout_minutes * 60)
        decided = await approvals_store.get(a["id"]) or a
        await runs.set_status(s.run_id, "running")
        verdict = {"approved": "已放行", "rejected": "已拒绝"}.get(status, "超时未处理")
        await runs.log_event(s.run_id, "approval", {
            "approval_id": a["id"], "decision": "approved" if status == "approved" else "rejected",
            "title": f"{verdict}（{decided.get('decided_by') or '—'}）", "content": decided.get("comment") or ""})
        if status != "approved":
            reason = f"：{decided['comment']}" if decided.get("comment") else ""
            raise ApprovalRejected(f"审批{verdict}{reason}，操作未执行")

    async def announce(self, a: dict) -> None:
        """新审批单的通知（按设置里的通知规则，事件 approval_requested）。"""
        where = " · ".join(x for x in (a.get("service"), a.get("env"), a.get("task")) if x)
        await self._notifier.emit(
            "approval_requested",
            Message(title=f"待审批：{a['title']}", text=f"{where}\n\n```\n{a['detail'][:800]}\n```",
                    link=self._notifier.link(f"/approvals?id={a['id']}"), link_title="去审批"),
            service=a.get("service"), env=a.get("env"), task=a.get("task"))
