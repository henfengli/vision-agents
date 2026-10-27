"""回归重放的存储：一次重放（批次）+ 每条原运行与重放运行的对照和判定。"""

from __future__ import annotations

import json
from datetime import datetime

from .db import pool


# 批次里有没被 👎 的原运行：这样的条目判定读作"有没有退步"（更好 / 持平 / 退步），页面据此换说法
_REGRESSION = ("COALESCE(bool_or(i.id IS NOT NULL AND NOT EXISTS ("
               "SELECT 1 FROM feedback f WHERE f.run_id = i.source_run AND f.score < 0)), false)")


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


async def create(*, title: str, filter_: dict, note: str, by: str, source_runs: list[str]) -> int:
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "INSERT INTO replays (title, filter, note, created_by) VALUES (%s, %s, %s, %s) RETURNING id",
            (title, json.dumps(filter_, ensure_ascii=False), note, by))
        replay_id = (await cur.fetchone())[0]
        for run_id in source_runs:
            await conn.execute("INSERT INTO replay_items (replay_id, source_run) VALUES (%s, %s)"
                               " ON CONFLICT DO NOTHING", (replay_id, run_id))
    return replay_id


async def set_new_run(replay_id: int, source_run: str, new_run: str | None, *, verdict: str | None = None,
                      reason: str = "") -> None:
    """重放运行建好了（或没建成：verdict=error 并写原因）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE replay_items SET new_run=%s, verdict=%s, reason=%s,"
            " judged_at=CASE WHEN %s::text IS NULL THEN NULL ELSE now() END"
            " WHERE replay_id=%s AND source_run=%s",
            (new_run, verdict, reason, verdict, replay_id, source_run))


async def item_of_new_run(new_run: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, replay_id, source_run, new_run, verdict FROM replay_items WHERE new_run=%s", (new_run,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "replay_id": row[1], "source_run": row[2], "new_run": row[3], "verdict": row[4]}


async def judge(item_id: int, verdict: str, reason: str) -> None:
    async with pool().connection() as conn:
        await conn.execute("UPDATE replay_items SET verdict=%s, reason=%s, judged_at=now() WHERE id=%s",
                           (verdict, reason[:2000], item_id))


async def listing(limit: int = 50) -> list[dict]:
    """重放批次列表（新的在前），带各判定的计数。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT r.id, r.title, r.filter, r.note, r.created_by, r.created_at, count(i.id),"
            " count(*) FILTER (WHERE i.verdict='fixed'), count(*) FILTER (WHERE i.verdict='same'),"
            " count(*) FILTER (WHERE i.verdict='worse'), count(*) FILTER (WHERE i.verdict IN ('unclear','error')),"
            f" count(*) FILTER (WHERE i.verdict IS NULL), {_REGRESSION}"
            " FROM replays r LEFT JOIN replay_items i ON i.replay_id = r.id"
            " GROUP BY r.id ORDER BY r.created_at DESC LIMIT %s", (max(1, min(limit, 200)),))
        rows = await cur.fetchall()
    return [_summary(r) for r in rows]


async def get(replay_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT r.id, r.title, r.filter, r.note, r.created_by, r.created_at, count(i.id),"
            " count(*) FILTER (WHERE i.verdict='fixed'), count(*) FILTER (WHERE i.verdict='same'),"
            " count(*) FILTER (WHERE i.verdict='worse'), count(*) FILTER (WHERE i.verdict IN ('unclear','error')),"
            f" count(*) FILTER (WHERE i.verdict IS NULL), {_REGRESSION}"
            " FROM replays r LEFT JOIN replay_items i ON i.replay_id = r.id WHERE r.id=%s GROUP BY r.id", (replay_id,))
        row = await cur.fetchone()
    return _summary(row) if row else None


async def items(replay_id: int) -> list[dict]:
    """逐条对照：原运行与重放运行的任务、版本、输入摘要、答案、状态，加判定。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT i.id, i.source_run, i.new_run, i.verdict, i.reason, i.judged_at,"
            " s.task, s.service, s.env, s.summary, s.task_version, s.role_version, s.output, s.status,"
            " n.task_version, n.role_version, n.output, n.status, s.recipe, n.recipe,"
            " EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = i.source_run AND f.score < 0)"
            " FROM replay_items i JOIN runs s ON s.run_id = i.source_run LEFT JOIN runs n ON n.run_id = i.new_run"
            " WHERE i.replay_id=%s ORDER BY i.id", (replay_id,))
        rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append({
            "id": r[0], "source_run": r[1], "new_run": r[2], "verdict": r[3], "reason": r[4], "judged_at": _iso(r[5]),
            "task": r[6], "service": r[7], "env": r[8], "summary": r[9],
            "negative": r[20],          # 原运行被 👎 过：判定看"问题改好没有"；否则看"有没有退步"
            "before": {"task_version": r[10], "role_version": r[11], "answer": _answer(r[12]), "status": r[13],
                       "recipe": r[18]},
            "after": {"task_version": r[14], "role_version": r[15], "answer": _answer(r[16]), "status": r[17],
                      "recipe": r[19]},
        })
    return out


def _answer(output: dict | None) -> str | None:
    if not output:
        return None
    return output.get("answer") or output.get("error") or json.dumps(output, ensure_ascii=False)[:4000]


def _summary(r) -> dict:
    return {"id": r[0], "title": r[1], "filter": r[2] or {}, "note": r[3], "created_by": r[4],
            "created_at": r[5].isoformat(), "regression": bool(r[12]),
            "counts": {"total": r[6], "fixed": r[7], "same": r[8], "worse": r[9], "unclear": r[10], "pending": r[11]}}
