"""版本化定义存储：角色与任务共用。

写入即产生新版本并置为 active（旧版本置非 active，历史全留可回滚）；
读取走进程内缓存，写入后即时失效——业务方自助加角色/任务，服务不重启。
"""

from __future__ import annotations

import json
import time
from typing import Literal

from .db import pool

Kind = Literal["role", "task"]

_CACHE_TTL_S = 5.0  # 缓存短 TTL + 写时主动失效，双保险


class DefinitionStore:
    """(kind, env, name) 维度的高并发友好存取。"""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str, str], tuple[float, dict]] = {}

    async def put(self, kind: Kind, env: str, name: str, definition: dict,
                  updated_by: str = "") -> int:
        """写入新版本，返回版本号。"""
        async with pool().connection() as conn, conn.transaction():
                cur = await conn.execute(
                    "SELECT COALESCE(MAX(version), 0) + 1 FROM definitions "
                    "WHERE kind=%s AND env=%s AND name=%s",
                    (kind, env, name),
                )
                version = (await cur.fetchone())[0]
                await conn.execute(
                    "UPDATE definitions SET active=false "
                    "WHERE kind=%s AND env=%s AND name=%s",
                    (kind, env, name),
                )
                await conn.execute(
                    "INSERT INTO definitions (kind, env, name, version, definition, active, updated_by) "
                    "VALUES (%s, %s, %s, %s, %s, true, %s)",
                    (kind, env, name, version, json.dumps(definition), updated_by),
                )
        self._cache.pop((kind, env, name), None)
        return version

    async def get_active(self, kind: Kind, env: str, name: str) -> dict | None:
        key = (kind, env, name)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL_S:
            return hit[1]
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition FROM definitions "
                "WHERE kind=%s AND env=%s AND name=%s AND active=true",
                (kind, env, name),
            )
            row = await cur.fetchone()
        definition = json.loads(row[0]) if isinstance(row[0], str) else row[0] if row else None
        if definition is not None:
            self._cache[key] = (time.monotonic(), definition)
        return definition

    async def list_active(self, kind: Kind, env: str) -> list[dict]:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT name, definition FROM definitions "
                "WHERE kind=%s AND env=%s AND active=true ORDER BY name",
                (kind, env),
            )
            rows = await cur.fetchall()
        return [
            {"name": name, **(json.loads(d) if isinstance(d, str) else d)}
            for name, d in rows
        ]

    async def history(self, kind: Kind, env: str, name: str) -> list[dict]:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT version, definition, active, updated_by, updated_at FROM definitions "
                "WHERE kind=%s AND env=%s AND name=%s ORDER BY version DESC",
                (kind, env, name),
            )
            rows = await cur.fetchall()
        return [
            {"version": v, "definition": json.loads(d) if isinstance(d, str) else d,
             "active": a, "updated_by": u, "updated_at": t.isoformat()}
            for v, d, a, u, t in rows
        ]

    async def rollback(self, kind: Kind, env: str, name: str, version: int) -> None:
        """回滚到指定版本：本质是把它重新 put 为新版本。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition FROM definitions "
                "WHERE kind=%s AND env=%s AND name=%s AND version=%s",
                (kind, env, name, version),
            )
            row = await cur.fetchone()
        if not row:
            raise KeyError(f"{kind}:{name} 不存在版本 {version}")
        d = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        await self.put(kind, env, name, d, updated_by=f"rollback-to-v{version}")


    async def cache_get(self, kind: Kind, env: str, name: str) -> dict | None:
        """读持久缓存（Langfuse 降级路径）。语义同 get_active。"""
        return await self.get_active(kind, env, name)

    async def cache_put(self, kind: Kind, env: str, name: str,
                        definition: dict) -> None:
        """写穿缓存：与当前 active 内容一致则不动（幂等），否则新版本。"""
        current = await self.get_active(kind, env, name)
        if current == definition:
            return
        await self.put(kind, env, name, definition, updated_by="langfuse-sync")
