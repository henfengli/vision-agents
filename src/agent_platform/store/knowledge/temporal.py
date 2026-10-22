"""时序化：事实的软过期与取代（历史保留可审计）。"""

from __future__ import annotations

from ..db import pool


async def supersede_by_runs(run_ids: list[str], superseded_by: str) -> int:
    """把若干 run 沉淀的记忆（事实、教训、交接摘要）标记为被取代。返回条数。"""
    if not run_ids:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE knowledge SET valid_to=now(), superseded_by=%s"
            " WHERE source_run = ANY(%s) AND valid_to IS NULL",
            (superseded_by, run_ids))
        return cur.rowcount


async def supersede_keys(env: str, service: str, keys: list[str],
                         superseded_by: str) -> int:
    if not keys:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE knowledge SET valid_to=now(), superseded_by=%s"
            " WHERE env=%s AND service=%s AND key = ANY(%s) AND valid_to IS NULL",
            (superseded_by, env, service, keys))
        return cur.rowcount


async def mark_expired(entry_id: int) -> None:
    """code_ref 校验失败或人工作废：标记过期。"""
    async with pool().connection() as conn:
        await conn.execute("UPDATE knowledge SET expired=true WHERE id=%s",
                           (entry_id,))
