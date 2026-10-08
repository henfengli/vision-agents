"""时序化：事实的软过期与取代（历史保留可审计）。"""

from __future__ import annotations

from ..db import pool


async def supersede_by_runs(env: str, run_ids: list[str],
                            superseded_by: str) -> int:
    """把若干 run 沉淀的知识标记为被取代。返回条数。"""
    if not run_ids:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE knowledge SET valid_to=now(), superseded_by=%s "
            "WHERE env=%s AND source_run = ANY(%s) AND valid_to IS NULL",
            (superseded_by, env, run_ids))
        return cur.rowcount


async def supersede_keys(env: str, domain: str, keys: list[str],
                         superseded_by: str) -> int:
    if not keys:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE knowledge SET valid_to=now(), superseded_by=%s "
            "WHERE env=%s AND domain=%s AND key = ANY(%s) AND valid_to IS NULL",
            (superseded_by, env, domain, keys))
        return cur.rowcount


async def mark_expired(entry_id: int) -> None:
    """code_ref 校验失败：标记过期（commit 漂移，结论可能已失效）。"""
    async with pool().connection() as conn:
        await conn.execute("UPDATE knowledge SET expired=true WHERE id=%s", (entry_id,))
