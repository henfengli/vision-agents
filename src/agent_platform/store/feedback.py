"""反馈的读写。规则见 domain/feedback.py：一人一步一条，改主意是覆盖、撤回是删除。

整次运行的评价每变一次，就把"变化量"同步到这次运行沉淀的知识、案例、方法上，
所以重复点、改主意、撤回都不会把权重算重。
"""

from __future__ import annotations

from ..domain import WHOLE_RUN, Feedback
from .db import pool

_COLS = "f.id, f.run_id, f.step_seq, f.score, f.reasons, f.comment, f.created_by, f.created_at, f.updated_at"


def _row(r) -> dict:
    return {"id": r[0], "run_id": r[1], "step_seq": r[2], "score": r[3], "reasons": list(r[4]), "comment": r[5],
            "created_by": r[6], "created_at": r[7].isoformat(), "updated_at": r[8].isoformat()}


async def put(run_id: str, step_seq: int, by: str, fb: Feedback) -> tuple[dict, int | None]:
    """写入或覆盖 by 对这一步的反馈。返回 (新反馈, 之前的分数)。"""
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT score FROM feedback WHERE run_id=%s AND step_seq=%s AND created_by=%s FOR UPDATE",
            (run_id, step_seq, by))
        old = await cur.fetchone()
        cur = await conn.execute(
            "INSERT INTO feedback AS f (run_id, step_seq, score, reasons, comment, created_by)"
            " VALUES (%s, %s, %s, %s, %s, %s)"
            " ON CONFLICT (run_id, step_seq, created_by) DO UPDATE"
            " SET score=EXCLUDED.score, reasons=EXCLUDED.reasons, comment=EXCLUDED.comment, updated_at=now()"
            f" RETURNING {_COLS}",
            (run_id, step_seq, fb.score, fb.reasons, fb.comment, by))
        return _row(await cur.fetchone()), (old[0] if old else None)


async def remove(run_id: str, step_seq: int, by: str) -> int | None:
    """撤回 by 对这一步的反馈。返回被撤回的分数（本来就没有则 None）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "DELETE FROM feedback WHERE run_id=%s AND step_seq=%s AND created_by=%s RETURNING score",
            (run_id, step_seq, by))
        row = await cur.fetchone()
    return row[0] if row else None


async def for_run(run_id: str) -> list[dict]:
    """一次运行收到的全部反馈（整次 + 各步），按时间排序。"""
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM feedback f WHERE f.run_id=%s ORDER BY f.updated_at", (run_id,))
        return [_row(r) for r in await cur.fetchall()]


async def mine(run_ids: list[str], by: str) -> dict[str, dict]:
    """by 对这些运行的整次评价：{run_id: 反馈}（对话页每轮回答下面显示自己的评价）。"""
    if not run_ids:
        return {}
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_COLS} FROM feedback f WHERE f.run_id = ANY(%s) AND f.step_seq=%s AND f.created_by=%s",
            (run_ids, WHOLE_RUN, by))
        return {r[1]: _row(r) for r in await cur.fetchall()}


async def listing(*, score: int | None = None, service: str | None = None, env: str | None = None,
                  task: str | None = None, reason: str | None = None, hours: int | None = None,
                  limit: int = 100) -> list[dict]:
    """反馈收件箱：带上运行的服务、环境、任务、摘要，新的在前。task 含其子任务。"""
    conds, params = [], []
    for clause, val in (("f.score=%s", score), ("r.service=%s", service), ("r.env=%s", env),
                        ("%s = ANY(f.reasons)", reason)):
        if val is not None and val != "":
            conds.append(clause)
            params.append(val)
    if task:
        conds.append("(r.task=%s OR r.task LIKE %s)")
        params += [task, task + ":%"]
    if hours:
        conds.append("f.updated_at > now() - make_interval(hours => %s)")
        params.append(hours)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_COLS}, r.task, r.service, r.env, r.summary, r.status FROM feedback f"
            f" JOIN runs r ON r.run_id = f.run_id{where} ORDER BY f.updated_at DESC LIMIT %s",
            (*params, max(1, min(limit, 500))))
        rows = await cur.fetchall()
    return [{**_row(r), "task": r[9], "service": r[10], "env": r[11], "summary": r[12], "run_status": r[13]}
            for r in rows]


async def shift_memory_weight(env: str, run_id: str, old: int | None, new: int | None) -> None:
    """整次评价从 old 变成 new（None = 没有评价）：把差值记到这次运行沉淀的记忆上。"""
    delta = (new or 0) - (old or 0)
    if delta == 0:
        return
    async with pool().connection() as conn:
        await conn.execute("UPDATE knowledge SET feedback_score = feedback_score + %s WHERE env=%s AND source_run=%s",
                           (delta, env, run_id))
        await conn.execute("UPDATE assets SET feedback_score = feedback_score + %s WHERE env=%s AND source_run=%s",
                           (delta, env, run_id))
        await conn.execute(
            "UPDATE cases SET thumbs_up = thumbs_up + %s, thumbs_down = thumbs_down + %s WHERE env=%s AND source_run=%s",
            (int(new == 1) - int(old == 1), int(new == -1) - int(old == -1), env, run_id))
