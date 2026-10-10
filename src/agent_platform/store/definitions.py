"""版本化定义存储：角色与任务共用。

最新版本即生效版本（max(version)），历史全留可回滚；
读取走进程内短 TTL 缓存 + 写时主动失效——业务方自助加角色/任务，服务不重启。
"""

from __future__ import annotations

import json
import time
from typing import Literal

from .db import pool

Kind = Literal["role", "task", "policy"]

_CACHE_TTL_S = 5.0  # 缓存短 TTL + 写时主动失效，双保险


class DefinitionStore:
    """(kind, env, name) 维度的存取；写一次产生一个新版本。"""

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str, str], tuple[float, dict]] = {}

    async def put(self, kind: Kind, env: str, name: str, definition: dict,
                  updated_by: str = "") -> int:
        """写入新版本，返回版本号。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM definitions"
                " WHERE kind=%s AND env=%s AND name=%s", (kind, env, name))
            version = (await cur.fetchone())[0]
            await conn.execute(
                "INSERT INTO definitions (kind, env, name, version, definition, updated_by)"
                " VALUES (%s,%s,%s,%s,%s,%s)",
                (kind, env, name, version, json.dumps(definition), updated_by))
        self._cache.pop((kind, env, name), None)
        return version

    async def get_active(self, kind: Kind, env: str, name: str) -> dict | None:
        """生效版本 = 最新版本。"""
        key = (kind, env, name)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < _CACHE_TTL_S:
            return hit[1]
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition FROM definitions"
                " WHERE kind=%s AND env=%s AND name=%s"
                " ORDER BY version DESC LIMIT 1", (kind, env, name))
            row = await cur.fetchone()
        definition = _as_dict(row[0]) if row else None
        if definition is not None:
            self._cache[key] = (time.monotonic(), definition)
        return definition

    async def list_active_rows(self, kind: Kind, env: str) -> list[dict]:
        """管理台用：当前生效版本，结构化为 {name, version, definition}。
        与 list_active（铺平 definition、喂运行时校验模型）区分开。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT DISTINCT ON (name) name, version, definition"
                " FROM definitions WHERE kind=%s AND env=%s"
                " ORDER BY name, version DESC", (kind, env))
            rows = await cur.fetchall()
        return [{"name": n, "version": v, "definition": _as_dict(d)}
                for n, v, d in rows]

    async def list_active(self, kind: Kind, env: str) -> list[dict]:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT DISTINCT ON (name) name, definition FROM definitions"
                " WHERE kind=%s AND env=%s ORDER BY name, version DESC", (kind, env))
            rows = await cur.fetchall()
        return [{"name": name, **_as_dict(d)} for name, d in rows]

    async def history(self, kind: Kind, env: str, name: str) -> list[dict]:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT version, definition, updated_by, created_at FROM definitions"
                " WHERE kind=%s AND env=%s AND name=%s ORDER BY version DESC",
                (kind, env, name))
            rows = await cur.fetchall()
        return [{"version": v, "definition": _as_dict(d), "updated_by": u,
                 "created_at": t.isoformat()} for v, d, u, t in rows]

    async def rollback(self, kind: Kind, env: str, name: str, version: int) -> None:
        """回滚 = 把旧版本内容重新 put 为新版本（历史只增不改）。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition FROM definitions"
                " WHERE kind=%s AND env=%s AND name=%s AND version=%s",
                (kind, env, name, version))
            row = await cur.fetchone()
        if not row:
            raise KeyError(f"{kind}:{name} 不存在版本 {version}")
        await self.put(kind, env, name, _as_dict(row[0]),
                       updated_by=f"rollback-to-v{version}")

    # ---- Langfuse 降级缓存（提示词源头不可用时直读 PG） ----

    async def cache_get(self, kind: Kind, env: str, name: str) -> dict | None:
        return await self.get_active(kind, env, name)

    async def cache_put(self, kind: Kind, env: str, name: str,
                        definition: dict) -> None:
        """与当前生效版本一致则不动（幂等），否则写新版本。"""
        if await self.get_active(kind, env, name) == definition:
            return
        await self.put(kind, env, name, definition, updated_by="langfuse-sync")


def _as_dict(raw) -> dict:
    return json.loads(raw) if isinstance(raw, str) else raw


async def active_version(kind: Kind, env: str, name: str) -> int | None:
    """生效版本号（= 最新版本号）；定义不存在返回 None。

    run 谱系固定用：不走缓存、直读库，保证记录的就是执行那一刻的真实版本。
    """
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT MAX(version) FROM definitions"
            " WHERE kind=%s AND env=%s AND name=%s", (kind, env, name))
        row = await cur.fetchone()
    return row[0] if row and row[0] is not None else None
