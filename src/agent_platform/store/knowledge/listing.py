"""记忆列表与健康度：控制台记忆页与 /v1/knowledge 的读口。

env 过滤 = 对该环境成立的条目：该环境自己的 + 所有环境通用的（env=''）。只看通用的传 env="*"。
交接摘要（kind=handoff）是会话内部用的，默认不在列表里。
"""

from __future__ import annotations

from ..db import pool

_STATUS_SQL = ("CASE WHEN k.expired THEN 'expired' WHEN k.valid_to IS NOT NULL THEN 'superseded' ELSE 'active' END")


def _where(env: str | None, service: str | None, task: str | None, status: str | None, q: str | None,
           kind: str | None = None, alias: str = "k") -> tuple[str, list]:
    conds, params = [], []
    if env == "*":
        conds.append(f"{alias}.env=''")
    elif env:
        conds.append(f"{alias}.env IN ('', %s)"); params.append(env)
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
    if kind:
        conds.append(f"{alias}.kind=%s"); params.append(kind)
    else:
        conds.append(f"{alias}.kind <> 'handoff'")
    return (" WHERE " + " AND ".join(conds)) if conds else "", params


async def list_entries(env: str | None = None, service: str | None = None, task: str | None = None,
                       status: str | None = None, q: str | None = None, kind: str | None = None,
                       limit: int = 300) -> list[dict]:
    """status：active（默认）/ expired / superseded / all；kind：fact / lesson / handoff（不给 = 事实与教训）。"""
    where, params = _where(env, service, task, status, q, kind)
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
            f" k.feedback_score, COALESCE(h.hits, 0), h.last_hit, k.created_at, k.kind, k.fingerprint, k.category,"
            f" k.superseded_by"
            f" FROM knowledge k LEFT JOIN ("
            f"   SELECT entry_id, count(*) AS hits, max(created_at) AS last_hit FROM recall_hits"
            f"   WHERE source='recall' AND created_at > now() - interval '30 days' GROUP BY entry_id"
            f" ) h ON h.entry_id = k.id{where} ORDER BY k.service, k.kind, k.key LIMIT %s", (*params, limit))
        rows = await cur.fetchall()
    return [{"id": r[0], "service": r[1], "env": r[2], "task": r[3], "key": r[4], "content": r[5], "source_run": r[6],
             "code_ref": r[7], "status": r[8], "feedback_score": r[9], "hits_30d": r[10],
             "last_hit_at": r[11].isoformat() if r[11] else None, "updated_at": r[12].isoformat(),
             "kind": r[13], "fingerprint": r[14], "category": r[15], "superseded_by": r[16]} for r in rows]


async def health(env: str | None = None, service: str | None = None) -> dict:
    conds, params = ["kind <> 'handoff'"], []
    if env:
        conds.append("env IN ('', %s)"); params.append(env)
    if service:
        conds.append("service=%s"); params.append(service)
    where = " WHERE " + " AND ".join(conds)
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT count(*) FILTER (WHERE NOT expired AND valid_to IS NULL),"
            f" count(*) FILTER (WHERE NOT expired AND valid_to IS NULL AND id NOT IN ("
            f"   SELECT entry_id FROM recall_hits WHERE source='recall' AND created_at > now() - interval '30 days')),"
            f" count(*) FILTER (WHERE feedback_score < 0 AND NOT expired AND valid_to IS NULL),"
            f" count(*) FILTER (WHERE expired),"
            f" count(*) FILTER (WHERE kind='lesson' AND NOT expired AND valid_to IS NULL),"
            f" count(*) FILTER (WHERE kind='fact' AND feedback_score >= 0 AND NOT expired AND valid_to IS NULL AND id IN ("
            f"   SELECT entry_id FROM recall_hits WHERE source='recall' AND created_at > now() - interval '30 days'"
            f"   GROUP BY entry_id HAVING count(DISTINCT run_id) >= 5))"
            f" FROM knowledge{where}", params)
        active, zero, negative, drifted, lessons, frequent = await cur.fetchone()
    from .crud import similar_pairs
    conflicts = len(await similar_pairs(env, service)) if env else 0
    return {"active": active, "zero_recall": zero, "negative": negative, "drifted": drifted, "conflicts": conflicts,
            "lessons": lessons, "promotable": frequent}


async def promotable(service: str | None = None, env: str | None = None, min_runs: int = 5, limit: int = 30) -> list[dict]:
    """值得升格进档案的记忆：近 30 天被 ≥ min_runs 次运行召回、没挨过 👎 的事实。"""
    where, params = _where(env, service, None, "active", None, "fact")
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT k.id FROM knowledge k JOIN ("
            "  SELECT entry_id, count(DISTINCT run_id) AS runs FROM recall_hits"
            "  WHERE source='recall' AND created_at > now() - interval '30 days' GROUP BY entry_id"
            f") h ON h.entry_id = k.id{where} AND h.runs >= %s AND k.feedback_score >= 0"
            " ORDER BY h.runs DESC LIMIT %s", (*params, min_runs, limit))
        ids = [r[0] for r in await cur.fetchall()]
    if not ids:
        return []
    rows = await _select(" WHERE k.id = ANY(%s)", [ids], limit)
    return sorted(rows, key=lambda r: -r["hits_30d"])
