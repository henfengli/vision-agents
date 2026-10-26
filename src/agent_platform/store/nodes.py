"""节点：每台主机上的平台进程（部署配置 node）。worker 每分钟写一次心跳和本机状态。

在线 = 心跳在 ONLINE_S 内。提交端用它判断"服务×环境部署的那个节点在不在"，控制台用它显示代码目录、git、
解释器这些只有那台主机上才看得到的东西（接口可能由别的节点回答）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from .db import pool

ONLINE_S = 180


def _row(r) -> dict:
    beat = r[4]
    return {"name": r[0], "host": r[1], "version": r[2], "started_at": r[3].isoformat() if r[3] else None,
            "heartbeat_at": beat.isoformat(), "online": (datetime.now(timezone.utc) - beat).total_seconds() < ONLINE_S,
            "info": r[5] or {}}


_COLS = "name, host, version, started_at, heartbeat_at, info"


async def beat(name: str, *, host: str, version: str, started_at: datetime, info: dict) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO nodes (name, host, version, started_at, heartbeat_at, info) VALUES (%s,%s,%s,%s,now(),%s)"
            " ON CONFLICT (name) DO UPDATE SET host=EXCLUDED.host, version=EXCLUDED.version,"
            " started_at=EXCLUDED.started_at, heartbeat_at=now(), info=EXCLUDED.info",
            (name, host, version, started_at, json.dumps(info, ensure_ascii=False, default=str)))


async def get(name: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM nodes WHERE name=%s", (name,))
        r = await cur.fetchone()
    return _row(r) if r else None


async def list_all() -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM nodes ORDER BY name")
        return [_row(r) for r in await cur.fetchall()]


async def remove(name: str) -> bool:
    async with pool().connection() as conn:
        cur = await conn.execute("DELETE FROM nodes WHERE name=%s", (name,))
        return cur.rowcount > 0
