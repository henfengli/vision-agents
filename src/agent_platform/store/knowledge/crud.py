"""知识库 CRUD：写入、读取、网页编辑。

时序语义：upsert 同 key 整替换并刷新有效期；被取代（valid_to 非空）
与过期（expired）的条目不出现在检索结果中，但保留可审计。
"""

from __future__ import annotations

import json

from ..db import pool


async def upsert(env: str, domain: str, key: str, content: str,
                 source_run: str | None = None, code_ref: dict | None = None,
                 embedder=None) -> None:
    """幂等 upsert（同 key 整替换）；embedder 存在时同步写入向量。"""
    vec = None
    if embedder is not None:
        vecs = await embedder([f"{key} {content}"])
        if vecs:
            vec = "[%s]" % ",".join(f"{x:.6f}" for x in vecs[0])
    sql = ("INSERT INTO knowledge (env, domain, key, content, source_run, code_ref{vec_col})"
           " VALUES (%s,%s,%s,%s,%s,%s{vec_val})"
           " ON CONFLICT (env, domain, key) DO UPDATE SET"
           " content=EXCLUDED.content, source_run=EXCLUDED.source_run,"
           " code_ref=EXCLUDED.code_ref,"
           " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
           " expired=false, created_at=now(){vec_upd}")
    params = [env, domain, key, content, source_run,
              json.dumps(code_ref) if code_ref else None]
    if vec is not None:
        try:
            # 独立连接：失败后 PG 事务中止，不能在同一连接上继续
            async with pool().connection() as conn:
                await conn.execute(
                    sql.format(vec_col=", embedding", vec_val=",%s::vector",
                               vec_upd=", embedding=EXCLUDED.embedding"),
                    (*params, vec))
            return
        except Exception:  # noqa: BLE001 —— 无 pgvector 时退化为纯文本写
            pass
    async with pool().connection() as conn:
        await conn.execute(sql.format(vec_col="", vec_val="", vec_upd=""),
                           tuple(params))


async def get_entry(entry_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, env, domain, key, content, expired, valid_to"
            " FROM knowledge WHERE id=%s", (entry_id,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "env": row[1], "domain": row[2], "key": row[3],
            "content": row[4], "expired": row[5],
            "valid_to": row[6].isoformat() if row[6] else None}


async def update_content(entry_id: int, content: str) -> None:
    """网页编辑：改内容并刷新有效期（视为人工纠正，重新生效）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE knowledge SET content=%s, valid_from=now(), valid_to=NULL,"
            " expired=false, created_at=now() WHERE id=%s", (content, entry_id))


async def list_by_domain(env: str, domain: str) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, key, content, expired FROM knowledge"
            " WHERE env=%s AND domain=%s ORDER BY key", (env, domain))
        rows = await cur.fetchall()
    return [{"id": i, "key": k, "content": c, "expired": e} for i, k, c, e in rows]


async def list_all(env: str, domain: str | None = None,
                   include_inactive: bool = False) -> list[dict]:
    """管理页用：全量列出（可选含已过期/被取代）。"""
    where = "WHERE env=%s"
    params: list = [env]
    if domain:
        where += " AND domain=%s"
        params.append(domain)
    if not include_inactive:
        where += " AND expired=false AND valid_to IS NULL"
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, domain, key, content, expired, valid_to IS NOT NULL,"
            " feedback_score, created_at FROM knowledge " + where +
            " ORDER BY domain, key LIMIT 500", tuple(params))
        rows = await cur.fetchall()
    return [{"id": r[0], "domain": r[1], "key": r[2], "content": r[3],
             "expired": r[4], "superseded": r[5], "feedback_score": r[6],
             "created_at": r[7].isoformat()} for r in rows]
