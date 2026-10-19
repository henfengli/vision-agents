"""session 交接摘要（跨 episode 连续性）。

档案（逐字置顶的事实）不在知识库：服务档案住域定义、任务档案住任务
定义，由提交端固化进 RunSpec.profile（见 orchestration/submitter.py）。"""

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
