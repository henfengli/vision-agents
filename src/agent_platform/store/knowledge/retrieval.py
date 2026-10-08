"""知识检索：pg_trgm + pgvector 混合召回，RRF 融合；code_ref 新鲜度校验。"""

from __future__ import annotations

import json
import subprocess

from ..db import pool


def current_commit(code_path: str) -> str | None:
    """业务代码目录当前 commit；非 git 仓库返回 None（跳过校验，不退化）。"""
    try:
        out = subprocess.run(
            ["git", "-C", code_path, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def is_entry_fresh(code_ref: dict | None, domain_code_paths: list[str]) -> bool:
    """校验知识条目的 code_ref 是否与当前代码一致。无 code_ref 视为始终新鲜。"""
    if not code_ref or not code_ref.get("path"):
        return True
    recorded = code_ref.get("commit")
    if not recorded:
        return True
    for base in domain_code_paths:
        if str(code_ref["path"]).startswith(base):
            head = current_commit(base)
            # 非 git 仓库（head 为 None）无法校验，按新鲜处理——不退化
            return head is None or head == recorded
    return True


async def search(env: str, domain: str, query: str, limit: int = 5,
                 embedder=None) -> list[dict]:
    """混合召回：pg_trgm 关键词 + pgvector 语义，RRF 融合。

    - 未配置嵌入模型 / pgvector 缺失 / 向量无结果 → 退化 trgm（再退 ILIKE）
    - 过期（expired）与被取代（valid_to 非空）的条目不召回
    RRF: score = Σ 1/(k+rank)，k=60——只认排名不认分数，对尺度差异鲁棒。
    """
    terms = [t for t in query.replace("？", " ").split() if len(t) >= 2][:5]
    vec_rows = []
    if embedder is not None:
        vecs = await embedder([query])
        if vecs:
            vec_rows = await _search_vector(env, domain, vecs[0], limit * 2)
    if terms:
        trgm_rows = await _search_trgm(env, domain, terms, limit * 2)
        if trgm_rows is None:
            trgm_rows = await _search_ilike(env, domain, terms, limit * 2)
    else:
        trgm_rows = []
    if not vec_rows:
        rows = trgm_rows[:limit]
    elif not trgm_rows:
        rows = vec_rows[:limit]
    else:
        rows = _rrf_merge(trgm_rows, vec_rows, limit)
    return [
        {"id": i, "key": k, "content": c,
         "code_ref": json.loads(r) if isinstance(r, str) else r, "source_run": s}
        for i, k, c, r, s, *_ in rows  # 查询多带的分数字段，丢弃
    ]


def _rrf_merge(trgm_rows, vec_rows, limit, k: int = 60):
    scores: dict = {}
    by_id: dict = {}
    for rank, row in enumerate(trgm_rows):
        scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (k + rank + 1)
        by_id[row[0]] = row
    for rank, row in enumerate(vec_rows):
        scores[row[0]] = scores.get(row[0], 0.0) + 1.0 / (k + rank + 1)
        by_id.setdefault(row[0], row)
    top = sorted(scores, key=lambda i: scores[i], reverse=True)[:limit]
    return [by_id[i] for i in top]


async def _search_vector(env, domain, vec: list[float], limit):
    lit = "[%s]" % ",".join(f"{x:.6f}" for x in vec)
    try:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT id, key, content, code_ref, source_run,"
                " 1 - (embedding <=> %s::vector) AS sim FROM knowledge"
                " WHERE env=%s AND domain=%s AND expired=false AND valid_to IS NULL"
                " AND embedding IS NOT NULL"
                " ORDER BY embedding <=> %s::vector LIMIT %s",
                (lit, env, domain, lit, limit))
            return await cur.fetchall()
    except Exception:  # noqa: BLE001 —— pgvector 缺失时退化
        return []


async def _search_trgm(env, domain, terms, limit):
    """word_similarity(term, 文本)：查询词片段在长文本中的最佳匹配度。
    返回 None 表示 pg_trgm 不可用，调用方退化 ILIKE。"""
    sim_expr = "GREATEST(" + ", ".join(
        ["word_similarity(%s, key || ' ' || content)"] * len(terms)) + ")"
    like_expr = " OR ".join(["key ILIKE %s OR content ILIKE %s"] * len(terms))
    sql = (f"SELECT id, key, content, code_ref, source_run, {sim_expr} AS sim"
           f" FROM knowledge"
           f" WHERE env=%s AND domain=%s AND expired=false AND valid_to IS NULL"
           f" AND ({sim_expr} > 0.08 OR {like_expr})"
           f" ORDER BY sim DESC, feedback_score DESC, created_at DESC LIMIT %s")
    params = (list(terms)
              + [env, domain]
              + list(terms)
              + [x for t in terms for x in (f"%{t}%", f"%{t}%")]
              + [limit])
    try:
        async with pool().connection() as conn:
            cur = await conn.execute(sql, tuple(params))
            return await cur.fetchall()
    except Exception:  # noqa: BLE001 —— pg_trgm 不存在/权限不足
        return None


async def _search_ilike(env, domain, terms, limit):
    where = " OR ".join(["key ILIKE %s OR content ILIKE %s"] * len(terms))
    params: list = [env, domain]
    for t in terms:
        params += [f"%{t}%", f"%{t}%"]
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT id, key, content, code_ref, source_run FROM knowledge"
            f" WHERE env=%s AND domain=%s AND expired=false AND valid_to IS NULL"
            f" AND ({where})"
            f" ORDER BY feedback_score DESC, created_at DESC LIMIT %s",
            (*params, limit))
        return await cur.fetchall()
