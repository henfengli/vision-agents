"""审批单存储：四类人工门共用（submit / command / artifact / process）。

DB 行是事实源；决定后 pg_notify('approvals', id) 毫秒唤醒等待方，轮询兜底。
决定是条件更新（status='pending' 才改），并发处理时只有一个人成功。
"""

from __future__ import annotations

import json
from datetime import datetime

from .db import notify, pool

_COLS = ("id, kind, run_id, title, detail, service, env, task, payload, requested_by, status, decided_by, comment,"
         " created_at, decided_at, expires_at")


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def _row(r) -> dict:
    return {"id": r[0], "kind": r[1], "run_id": r[2], "title": r[3], "detail": r[4], "service": r[5], "env": r[6],
            "task": r[7], "payload": r[8] or {}, "requested_by": r[9], "status": r[10], "decided_by": r[11],
            "comment": r[12], "created_at": r[13].isoformat(), "decided_at": _iso(r[14]), "expires_at": _iso(r[15])}


async def create(*, kind: str, title: str, detail: str = "", run_id: str | None = None, service: str | None = None,
                 env: str | None = None, task: str | None = None, payload: dict | None = None, requested_by: str = "",
                 timeout_s: int | None = None) -> dict:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"INSERT INTO approvals (kind, run_id, title, detail, service, env, task, payload, requested_by, expires_at)"
            f" VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, CASE WHEN %s::int IS NULL THEN NULL ELSE now() + make_interval(secs => %s::int) END)"
            f" RETURNING {_COLS}",
            (kind, run_id, title, detail, service, env, task, json.dumps(payload or {}, ensure_ascii=False), requested_by,
             timeout_s, timeout_s))
        return _row(await cur.fetchone())


async def get(approval_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM approvals WHERE id=%s", (approval_id,))
        row = await cur.fetchone()
    return _row(row) if row else None


async def pending_of_run(run_id: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_COLS} FROM approvals WHERE run_id=%s AND status='pending' ORDER BY id DESC LIMIT 1", (run_id,))
        row = await cur.fetchone()
    return _row(row) if row else None


async def listing(*, status: str | None = None, kind: str | None = None, service: str | None = None,
                  env: str | None = None, limit: int = 200) -> list[dict]:
    """status=pending：等得最久的在前（SLA）；decided：最近处理的在前；不给：最新的在前。"""
    conds, params = [], []
    if status == "pending":
        conds.append("status='pending'")
    elif status == "decided":
        conds.append("status<>'pending'")
    for col, val in (("kind", kind), ("service", service), ("env", env)):
        if val:
            conds.append(f"{col}=%s")
            params.append(val)
    order = {"pending": "created_at ASC", "decided": "decided_at DESC NULLS LAST"}.get(status or "", "created_at DESC")
    where = f" WHERE {' AND '.join(conds)}" if conds else ""
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM approvals{where} ORDER BY {order} LIMIT %s", (*params, limit))
        return [_row(r) for r in await cur.fetchall()]


async def decide(approval_id: int, approved: bool, by: str, comment: str = "") -> dict | None:
    """落决定；已被处理（或已过期）返回 None。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"UPDATE approvals SET status=%s, decided_by=%s, comment=%s, decided_at=now()"
            f" WHERE id=%s AND status='pending' RETURNING {_COLS}",
            ("approved" if approved else "rejected", by, comment or None, approval_id))
        row = await cur.fetchone()
    if row is None:
        return None
    try:
        await notify("approvals", str(approval_id))
    except Exception:  # noqa: BLE001 —— 等待方有轮询兜底
        pass
    return _row(row)


async def expire_overdue() -> list[dict]:
    """到期未处理的标 expired（视同拒绝），返回被过期的单子供收尾。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"UPDATE approvals SET status='expired', decided_by='timeout', decided_at=now()"
            f" WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < now() RETURNING {_COLS}")
        rows = [_row(r) for r in await cur.fetchall()]
    for r in rows:
        try:
            await notify("approvals", str(r["id"]))
        except Exception:  # noqa: BLE001
            pass
    return rows


async def reject_pending_of_run(run_id: str, by: str) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE approvals SET status='rejected', decided_by=%s, decided_at=now() WHERE run_id=%s AND status='pending'",
            (by, run_id))


async def status_of(approval_id: int) -> str | None:
    async with pool().connection() as conn:
        cur = await conn.execute("SELECT status FROM approvals WHERE id=%s", (approval_id,))
        row = await cur.fetchone()
    return row[0] if row else None


async def pending_count() -> int:
    async with pool().connection() as conn:
        cur = await conn.execute("SELECT count(*) FROM approvals WHERE status='pending'")
        return (await cur.fetchone())[0]
