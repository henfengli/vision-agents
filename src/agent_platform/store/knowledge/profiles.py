"""档案与摘要：资产 profile（逐字保留）+ session 交接摘要（跨 episode 连续性）。"""

from __future__ import annotations

from ..db import pool


async def latest_session_summaries(env: str, continuity_prefix: str,
                                   limit: int = 2) -> list[dict]:
    """前序 episode 的交接摘要：key 形如 session:{prefix}:{episode}:summary。
    按生效时间倒序取最近 limit 条，供召回置顶。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT key, content FROM knowledge"
            " WHERE env=%s AND key LIKE %s AND expired=false AND valid_to IS NULL"
            " ORDER BY valid_from DESC LIMIT %s",
            (env, f"session:{continuity_prefix}:%:summary", limit))
        rows = await cur.fetchall()
    return [{"key": k, "content": c} for k, c in rows]


async def asset_profiles(env: str, domain: str, query: str) -> list[dict]:
    """资产档案（key 形如 asset:{asset_key}:profile）：query 中提到的资产
    逐字返回——profile 永不摘要，作为召回块固定头部。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT key, content FROM knowledge"
            " WHERE env=%s AND domain=%s AND key LIKE 'asset:%%:profile'"
            " AND expired=false AND valid_to IS NULL", (env, domain))
        rows = await cur.fetchall()
    return [{"key": k, "content": c} for k, c in rows
            if k.split(":")[1] in query]
