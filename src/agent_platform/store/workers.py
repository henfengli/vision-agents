"""执行主机（workers 表）：每台 agent 服务的 worker 每 20 秒报一次到。

控制台据此显示哪台主机在负责哪个环境 / 哪些服务、在跑几个；排队太久的运行据此说清是不是根本没有主机在负责。
"""

from __future__ import annotations

from . import db

ONLINE_S = 90          # 报到间隔 20 秒：90 秒没动静就算离线


async def heartbeat(worker_id: str, *, host: str, env: str, services: list[str], version: str,
                    max_concurrent: int, running: int, remote_envs: list[str] | tuple[str, ...] = ()) -> None:
    async with db.pool().connection() as conn:
        await conn.execute(
            "INSERT INTO workers (worker_id, host, env, services, remote_envs, version, max_concurrent, running)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (worker_id) DO UPDATE SET seen_at=now(),"
            " running=EXCLUDED.running, env=EXCLUDED.env, services=EXCLUDED.services, remote_envs=EXCLUDED.remote_envs,"
            " version=EXCLUDED.version, max_concurrent=EXCLUDED.max_concurrent, stopped_at=NULL",
            (worker_id, host, env, list(services), list(remote_envs), version, max_concurrent, running))


async def stopped(worker_id: str) -> None:
    async with db.pool().connection() as conn:
        await conn.execute("UPDATE workers SET stopped_at=now(), running=0 WHERE worker_id=%s", (worker_id,))


async def list_workers() -> list[dict]:
    """最近 7 天报过到的；online = 90 秒内报过到且没正常退出。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT worker_id, host, env, services, version, max_concurrent, running, started_at, seen_at, stopped_at,"
            " (stopped_at IS NULL AND seen_at > now() - make_interval(secs => %s)) AS online, remote_envs"
            " FROM workers WHERE seen_at > now() - interval '7 days' ORDER BY online DESC, env, host", (ONLINE_S,))
        rows = await cur.fetchall()
    return [{"worker_id": r[0], "host": r[1], "env": r[2], "services": list(r[3] or []), "version": r[4],
             "max_concurrent": r[5], "running": r[6], "started_at": r[7].isoformat(), "seen_at": r[8].isoformat(),
             "stopped_at": r[9].isoformat() if r[9] else None, "online": r[10], "remote_envs": list(r[11] or [])}
            for r in rows]


def serving(workers: list[dict], env: str, service: str | None) -> list[dict]:
    """在线、负责这个环境（本机的或代管的）和服务的主机：env 为空的（开发机）什么都认领。"""
    return [w for w in workers if w["online"] and (not w["env"] or w["env"] == env or env in (w.get("remote_envs") or []))
            and (not service or not w["services"] or service in w["services"])]


async def purge(days: int = 7) -> int:
    async with db.pool().connection() as conn:
        cur = await conn.execute("DELETE FROM workers WHERE seen_at < now() - make_interval(days => %s)", (days,))
        return cur.rowcount or 0
