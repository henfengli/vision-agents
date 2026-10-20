"""知识列表与健康度：控制台记忆页与 /v1/knowledge 的读口（跨环境可选）。"""

from __future__ import annotations

from ..db import pool

_STATUS_SQL = ("CASE WHEN k.expired THEN 'expired' WHEN k.valid_to IS NOT NULL THEN 'superseded' ELSE 'active' END")


def _where(env: str | None, service: str | None, task: str | None, status: str | None, q: str | None,
           alias: str = "k") -> tuple[str, list]:
    conds, params = [], []
    if env:
        conds.append(f"{alias}.env=%s"); params.append(env)
    if service:
        conds.append(f"{alias}.service=%s"); params.append(service)
    if task:   # 任务及其子任务沉淀的
        conds.append(f"({alias}.task=%s OR {alias}.task LIKE %s)"); params += [task, task + ":%"]
    if status == "all":
        pass
    elif status == "active" or status is None:
        conds.append(f"NOT {alias}.expired AND {alias}.valid_to IS NULL")
    elif status == "expired":
        conds.append(f"{alias}.expired")
    elif status == "superseded":
        conds.append(f"{alias}.valid_to IS NOT NULL")
    if q:
        conds.append(f"({alias}.key ILIKE %s OR {alias}.content ILIKE %s)"); params += [f"%{q}%", f"%{q}%"]
    # 交接摘要是会话内部用的，不在列表里展示
    conds.append(f"{alias}.key NOT LIKE 'session:%%'")
    return (" WHERE " + " AND ".join(conds)) if conds else "", params


async def list_entries(env: str | None = None, service: str | None = None, task: str | None = None,
                       status: str | None = None, q: str | None = None, limit: int = 300) -> list[dict]:
    """status：active（默认）/ expired / superseded / all。"""
    where, params = _where(env, service, task, status, q)
    return await _select(where, params, limit)


async def entry(entry_id: int) -> dict | None:
    rows = await _select(" WHERE k.id=%s", [entry_id], 1)
    return rows[0] if rows else None


async def find(env: str, service: str, key: str) -> dict | None:
    rows = await _select(" WHERE k.env=%s AND k.service=%s AND k.key=%s", [env, service, key], 1)
    return rows[0] if rows else None


async def _select(where: str, params: list, limit: int) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT k.id, k.service, k.env, k.task, k.key, k.content, k.source_run, k.code_ref, {_STATUS_SQL},"
            f" k.feedback_score, COALESCE(h.hits, 0), h.last_hit, k.created_at"
            f" FROM knowledge k LEFT JOIN ("
            f"   SELECT entry_id, count(*) AS hits, max(created_at) AS last_hit FROM recall_hits"
            f"   WHERE source='recall' AND created_at > now() - interval '30 days' GROUP BY entry_id"
            f" ) h ON h.entry_id = k.id{where} ORDER BY k.service, k.key LIMIT %s", (*params, limit))
        rows = await cur.fetchall()
    return [{"id": r[0], "service": r[1], "env": r[2], "task": r[3], "key": r[4], "content": r[5], "source_run": r[6],
             "code_ref": r[7], "status": r[8], "feedback_score": r[9], "hits_30d": r[10],
             "last_hit_at": r[11].isoformat() if r[11] else None, "updated_at": r[12].isoformat()} for r in rows]


async def health(env: str | None = None, service: str | None = None) -> dict:
    conds, params = ["key NOT LIKE 'session:%%'"], []
    if env:
        conds.append("env=%s"); params.append(env)
    if service:
        conds.append("service=%s"); params.append(service)
    where = " WHERE " + " AND ".join(conds)
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT count(*) FILTER (WHERE NOT expired AND valid_to IS NULL),"
            f" count(*) FILTER (WHERE NOT expired AND valid_to IS NULL AND id NOT IN ("
            f"   SELECT entry_id FROM recall_hits WHERE source='recall' AND created_at > now() - interval '30 days')),"
            f" count(*) FILTER (WHERE feedback_score < 0 AND NOT expired AND valid_to IS NULL),"
            f" count(*) FILTER (WHERE expired)"
            f" FROM knowledge{where}", params)
        active, zero, negative, drifted = await cur.fetchone()
    from .crud import similar_pairs
    conflicts = len(await similar_pairs(env, service)) if env else 0
    return {"active": active, "zero_recall": zero, "negative": negative, "drifted": drifted, "conflicts": conflicts}
