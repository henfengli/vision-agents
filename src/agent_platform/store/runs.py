"""runs / run_events：执行台账。

session_id 是会话唯一标识（LangGraph thread 是它的实现细节，不出 engine 层）。
run 状态机：queued → running → success / failed。
"""
from __future__ import annotations

import json

from . import db


async def create(run_id: str, task_type: str, role: str, domain: str | None,
                 trigger_source: str, caller: str, input_data: dict,
                 dedup_key: str = "", session_id: str | None = None,
                 target_env: str = "") -> None:
    async with db.pool().connection() as conn:
        await conn.execute(
            "INSERT INTO runs (run_id, session_id, task_type, role, domain,"
            " target_env, trigger_source, caller, input, status, dedup_key)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'queued',%s)",
            (run_id, session_id or run_id, task_type, role, domain, target_env,
             trigger_source, caller, json.dumps(input_data), dedup_key))


async def get(run_id: str) -> dict | None:
    async with db.pool().connection() as conn:
        cur = await conn.execute("SELECT * FROM runs WHERE run_id = %s", (run_id,))
        row = await cur.fetchone()
    return _row_to_dict(cur, row) if row else None


async def set_status(run_id: str, status: str, output: dict | None = None,
                     tokens: int = 0, duration_ms: int = 0) -> None:
    async with db.pool().connection() as conn:
        await conn.execute(
            "UPDATE runs SET status=%s, output=%s, tokens=%s, duration_ms=%s"
            " WHERE run_id=%s",
            (status, json.dumps(output or {}), tokens, duration_ms, run_id))


async def find_by_dedup(dedup_key: str, window_s: int) -> dict | None:
    """时间窗内同 dedup_key 的成功 run（重复触发直接去重）。"""
    if not dedup_key:
        return None
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM runs WHERE dedup_key = %s AND status = 'success'"
            " AND created_at > now() - make_interval(secs => %s)"
            " ORDER BY created_at DESC LIMIT 1", (dedup_key, window_s))
        row = await cur.fetchone()
    return _row_to_dict(cur, row) if row else None


async def latest_of_session(session_id: str, exclude: str = "") -> dict | None:
    """会话最近一个 run 的概要（correction 继承 task_type/role/domain/env 用）。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, task_type, role, domain, input, target_env FROM runs"
            " WHERE session_id = %s AND run_id <> %s"
            " ORDER BY created_at DESC LIMIT 1", (session_id, exclude))
        row = await cur.fetchone()
    if not row:
        return None
    return {"run_id": row[0], "task_type": row[1], "role": row[2],
            "domain": row[3], "input": row[4], "target_env": row[5]}


async def list_recent(target_env: str | None = None, limit: int = 100) -> list[dict]:
    """run 列表（Viewer 列表页）；可按目标环境过滤。"""
    where, params = "", []
    if target_env:
        where, params = " WHERE target_env=%s", [target_env]
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, session_id, task_type, role, domain, target_env,"
            " status, trigger_source, created_at FROM runs" + where +
            " ORDER BY created_at DESC LIMIT %s", (*params, limit))
        rows = await cur.fetchall()
    return [{"run_id": r[0], "session_id": r[1], "task_type": r[2],
             "role": r[3], "domain": r[4], "target_env": r[5], "status": r[6],
             "trigger_source": r[7], "created_at": r[8].isoformat()}
            for r in rows]


async def session_exists(session_id: str) -> bool:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM runs WHERE session_id = %s LIMIT 1", (session_id,))
        return await cur.fetchone() is not None


async def log_event(run_id: str, kind: str, payload: dict) -> None:
    """追加事件；seq = 当前 max+1。

    并发安全：同一 run 的并行写入（资产图层内并行节点同时落事件）先取
    pg_advisory_xact_lock 按 run_id 串行化，max(seq)+1 不会撞号——SSE 按
    seq 增量拉取，重复 seq 会丢事件。连接上下文整体一个事务，锁随事务释放。
    另有 (run_id, seq) 唯一索引兜底（db.py MIGRATIONS）。
    """
    async with db.pool().connection() as conn:
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (run_id,))
        await conn.execute(
            "INSERT INTO run_events (run_id, seq, kind, payload) VALUES ("
            "%s, COALESCE((SELECT max(seq) FROM run_events WHERE run_id=%s), 0) + 1,"
            " %s, %s)", (run_id, run_id, kind, json.dumps(payload)))


async def get_events(run_id: str) -> list[dict]:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT seq, kind, payload, created_at FROM run_events"
            " WHERE run_id = %s ORDER BY seq", (run_id,))
        rows = await cur.fetchall()
    return [{"seq": r[0], "kind": r[1], "payload": r[2],
             "created_at": r[3].isoformat()} for r in rows]


async def set_def_versions(run_id: str, task_version: int | None,
                           role_version: int | None) -> None:
    """固定谱系：run 实际使用的任务/角色定义版本（prepare_run 时写入一次）。"""
    async with db.pool().connection() as conn:
        await conn.execute(
            "UPDATE runs SET task_version=%s, role_version=%s WHERE run_id=%s",
            (task_version, role_version, run_id))


async def count_recent_with_version(kind: str, name: str, version: int,
                                    hours: int = 24) -> int:
    """近 N 小时使用某定义版本的 run 数——Admin 保存新版本时的影响面提示。"""
    column, ver_column = (("role", "role_version") if kind == "role"
                          else ("task_type", "task_version"))
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT count(*) FROM runs WHERE {column}=%s AND {ver_column}=%s"
            f" AND created_at > now() - make_interval(hours => %s)",
            (name, version, hours))
        return (await cur.fetchone())[0]


async def trace_id_of(run_id: str) -> str:
    """从台账事件取 Langfuse trace_id（未启用观测时为空串）。"""
    events = await get_events(run_id)
    return next((e["payload"].get("trace_id") for e in events
                 if e["kind"] == "trace" and isinstance(e["payload"], dict)), "")


def _row_to_dict(cur, row) -> dict:
    return {d.name: v for d, v in zip(cur.description, row)}
