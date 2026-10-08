"""Run 台账与事件明细：审计、排障、评估的唯一事实源。

概念约定：session_id 是会话唯一标识（LangGraph thread 是它的实现细节，
不出 engine 层）；run 无 session 时 session_id = run_id（自会话）。
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from .db import pool


async def create_run(run_id: str, task_type: str, role: str, domain: str | None,
                     trigger_source: str, caller: str | None, input_data: dict,
                     dedup_key: str | None, session_id: str | None = None) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO runs (run_id, session_id, task_type, role, domain, "
            "trigger_source, caller, input, status, dedup_key) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'queued',%s)",
            (run_id, session_id or run_id, task_type, role, domain,
             trigger_source, caller, json.dumps(input_data), dedup_key),
        )


async def find_recent_by_dedup(dedup_key: str, window_s: int) -> str | None:
    """dedup：窗口期内已有同 key 的 run，返回其 run_id。"""
    since = datetime.now(timezone.utc) - timedelta(seconds=window_s)
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id FROM runs WHERE dedup_key=%s AND created_at>%s "
            "AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1",
            (dedup_key, since),
        )
        row = await cur.fetchone()
    return row[0] if row else None


async def set_status(run_id: str, status: str, output: dict | None = None,
                     tokens: int | None = None, duration_ms: int | None = None) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE runs SET status=%s, "
            "output=COALESCE(%s, output), tokens=COALESCE(%s, tokens), "
            "duration_ms=COALESCE(%s, duration_ms) WHERE run_id=%s",
            (status, json.dumps(output) if output is not None else None,
             tokens, duration_ms, run_id),
        )


async def append_event(run_id: str, seq: int, kind: str, payload: dict[str, Any]) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO run_events (run_id, seq, kind, payload) VALUES (%s,%s,%s,%s)",
            (run_id, seq, kind, json.dumps(payload, ensure_ascii=False, default=str)),
        )


async def get_run(run_id: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute("SELECT * FROM runs WHERE run_id=%s", (run_id,))
        row = await cur.fetchone()
        if not row:
            return None
        cols = [d.name for d in cur.description]
    run = dict(zip(cols, row))
    for k in ("input", "output"):
        if isinstance(run.get(k), str):
            run[k] = json.loads(run[k])
    return run


async def get_events(run_id: str) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT seq, kind, payload, created_at FROM run_events "
            "WHERE run_id=%s ORDER BY seq", (run_id,),
        )
        rows = await cur.fetchall()
    return [
        {"seq": s, "kind": k,
         "payload": json.loads(p) if isinstance(p, str) else p,
         "created_at": t.isoformat()}
        for s, k, p, t in rows
    ]


async def max_seq(run_id: str) -> int:
    """事件续写序号（activity 重试/分步写事件时保持 seq 唯一）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM run_events WHERE run_id=%s",
            (run_id,))
        return (await cur.fetchone())[0]


async def runs_by_session(session_id: str, exclude: str | None = None,
                          limit: int | None = None) -> list[dict]:
    """同一 session 下的 run，按创建时间倒序。
    limit=1 即"最近一次 run"：纠正反馈继承上下文 / 收窄取代范围用。"""
    sql = ("SELECT run_id, task_type, role, domain, input FROM runs "
           "WHERE session_id=%s AND run_id != %s ORDER BY created_at DESC")
    params: list = [session_id, exclude or ""]
    if limit:
        sql += " LIMIT %s"
        params.append(limit)
    async with pool().connection() as conn:
        cur = await conn.execute(sql, tuple(params))
        rows = await cur.fetchall()
    out = []
    for rid, tt, role, dom, inp in rows:
        if isinstance(inp, str):
            inp = json.loads(inp)
        out.append({"run_id": rid, "task_type": tt, "role": role,
                    "domain": dom, "input": inp})
    return out
