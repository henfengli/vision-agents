"""版本化定义存储：服务 / 角色 / 任务 / 平台配置共用一张表。

- 最新版本即生效版本；每次写入都是新版本，历史只增不改
- 删除 = 写一个 deleted 版本（名字随即可复用）；恢复任一旧版本 = 把它的内容写成新版本
- 读走进程内 5 秒缓存 + 写时失效：多进程部署下最迟 5 秒对齐，改完不用重启
"""

from __future__ import annotations

import json
import time
from typing import Literal

import psycopg

from .db import pool

Kind = Literal["service", "role", "task", "config"]

_TTL_S = 5.0


def _as_dict(raw) -> dict:
    return json.loads(raw) if isinstance(raw, str) else raw


class DefinitionStore:
    def __init__(self) -> None:
        self._cache: dict[tuple[str, str | None], tuple[float, object]] = {}

    def _cached(self, key: tuple[str, str | None]):
        hit = self._cache.get(key)
        return hit[1] if hit and time.monotonic() - hit[0] < _TTL_S else None

    def _remember(self, key: tuple[str, str | None], value: object) -> None:
        self._cache[key] = (time.monotonic(), value)

    def _forget(self, kind: str, name: str) -> None:
        self._cache.pop((kind, name), None)
        self._cache.pop((kind, None), None)

    # —— 读 ——

    async def get(self, kind: Kind, name: str) -> dict | None:
        """生效版本：{name, version, definition, updated_by, updated_at}；不存在或已删除返回 None。"""
        hit = self._cached((kind, name))
        if hit is not None:
            return hit or None
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT version, definition, deleted, updated_by, created_at FROM definitions"
                " WHERE kind=%s AND name=%s ORDER BY version DESC LIMIT 1", (kind, name))
            row = await cur.fetchone()
        item = None
        if row and not row[2]:
            item = {"name": name, "version": row[0], "definition": _as_dict(row[1]),
                    "updated_by": row[3], "updated_at": row[4].isoformat()}
        self._remember((kind, name), item or {})
        return item

    async def list(self, kind: Kind) -> list[dict]:
        """全部生效定义，按名字排序。"""
        hit = self._cached((kind, None))
        if hit is not None:
            return hit  # type: ignore[return-value]
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT * FROM (SELECT DISTINCT ON (name) name, version, definition, deleted, updated_by, created_at"
                " FROM definitions WHERE kind=%s ORDER BY name, version DESC) t WHERE NOT deleted ORDER BY name", (kind,))
            rows = await cur.fetchall()
        items = [{"name": n, "version": v, "definition": _as_dict(d), "updated_by": u, "updated_at": t.isoformat()}
                 for n, v, d, _, u, t in rows]
        self._remember((kind, None), items)
        return items

    async def history(self, kind: Kind, name: str) -> list[dict]:
        """全部版本，新的在前：[{version, definition, deleted, updated_by, created_at}]。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT version, definition, deleted, updated_by, created_at FROM definitions"
                " WHERE kind=%s AND name=%s ORDER BY version DESC", (kind, name))
            rows = await cur.fetchall()
        return [{"version": v, "definition": _as_dict(d), "deleted": x, "updated_by": u, "created_at": t.isoformat()}
                for v, d, x, u, t in rows]

    async def version(self, kind: Kind, name: str, version: int) -> dict | None:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition FROM definitions WHERE kind=%s AND name=%s AND version=%s", (kind, name, version))
            row = await cur.fetchone()
        return _as_dict(row[0]) if row else None

    # —— 写 ——

    async def put(self, kind: Kind, name: str, definition: dict, by: str, *, deleted: bool = False) -> int:
        """写新版本，返回版本号。并发写撞主键时重取一次版本号。"""
        for attempt in (1, 2):
            try:
                async with pool().connection() as conn:
                    cur = await conn.execute(
                        "INSERT INTO definitions (kind, name, version, definition, deleted, updated_by)"
                        " SELECT %s, %s, COALESCE(MAX(version), 0) + 1, %s, %s, %s FROM definitions"
                        " WHERE kind=%s AND name=%s RETURNING version",
                        (kind, name, json.dumps(definition, ensure_ascii=False), deleted, by, kind, name))
                    version = (await cur.fetchone())[0]
                break
            except psycopg.errors.UniqueViolation:
                if attempt == 2:
                    raise
        self._forget(kind, name)
        return version

    async def delete(self, kind: Kind, name: str, by: str) -> int:
        current = await self.get(kind, name)
        return await self.put(kind, name, current["definition"] if current else {}, by, deleted=True)

    async def seeded_version(self, kind: Kind, name: str) -> dict | None:
        """这个名字是否出现过（含已删除）。播种只在从未出现过的名字上进行——删掉的种子不会复活。
        出现过则返回 {"seed": 当初播种的内容或 None}；从未出现返回 None。"""
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT definition, updated_by FROM definitions WHERE kind=%s AND name=%s ORDER BY version", (kind, name))
            rows = await cur.fetchall()
        if not rows:
            return None
        return {"seed": next((_as_dict(d) for d, u in rows if u == "seed"), None)}
