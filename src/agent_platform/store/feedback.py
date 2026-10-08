"""反馈：Run Viewer 页面 👍👎 与纠正留痕，供评估闭环抽取 badcase。"""

from __future__ import annotations

from .db import pool


async def add(run_id: str, score: int, comment: str = "") -> None:
    if score not in (1, -1):
        raise ValueError("score 只能是 +1 或 -1")
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO feedback (run_id, score, comment) VALUES (%s,%s,%s)",
            (run_id, score, comment))


async def propagate_to_memory(env: str, run_id: str, score: int) -> None:
    """反馈闭环：run 的 👍👎 同步到它沉淀的知识条目与案例，影响后续召回排序。"""
    delta = 1 if score == 1 else -1
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE knowledge SET feedback_score=COALESCE(feedback_score,0)+%s"
            " WHERE env=%s AND source_run=%s", (delta, env, run_id))
        col = "thumbs_up" if score == 1 else "thumbs_down"
        await conn.execute(
            f"UPDATE cases SET {col}={col}+1 WHERE env=%s AND source_run=%s",
            (env, run_id))


async def add_correction(session_id: str, correction: str, by: str = "") -> None:
    """纠正式反馈留痕：kind=correction。"""
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO feedback (session_id, kind, comment) VALUES (%s,'correction',%s)",
            (session_id, correction if not by else f"[{by}] {correction}"))


async def summary() -> dict:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT COUNT(*) FILTER (WHERE score=1),"
            " COUNT(*) FILTER (WHERE score=-1) FROM feedback")
        row = await cur.fetchone()
    return {"thumbs_up": row[0], "thumbs_down": row[1]}


async def correction_counts(min_count: int = 3) -> list[dict]:
    """重复纠正信号：同 session 纠正达到阈值说明记忆层反复兜不住，
    管理页提示人工升舱为角色 prompt（程序记忆升舱保持人工门）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT session_id, COUNT(*) AS n, MAX(created_at) AS last_at"
            " FROM feedback WHERE kind='correction'"
            " GROUP BY session_id HAVING COUNT(*) >= %s"
            " ORDER BY n DESC LIMIT 50", (min_count,))
        rows = await cur.fetchall()
    return [{"session_id": r[0], "count": r[1], "last_at": r[2].isoformat()}
            for r in rows]
