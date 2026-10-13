"""任务资产：run 产出的可复用方法（procedure）/脚本/查询/基线。

定位：知识记事实、案例记教训、资产记方法。生命周期与知识库同款
（upsert 幂等、软过期、取代留痕、反馈分），复用统计直接记行上
（use_count/last_used_at——资产的「被用」就是 prepare 注入那一刻，
粒度足够，不再单建埋点表）。
"""

from __future__ import annotations

from .db import pool

# recall 注入时的 kind 优先级：方法优先，基线次之，工具产物再次
_KIND_ORDER = {"procedure": 0, "baseline": 1, "query": 2, "script": 3}


async def upsert(env: str, domain: str, task: str, kind: str, name: str,
                 summary: str, content: str,
                 source_run: str | None = None) -> None:
    """幂等 upsert（同 (domain, task, kind, name) 整替换并刷新有效期）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO assets (env, domain, task, kind, name, summary,"
            " content, source_run) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (env, domain, task, kind, name) DO UPDATE SET"
            " summary=EXCLUDED.summary, content=EXCLUDED.content,"
            " source_run=EXCLUDED.source_run,"
            " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
            " created_at=now()",
            (env, domain, task, kind, name, summary, content, source_run))


async def search_active(env: str, domain: str, task: str,
                        limit: int = 8) -> list[dict]:
    """prepare 注入用：任务级资产优先，其次域级通用；同类内按复用数/反馈排。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, task, kind, name, summary, content, use_count,"
            " feedback_score, source_run FROM assets"
            " WHERE env=%s AND domain=%s AND task IN (%s, '')"
            " AND valid_to IS NULL"
            " ORDER BY CASE WHEN task=%s THEN 0 ELSE 1 END, use_count DESC,"
            " COALESCE(feedback_score,0) DESC, created_at DESC LIMIT %s",
            (env, domain, task, task, limit * 2))
        rows = await cur.fetchall()
    rows = sorted(rows, key=lambda r: (
        0 if r[1] == task else 1, _KIND_ORDER.get(r[2], 9)))[:limit]
    return [_row(r) for r in rows]


async def mark_used(ids: list[int]) -> None:
    """prepare 注入即记一次复用。"""
    if not ids:
        return
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET use_count=use_count+1, last_used_at=now()"
            " WHERE id = ANY(%s)", (ids,))


async def list_all(env: str, domain: str | None = None,
                   include_inactive: bool = True) -> list[dict]:
    where = "WHERE env=%s"
    params: list = [env]
    if domain:
        where += " AND domain=%s"
        params.append(domain)
    if not include_inactive:
        where += " AND valid_to IS NULL"
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, domain, task, kind, name, summary, use_count,"
            " last_used_at, feedback_score, valid_to IS NOT NULL,"
            " superseded_by, source_run, created_at FROM assets " + where +
            " ORDER BY kind, task, name LIMIT 500", tuple(params))
        rows = await cur.fetchall()
    return [{**_row_meta(r)} for r in rows]


async def kind_stats(env: str) -> dict[str, int]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT kind, COUNT(*) FROM assets WHERE env=%s"
            " AND valid_to IS NULL GROUP BY kind ORDER BY kind", (env,))
        rows = await cur.fetchall()
    return {k: n for k, n in rows}


async def get_entry(asset_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, env, domain, task, kind, name, summary, content,"
            " use_count, last_used_at, feedback_score, valid_to, source_run,"
            " created_at FROM assets WHERE id=%s", (asset_id,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "env": row[1], "domain": row[2], "task": row[3],
            "kind": row[4], "name": row[5], "summary": row[6],
            "content": row[7], "use_count": row[8],
            "last_used_at": row[9].isoformat() if row[9] else None,
            "feedback_score": row[10],
            "valid_to": row[11].isoformat() if row[11] else None,
            "source_run": row[12],
            "created_at": row[13].isoformat() if row[13] else None}


async def update(asset_id: int, summary: str, content: str) -> None:
    """网页编辑：改摘要/内容并刷新有效期（视为人工修正，重新生效）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET summary=%s, content=%s, valid_from=now(),"
            " valid_to=NULL, superseded_by=NULL, created_at=now() WHERE id=%s",
            (summary, content, asset_id))


async def mark_expired(asset_id: int) -> None:
    async with pool().connection() as conn:
        await conn.execute("UPDATE assets SET valid_to=now() WHERE id=%s",
                           (asset_id,))


async def restore(asset_id: int) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET valid_to=NULL, superseded_by=NULL,"
            " valid_from=now() WHERE id=%s", (asset_id,))


def _row(r) -> dict:
    return {"id": r[0], "task": r[1], "kind": r[2], "name": r[3],
            "summary": r[4], "content": r[5], "use_count": r[6],
            "feedback_score": r[7], "source_run": r[8]}


def _row_meta(r) -> dict:
    return {"id": r[0], "domain": r[1], "task": r[2], "kind": r[3],
            "name": r[4], "summary": r[5], "use_count": r[6],
            "last_used_at": r[7].isoformat() if r[7] else None,
            "feedback_score": r[8], "expired": r[9],
            "superseded_by": r[10], "source_run": r[11],
            "created_at": r[12].isoformat() if r[12] else None}
