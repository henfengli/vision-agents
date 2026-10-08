"""人工审批：生产环境危险命令的拦截与放行。

流程：工具执行前 review 回调命中危险模式 → 写 approvals 行
→ 钉钉推 actionCard（按钮跳 Run Viewer 审批页）→ 审批人放行/拒绝
→ 本模块等决定后放行执行或抛阻断异常；超时视同拒绝（安全侧默认）。
等待用 LISTEN/NOTIFY 毫秒级唤醒，轮询兜底（notify 只是提示，DB 行是事实源）。

run 上下文通过 contextvar 传递：agent 引擎是跨 run 共享复用的，
review hook 在构建时拿不到 run_id，执行时由 Runner 注入。

不走 LangGraph interrupt 的考虑：审批等待可能长达分钟级，
用 DB 轮询即可表达，链路更简单、可独立测试。
"""

from __future__ import annotations

import asyncio
import re
import time
from contextvars import ContextVar

from ..store.db import dsn, notify, pool

current_run_id: ContextVar[str] = ContextVar("current_run_id", default="")


class ApprovalRejected(PermissionError):
    pass


class ApprovalTimeout(TimeoutError):
    pass


def match_danger(command: str, patterns: list[str]) -> str | None:
    for p in patterns:
        if re.search(p, command, re.IGNORECASE):
            return p
    return None


async def request_approval(run_id: str, command: str) -> int:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "INSERT INTO approvals (run_id, command) VALUES (%s,%s) RETURNING id",
            (run_id, command))
        return (await cur.fetchone())[0]


async def find_pending(run_id: str) -> dict | None:
    """run 的最新一条待审批项（id + command）；无则 None。api 与 viewer 共用。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, command FROM approvals"
            " WHERE run_id=%s AND status='pending' ORDER BY id DESC LIMIT 1",
            (run_id,))
        row = await cur.fetchone()
    return {"id": row[0], "command": row[1]} if row else None


async def decide(approval_id: int, approved: bool, decided_by: str = "") -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE approvals SET status=%s, decided_by=%s, decided_at=now()"
            " WHERE id=%s AND status='pending'",
            ("approved" if approved else "rejected", decided_by, approval_id))
    # 毫秒级唤醒等待中的 review hook；notify 丢失由轮询兜底
    try:
        await notify("approvals", str(approval_id))
    except Exception:  # noqa: BLE001
        pass


async def reject_pending(run_id: str, decided_by: str) -> None:
    """把某 run 所有挂起的审批标记为拒绝（服务重启清扫用）。

    续跑到同一危险命令时 hook 会重新发起审批，不会漏掉人工把关。
    """
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE approvals SET status='rejected', decided_by=%s, decided_at=now()"
            " WHERE run_id=%s AND status='pending'", (decided_by, run_id))


async def wait_decision(approval_id: int, timeout_s: int = 1800,
                        poll_s: float = 15.0) -> None:
    """LISTEN/NOTIFY 毫秒级唤醒 + 轮询兜底（notify 只是提示，DB 行才是事实源）。

    用独立连接 LISTEN：连接池绑定其创建 loop，review hook 可能跑在别的 loop。
    审批中断（进程重启）时 approvals 行仍在，重跑会重新发起审批，不会漏。
    """
    import psycopg

    deadline = time.monotonic() + timeout_s

    def _heartbeat() -> None:
        """Temporal activity 内等待审批时上报心跳（不在 activity 内则空操作）。"""
        try:
            from temporalio import activity
            activity.heartbeat("waiting-approval")
        except Exception:  # noqa: BLE001
            pass

    async def _fetch() -> str | None:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT status FROM approvals WHERE id=%s", (approval_id,))
            row = await cur.fetchone()
        return row[0] if row else None

    try:
        listener = await psycopg.AsyncConnection.connect(dsn(), autocommit=True)
    except Exception:  # noqa: BLE001 —— LISTEN 建连失败退化为纯轮询
        listener = None

    try:
        if listener is not None:
            await listener.execute("LISTEN approvals")
        while time.monotonic() < deadline:
            _heartbeat()
            decision = await _fetch()
            if decision == "approved":
                return
            if decision == "rejected":
                raise ApprovalRejected("审批被拒绝，命令未执行")
            if listener is None:
                await asyncio.sleep(poll_s)
                continue
            # 有 notify 立即重查；超时自然进入下一轮（等价轮询）
            try:
                async for _ in listener.notifies(timeout=poll_s, stop_after=1):
                    break
            except Exception:  # noqa: BLE001 —— listener 断了，退化为轮询
                listener = None
    finally:
        if listener is not None:
            try:
                await listener.close()
            except Exception:  # noqa: BLE001
                pass
    raise ApprovalTimeout(f"审批超时（{timeout_s}s），命令未执行")


def make_review_hook(patterns: list[str], send_notification) -> "callable":
    """生成工具层的审查回调（registry 的 review 参数）。run_id 从 contextvar 取。

    工具是同步执行的，审批等待跑在独立事件循环里，不阻塞主循环。
    """
    def review(text: str) -> None:
        if match_danger(text, patterns) is None:
            return
        run_id = current_run_id.get()

        async def _flow() -> None:
            approval_id = await request_approval(run_id, text)
            if send_notification is not None:
                await send_notification(run_id, text)  # 钉钉 actionCard → 审批页
            await wait_decision(approval_id)

        asyncio.run(_flow())

    return review
