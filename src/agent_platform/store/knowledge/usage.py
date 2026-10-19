"""召回埋点与使用统计：记忆运营的事实源。

写入方只有 recall_block（线上召回与页面检索试用两条路径，source 区分）；
埋点失败只告警不打断召回——统计永远不该拖垮主链路。
"""

from __future__ import annotations

import logging

from ..db import pool

log = logging.getLogger(__name__)


async def record_hits(env: str, domain: str, entries: list[dict],
                      run_id: str | None = None,
                      source: str = "recall") -> None:
    """按召回序记录命中（rank 从 1 开始）。entries 为过滤后的最终命中。"""
    if not entries:
        return
    try:
        async with pool().connection() as conn:
            await conn.execute(
                "INSERT INTO recall_hits (env, domain, entry_id, run_id, source,"
                " rank) SELECT %s,%s, t.id, %s, %s, t.r"
                " FROM unnest(%s::bigint[], %s::int[]) AS t(id, r)",
                (env, domain, run_id, source,
                 [e["id"] for e in entries],
                 list(range(1, len(entries) + 1))))
    except Exception as e:  # noqa: BLE001 —— 埋点失败不打断召回
        log.warning("召回埋点写入失败（不影响召回）：%s", e)


async def usage_map(env: str, days: int = 30) -> dict[int, dict]:
    """近 N 天每条目的使用统计：{entry_id: {hits, runs, last_hit}}。
    只算真实召回（playground 试用不算使用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT entry_id, COUNT(*), COUNT(DISTINCT run_id), MAX(created_at)"
            " FROM recall_hits"
            " WHERE env=%s AND source='recall'"
            " AND created_at > now() - (%s || ' days')::interval"
            " GROUP BY entry_id", (env, days))
        rows = await cur.fetchall()
    return {r[0]: {"hits": r[1], "runs": r[2],
                   "last_hit": r[3].isoformat() if r[3] else None}
            for r in rows}


async def recent_hits(entry_id: int, limit: int = 8) -> list[dict]:
    """单条目最近命中记录（抽屉用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, source, rank, created_at FROM recall_hits"
            " WHERE entry_id=%s ORDER BY created_at DESC LIMIT %s",
            (entry_id, limit))
        rows = await cur.fetchall()
    return [{"run_id": r[0], "source": r[1], "rank": r[2],
             "created_at": r[3].isoformat() if r[3] else None}
            for r in rows]


async def hits_for_run(run_id: str) -> list[dict]:
    """反查：某次 run 实际召回了哪些知识条目（run 详情「召回上下文」用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT k.id, k.domain, k.key, h.rank FROM recall_hits h"
            " JOIN knowledge k ON k.id = h.entry_id"
            " WHERE h.run_id=%s AND h.source='recall' ORDER BY h.rank",
            (run_id,))
        rows = await cur.fetchall()
    return [{"id": r[0], "domain": r[1], "key": r[2], "rank": r[3]}
            for r in rows]
