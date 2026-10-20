"""知识检索：pg_trgm + pgvector 混合召回，RRF 融合；code_ref 新鲜度校验。"""

from __future__ import annotations

import json
import subprocess
import time

from ..db import pool

# HEAD 短 TTL 缓存：记忆页/召回对每条目做一次新鲜度校验，同一仓库的
# rev-parse 会被反复发起（git subprocess 不便宜）。commit 漂移是分钟级
# 以上的事，30s 内的旧值无害——巡检/召回下一轮自然拿到新值。
_HEAD_TTL_S = 30.0
_head_cache: dict[str, tuple[float, str | None]] = {}


def current_commit(code_path: str) -> str | None:
    """业务代码目录当前 commit；非 git 仓库返回 None（跳过校验，不退化）。"""
    hit = _head_cache.get(code_path)
    if hit and time.monotonic() - hit[0] < _HEAD_TTL_S:
        return hit[1]
    try:
        out = subprocess.run(
            ["git", "-C", code_path, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        head = out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        head = None
    _head_cache[code_path] = (time.monotonic(), head)
    return head


def code_base(path: str, code_paths: list[str]) -> str | None:
    """code_ref 的路径属于哪个代码目录：最长前缀匹配（嵌套目录取最具体的）。

    沉淀（distill 记 commit）与校验（is_entry_fresh）共用本函数选仓库——
    两边各选各的会在多代码目录的域里记错 commit、误判漂移。
    """
    matches = [b for b in code_paths if str(path).startswith(b)]
    return max(matches, key=len) if matches else None


def is_entry_fresh(code_ref: dict | None, code_paths: list[str]) -> bool:
    """校验知识条目的 code_ref 是否与当前代码一致。无 code_ref 视为始终新鲜。"""
    if not code_ref or not code_ref.get("path"):
        return True
    recorded = code_ref.get("commit")
    if not recorded:
        return True
    base = code_base(code_ref["path"], code_paths)
    if base is None:
        return True
    head = current_commit(base)
    # 非 git 仓库（head 为 None）无法校验，按新鲜处理——不退化
    return head is None or head == recorded


async def search(env: str, service: str, query: str, limit: int = 5,
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
            vec_rows = await _search_vector(env, service, vecs[0], limit * 2)
    if terms:
        trgm_rows = await _search_trgm(env, service, terms, limit * 2)
        if trgm_rows is None:
            trgm_rows = await _search_ilike(env, service, terms, limit * 2)
    else:
        trgm_rows = []
    if not vec_rows:
        candidates = trgm_rows
    elif not trgm_rows:
        candidates = vec_rows
    else:
        candidates = _rrf_merge(trgm_rows, vec_rows, limit * 2)
    rows = await _weight_by_feedback(candidates, limit)
    return [
        {"id": i, "key": k, "content": c,
         "code_ref": json.loads(r) if isinstance(r, str) else r,
         "source_run": s, "task": t}
        for i, k, c, r, s, t, *_ in rows  # 查询多带的分数字段，丢弃
    ]


MANUAL_BONUS_POINTS = 3      # 人工录入的条目（source_run 为空）相当于多 3 个 👍


async def _weight_by_feedback(candidates: list, limit: int,
                              fb_per_point: float = 0.01) -> list:
    """反馈加权终排：RRF 名次分 1/(60+rank) + (反馈分 + 人工加成) × 系数，反馈分 ±5 封顶。

    单通道（仅 trgm/仅向量）也走同一公式——反馈对所有召回路径生效。
    候选集在 limit 截断前加权，高反馈、人工写的后排条目能挤进前 limit。
    """
    if not candidates:
        return []
    ids = [r[0] for r in candidates]
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, COALESCE(feedback_score, 0), source_run IS NULL FROM knowledge WHERE id = ANY(%s)", (ids,))
        points = {i: max(-5, min(5, fb)) + (MANUAL_BONUS_POINTS if manual else 0)
                  for i, fb, manual in await cur.fetchall()}

    def score(rank_row):
        rank, row = rank_row
        return 1.0 / (60 + rank + 1) + fb_per_point * points.get(row[0], 0)
    ordered = sorted(enumerate(candidates), key=score, reverse=True)
    return [row for _, row in ordered[:limit]]


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


async def _search_vector(env, service, vec: list[float], limit):
    lit = "[%s]" % ",".join(f"{x:.6f}" for x in vec)
    try:
        async with pool().connection() as conn:
            cur = await conn.execute(
                "SELECT id, key, content, code_ref, source_run, task,"
                " 1 - (embedding <=> %s::vector) AS sim FROM knowledge"
                " WHERE env=%s AND service=%s AND expired=false AND valid_to IS NULL"
                " AND embedding IS NOT NULL"
                " ORDER BY embedding <=> %s::vector LIMIT %s",
                (lit, env, service, lit, limit))
            return await cur.fetchall()
    except Exception:  # noqa: BLE001 —— pgvector 缺失时退化
        return []


async def _search_trgm(env, service, terms, limit):
    """word_similarity(term, 文本)：查询词片段在长文本中的最佳匹配度。
    返回 None 表示 pg_trgm 不可用，调用方退化 ILIKE。"""
    sim_expr = "GREATEST(" + ", ".join(
        ["word_similarity(%s, key || ' ' || content)"] * len(terms)) + ")"
    like_expr = " OR ".join(["key ILIKE %s OR content ILIKE %s"] * len(terms))
    sql = (f"SELECT id, key, content, code_ref, source_run, task, {sim_expr} AS sim"
           f" FROM knowledge"
           f" WHERE env=%s AND service=%s AND expired=false AND valid_to IS NULL"
           f" AND ({sim_expr} > 0.08 OR {like_expr})"
           f" ORDER BY sim DESC, feedback_score DESC, created_at DESC LIMIT %s")
    params = (list(terms)
              + [env, service]
              + list(terms)
              + [x for t in terms for x in (f"%{t}%", f"%{t}%")]
              + [limit])
    try:
        async with pool().connection() as conn:
            cur = await conn.execute(sql, tuple(params))
            return await cur.fetchall()
    except Exception:  # noqa: BLE001 —— pg_trgm 不存在/权限不足
        return None


async def _search_ilike(env, service, terms, limit):
    where = " OR ".join(["key ILIKE %s OR content ILIKE %s"] * len(terms))
    params: list = [env, service]
    for t in terms:
        params += [f"%{t}%", f"%{t}%"]
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT id, key, content, code_ref, source_run, task FROM knowledge"
            f" WHERE env=%s AND service=%s AND expired=false AND valid_to IS NULL"
            f" AND ({where})"
            f" ORDER BY feedback_score DESC, created_at DESC LIMIT %s",
            (*params, limit))
        return await cur.fetchall()
