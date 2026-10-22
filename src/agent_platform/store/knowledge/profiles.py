"""会话交接摘要（kind=handoff，跨 episode 连续性）。

档案（人写的、逐字置顶的事实）不在这里：服务档案在服务定义、任务档案在任务定义。"""

from __future__ import annotations

from ..db import pool


async def latest_session_summaries(env: str, service: str, continuity_prefix: str,
                                   limit: int = 2) -> list[dict]:
    """前序 episode 的交接摘要：key 形如 session:{prefix}:{episode}:summary。
    同服务同环境、按生效时间倒序取最近 limit 条，供召回置顶。"""
    prefix = continuity_prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT key, content FROM knowledge"
            " WHERE kind='handoff' AND env=%s AND service=%s AND key LIKE %s"
            " AND expired=false AND valid_to IS NULL ORDER BY valid_from DESC LIMIT %s",
            (env, service, f"session:{prefix}:%:summary", limit))
        rows = await cur.fetchall()
    return [{"key": k, "content": c} for k, c in rows]
