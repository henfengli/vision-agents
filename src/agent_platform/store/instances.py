"""服务进程实例状态：(服务, 环境, 进程) 一行。ProcessController 是唯一写入方。"""

from __future__ import annotations

from datetime import datetime

from .db import pool

_COLS = "service, env, process, state, port, pid, started_at, lease_until, started_by, last_exit_code, last_exit_at"


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def _row(r) -> dict:
    return {"service": r[0], "env": r[1], "process": r[2], "state": r[3], "port": r[4], "pid": r[5],
            "started_at": _iso(r[6]), "lease_until": _iso(r[7]), "started_by": r[8],
            "last_exit": {"code": r[9], "at": _iso(r[10])} if r[10] else None}


async def of_service(service: str) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM service_instances WHERE service=%s", (service,))
        return [_row(r) for r in await cur.fetchall()]


async def get(service: str, env: str, process: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM service_instances WHERE service=%s AND env=%s AND process=%s",
                                 (service, env, process))
        row = await cur.fetchone()
    return _row(row) if row else None


async def mark_started(service: str, env: str, process: str, *, port: int | None, pid: int | None,
                       lease_hours: float, by: str) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO service_instances (service, env, process, state, port, pid, started_at, lease_until, started_by, updated_at)"
            " VALUES (%s,%s,%s,'running',%s,%s,now(), now() + make_interval(secs => %s), %s, now())"
            " ON CONFLICT (service, env, process) DO UPDATE SET state='running', port=EXCLUDED.port, pid=EXCLUDED.pid,"
            " started_at=now(), lease_until=EXCLUDED.lease_until, started_by=EXCLUDED.started_by, updated_at=now()",
            (service, env, process, port, pid, int(lease_hours * 3600), by))


async def mark_stopped(service: str, env: str, process: str, *, exit_code: int | None, failed: bool = False) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO service_instances (service, env, process, state, last_exit_code, last_exit_at, updated_at)"
            " VALUES (%s,%s,%s,%s,%s,now(),now())"
            " ON CONFLICT (service, env, process) DO UPDATE SET state=EXCLUDED.state, pid=NULL, lease_until=NULL,"
            " started_at=NULL, last_exit_code=EXCLUDED.last_exit_code, last_exit_at=now(), updated_at=now()",
            (service, env, process, "failed" if failed else "stopped", exit_code))


async def renew(service: str, env: str, process: str, hours: float, cap_hours: float) -> str | None:
    """续期（从当前到期时间往后加，总租约不超过 cap），返回新的到期时间。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE service_instances SET lease_until=LEAST(COALESCE(lease_until, now()) + make_interval(secs => %s),"
            " now() + make_interval(secs => %s)), updated_at=now()"
            " WHERE service=%s AND env=%s AND process=%s AND state='running' RETURNING lease_until",
            (int(hours * 3600), int(cap_hours * 3600), service, env, process))
        row = await cur.fetchone()
    return _iso(row[0]) if row else None


async def expired_leases() -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_COLS} FROM service_instances WHERE state='running' AND lease_until < now()")
        return [_row(r) for r in await cur.fetchall()]


async def running() -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM service_instances WHERE state='running'")
        return [_row(r) for r in await cur.fetchall()]


async def counts() -> dict[tuple[str, str], int]:
    """(服务, 环境) → 运行中的进程数。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT service, env, count(*) FROM service_instances WHERE state='running' GROUP BY 1, 2")
        return {(s, e): n for s, e, n in await cur.fetchall()}
