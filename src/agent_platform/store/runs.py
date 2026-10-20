"""runs / run_events：运行台账。

状态机：queued →（awaiting_approval →）running → success | failed | cancelled。
started_at 在第一次进入 running 时落，finished_at 在进入终态时落——耗时、
时间线偏移、SLA 统计都从这两列算，不从事件里猜。
caller 永不为空：调用方没给身份时回退为触发类型（定时跑的 caller 就是 schedule）。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from . import db

_LIST_COLS = ("run_id, session_id, task, role, service, env, status, resolution, trigger_type, trigger_id,"
              " trigger_source, caller, summary, tokens, duration_ms, created_at, finished_at")


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def _list_row(r) -> dict:
    return {
        "run_id": r[0], "session_id": r[1], "task": r[2], "role": r[3], "service": r[4], "env": r[5],
        "status": r[6], "resolution": r[7],
        "trigger": {"type": r[8], "id": r[9], "source": r[10], "caller": r[11]},
        "summary": r[12], "tokens": r[13], "duration_ms": r[14],
        "created_at": r[15].isoformat(), "finished_at": _iso(r[16]),
    }


def _row(cur, row) -> dict:
    d = {c.name: v for c, v in zip(cur.description, row)}
    for k in ("created_at", "started_at", "finished_at"):
        d[k] = _iso(d.get(k))
    d["trigger"] = {"type": d.pop("trigger_type"), "id": d.pop("trigger_id"), "source": d.pop("trigger_source"), "caller": d["caller"]}
    return d


async def create(*, run_id: str, session_id: str, task: str, role: str | None, service: str | None, env: str,
                 trigger_type: str, trigger_id: str | None, trigger_source: str | None, caller: str | None,
                 summary: str, input_data: dict, memory: dict | None = None, status: str = "queued",
                 dedup_key: str | None = None, idempotency_key: str | None = None,
                 output: dict | None = None, resolution: str | None = None) -> None:
    """output + resolution 只在规则先行命中时预先给出（结论在提交时就有了）。"""
    async with db.pool().connection() as conn:
        await conn.execute(
            "INSERT INTO runs (run_id, session_id, task, role, service, env, trigger_type, trigger_id, trigger_source,"
            " caller, summary, input, memory, status, dedup_key, idempotency_key, output, resolution)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (run_id, session_id, task, role, service, env, trigger_type, trigger_id, trigger_source,
             (caller or "").strip() or trigger_type, summary[:300], json.dumps(input_data, ensure_ascii=False, default=str),
             json.dumps(memory or {}), status, dedup_key or None, idempotency_key or None,
             json.dumps(output, ensure_ascii=False) if output is not None else None, resolution))


async def get(run_id: str) -> dict | None:
    async with db.pool().connection() as conn:
        cur = await conn.execute("SELECT * FROM runs WHERE run_id=%s", (run_id,))
        row = await cur.fetchone()
    return _row(cur, row) if row else None


async def set_status(run_id: str, status: str, *, output: dict | None = None, resolution: str | None = None,
                     error_code: str | None = None, tokens: int | None = None) -> None:
    """改状态；首次 running 落 started_at，终态落 finished_at 与耗时。"""
    terminal = status in ("success", "failed", "cancelled")
    async with db.pool().connection() as conn:
        await conn.execute(
            "UPDATE runs SET status=%s,"
            " output=COALESCE(%s::jsonb, output), resolution=COALESCE(%s, resolution),"
            " error_code=COALESCE(%s, error_code), tokens=COALESCE(%s, tokens),"
            " started_at=CASE WHEN %s='running' AND started_at IS NULL THEN now() ELSE started_at END,"
            " finished_at=CASE WHEN %s THEN now() ELSE finished_at END,"
            " duration_ms=CASE WHEN %s THEN (EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000)::int"
            "   ELSE duration_ms END"
            " WHERE run_id=%s",
            (status, json.dumps(output, ensure_ascii=False, default=str) if output is not None else None,
             resolution, error_code, tokens, status, terminal, terminal, run_id))


async def set_versions(run_id: str, task_version: int | None, role_version: int | None) -> None:
    async with db.pool().connection() as conn:
        await conn.execute("UPDATE runs SET task_version=%s, role_version=%s WHERE run_id=%s",
                           (task_version, role_version, run_id))


async def add_tokens(run_id: str, n: int) -> None:
    if n:
        async with db.pool().connection() as conn:
            await conn.execute("UPDATE runs SET tokens=COALESCE(tokens,0)+%s WHERE run_id=%s", (n, run_id))


async def find_dedup(dedup_key: str, window_s: int) -> dict | None:
    """时间窗内同键的成功运行（任务声明的去重）。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM runs WHERE dedup_key=%s AND status='success'"
            " AND created_at > now() - make_interval(secs => %s) ORDER BY created_at DESC LIMIT 1", (dedup_key, window_s))
        row = await cur.fetchone()
    return _row(cur, row) if row else None


async def find_idempotent(key: str) -> dict | None:
    """调用方幂等键：24h 内非失败的运行都命中（排队/运行中也算），失败允许同键重提。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM runs WHERE idempotency_key=%s AND created_at > now() - interval '24 hours'", (key,))
        row = await cur.fetchone()
    if not row:
        return None
    r = _row(cur, row)
    if r["status"] == "failed":
        async with db.pool().connection() as conn:   # 释放唯一键，允许重提
            await conn.execute("UPDATE runs SET idempotency_key=NULL WHERE run_id=%s", (r["run_id"],))
        return None
    return r


async def list_filtered(*, status: str | None = None, env: str | None = None, service: str | None = None,
                        task: str | None = None, trigger: str | None = None, caller: str | None = None,
                        session: str | None = None, q: str | None = None, hours: int | None = None,
                        cursor: str | None = None, limit: int = 30) -> dict:
    """列表：平面过滤 + keyset 翻页（created_at, run_id 倒序）。cursor = "next:<ts>|<id>" 或 "prev:<ts>|<id>"。"""
    conds: list[str] = []
    params: list[Any] = []
    for clause, val in (("status=%s", status), ("env=%s", env), ("service=%s", service), ("trigger_type=%s", trigger),
                        ("caller=%s", caller), ("session_id=%s", session)):
        if val:
            conds.append(clause)
            params.append(val)
    if task:
        conds.append("(task=%s OR task LIKE %s)")
        params += [task, task + ":%"]
    if hours:
        conds.append("created_at > now() - make_interval(hours => %s)")
        params.append(hours)
    if q:
        conds.append("(run_id LIKE %s OR summary ILIKE %s)")
        params += [q + "%", "%" + q + "%"]
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    limit = max(1, min(limit, 200))

    page_conds, page_params, backwards = list(conds), list(params), False
    if cursor:
        direction, _, key = cursor.partition(":")
        ts, _, rid = key.partition("|")
        try:
            datetime.fromisoformat(ts)
        except ValueError:
            raise ValueError("非法的分页游标") from None
        backwards = direction == "prev"
        page_conds.append(f"(created_at, run_id) {'>' if backwards else '<'} (%s::timestamptz, %s)")
        page_params += [ts, rid]
    pwhere = (" WHERE " + " AND ".join(page_conds)) if page_conds else ""
    order = "ASC" if backwards else "DESC"

    async with db.pool().connection() as conn:
        cur = await conn.execute("SELECT count(*) FROM runs" + where, params)
        total = (await cur.fetchone())[0]
        cur = await conn.execute(
            f"SELECT {_LIST_COLS} FROM runs{pwhere} ORDER BY created_at {order}, run_id {order} LIMIT %s",
            (*page_params, limit + 1))
        rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    if backwards:
        rows.reverse()
    items = [_list_row(r) for r in rows]
    key = lambda r: f"{r[15].isoformat()}|{r[0]}"  # noqa: E731
    next_c = prev_c = None
    if rows:
        if (more and not backwards) or (backwards and cursor):
            next_c = "next:" + key(rows[-1])
        if (more and backwards) or (cursor and not backwards):
            prev_c = "prev:" + key(rows[0])
    return {"items": items, "total": total, "next_cursor": next_c, "prev_cursor": prev_c}


async def by_session(session_id: str, exclude: str = "", limit: int = 50) -> list[dict]:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_LIST_COLS} FROM runs WHERE session_id=%s AND run_id<>%s ORDER BY created_at LIMIT %s",
            (session_id, exclude, limit))
        return [_list_row(r) for r in await cur.fetchall()]


async def latest_of_session(session_id: str, exclude: str = "") -> dict | None:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM runs WHERE session_id=%s AND run_id<>%s ORDER BY created_at DESC LIMIT 1", (session_id, exclude))
        row = await cur.fetchone()
    return _row(cur, row) if row else None


async def sessions(*, service: str | None = None, env: str | None = None, task: str | None = None,
                   q: str | None = None, limit: int = 100) -> list[dict]:
    """对话会话（chat 触发的运行按 session 聚合），按最后活动倒序。过滤作用在会话的任一轮上。"""
    conds, params = ["trigger_type IN ('chat','correction')"], []
    for clause, val in (("service=%s", service), ("env=%s", env), ("split_part(task, ':', 1)=%s", task)):
        if val:
            conds.append(clause)
            params.append(val)
    having, params_q = (" HAVING bool_or(summary ILIKE %s)", ["%" + q + "%"]) if q else ("", [])
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT session_id, max(created_at), count(*),"
            " (array_agg(summary ORDER BY created_at))[1],"
            " (array_agg(service ORDER BY created_at DESC))[1], (array_agg(env ORDER BY created_at DESC))[1],"
            " (array_agg(task ORDER BY created_at DESC))[1]"
            f" FROM runs WHERE {' AND '.join(conds)} GROUP BY session_id{having}"
            " ORDER BY max(created_at) DESC LIMIT %s", (*params, *params_q, limit))
        rows = await cur.fetchall()
    return [{"session_id": r[0], "last_at": r[1].isoformat(), "runs": r[2], "title": (r[3] or "")[:60],
             "service": r[4], "env": r[5], "task": r[6]} for r in rows]


async def of_session(session_id: str) -> list[dict]:
    async with db.pool().connection() as conn:
        cur = await conn.execute("SELECT * FROM runs WHERE session_id=%s ORDER BY created_at", (session_id,))
        rows = await cur.fetchall()
        return [_row(cur, r) for r in rows]


# ———————— 事件 ————————

async def log_event(run_id: str, kind: str, payload: dict) -> int:
    """追加事件，返回 seq，并 pg_notify('run_events', run_id) 唤醒正在推流的连接。
    同一运行的并发写（任务图层内并行）用 advisory 锁串行化取号。"""
    async with db.pool().connection() as conn:
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (run_id,))
        cur = await conn.execute(
            "INSERT INTO run_events (run_id, seq, kind, payload) VALUES"
            " (%s, COALESCE((SELECT max(seq) FROM run_events WHERE run_id=%s), 0) + 1, %s, %s) RETURNING seq",
            (run_id, run_id, kind, json.dumps(payload, ensure_ascii=False, default=str)))
        seq = (await cur.fetchone())[0]
        await conn.execute("SELECT pg_notify('run_events', %s)", (run_id,))
        return seq


async def events(run_id: str, after_seq: int = 0) -> list[dict]:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT seq, kind, payload, feedback, created_at FROM run_events WHERE run_id=%s AND seq>%s ORDER BY seq",
            (run_id, after_seq))
        rows = await cur.fetchall()
    return [{"seq": s, "kind": k, "payload": p, "feedback": f, "at": t.isoformat()} for s, k, p, f, t in rows]


async def events_of(run_ids: list[str]) -> dict[str, list[dict]]:
    if not run_ids:
        return {}
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, seq, kind, payload, feedback, created_at FROM run_events WHERE run_id = ANY(%s)"
            " ORDER BY run_id, seq", (run_ids,))
        rows = await cur.fetchall()
    out: dict[str, list[dict]] = {}
    for rid, s, k, p, f, t in rows:
        out.setdefault(rid, []).append({"seq": s, "kind": k, "payload": p, "feedback": f, "at": t.isoformat()})
    return out


async def set_step_feedback(run_id: str, seq: int, score: int) -> bool:
    async with db.pool().connection() as conn:
        cur = await conn.execute("UPDATE run_events SET feedback=%s WHERE run_id=%s AND seq=%s", (score or None, run_id, seq))
        return bool(cur.rowcount)


async def stage_payload(run_id: str, stage: str) -> dict | None:
    """最近一条某阶段事件的 payload（详情页取注入的档案、召回结果等）。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT payload FROM run_events WHERE run_id=%s AND kind='stage' AND payload->>'stage'=%s"
            " ORDER BY seq DESC LIMIT 1", (run_id, stage))
        row = await cur.fetchone()
    return row[0] if row else None


# ———————— 聚合 ————————

async def stats(hours: int = 24, env: str | None = None, service: str | None = None) -> dict:
    conds = ["created_at > now() - make_interval(hours => %s)"]
    params: list[Any] = [hours]
    if env:
        conds.append("env=%s"); params.append(env)
    if service:
        conds.append("service=%s"); params.append(service)
    where = " WHERE " + " AND ".join(conds)
    buckets = 24 if hours <= 24 else 36
    async with db.pool().connection() as conn:
        cur = await conn.execute(f"SELECT status, count(*), COALESCE(sum(tokens),0) FROM runs{where} GROUP BY status", params)
        by_status = {s: (n, t) for s, n, t in await cur.fetchall()}
        cur = await conn.execute(
            f"SELECT env, count(*), count(*) FILTER (WHERE status='success'), count(*) FILTER (WHERE status='failed')"
            f" FROM runs{where} GROUP BY env", params)
        by_env = {e: {"runs": n, "success": s, "failed": f} for e, n, s, f in await cur.fetchall()}
        cur = await conn.execute(
            f"SELECT width_bucket(EXTRACT(EPOCH FROM created_at), EXTRACT(EPOCH FROM now() - make_interval(hours => %s)),"
            f" EXTRACT(EPOCH FROM now()), %s) AS b,"
            f" count(*) FILTER (WHERE status='success'), count(*) FILTER (WHERE status='failed'),"
            f" count(*) FILTER (WHERE status NOT IN ('success','failed'))"
            f" FROM runs{where} GROUP BY b ORDER BY b", [hours, buckets, *params])
        series_rows = {b: (s, f, o) for b, s, f, o in await cur.fetchall()}
        cur = await conn.execute(
            f"SELECT split_part(task, ':', 1), service, count(*),"
            f" (array_agg(COALESCE(output->>'error', '') ORDER BY created_at DESC))[1]"
            f" FROM runs{where} AND status='failed' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 5", params)
        failures = [{"task": t, "service": s, "failed": n, "last_error": (e or "")[:300]} for t, s, n, e in await cur.fetchall()]
        cur = await conn.execute(
            "SELECT count(*) FILTER (WHERE status='running'), (SELECT count(*) FROM approvals WHERE status='pending')"
            " FROM runs WHERE status='running'" + (" AND env=%s" if env else ""), [env] if env else [])
        running, awaiting = await cur.fetchone()
        cur = await conn.execute("SELECT now()")
        now = (await cur.fetchone())[0]
    from datetime import timedelta
    step = timedelta(hours=hours) / buckets
    start = now - timedelta(hours=hours)
    series = []
    for i in range(1, buckets + 1):
        s, f, o = series_rows.get(i, (0, 0, 0))
        series.append({"t": (start + step * (i - 1)).isoformat(), "success": s, "failed": f, "other": o})
    total = sum(n for n, _ in by_status.values())
    return {
        "hours": hours,
        "totals": {"runs": total, "success": by_status.get("success", (0, 0))[0], "failed": by_status.get("failed", (0, 0))[0],
                   "running": running or 0, "awaiting": awaiting or 0},
        "by_env": by_env, "series": series, "top_failures": failures,
        "tokens": sum(t for _, t in by_status.values()),
    }


async def task_stats(hours: int = 24) -> dict[str, dict]:
    """每个任务近 N 小时的统计与最近一次运行。

    同时给两种口径：子任务名自己的（"failure-analysis:asset_a"），和父任务连同全部子任务的
    （键为父任务名，"failure-analysis"）。返回 {name: {"runs", "success", "failed", "p50_ms", "last_run"}}。
    """
    out: dict[str, dict] = {}
    async with db.pool().connection() as conn:
        for key in ("task", "split_part(task, ':', 1)"):
            cur = await conn.execute(
                f"SELECT {key}, count(*), count(*) FILTER (WHERE status='success'),"
                f" count(*) FILTER (WHERE status='failed'), percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)"
                f" FROM runs WHERE created_at > now() - make_interval(hours => %s) GROUP BY 1", (hours,))
            for name, n, s, f, p in await cur.fetchall():
                out[name] = {"runs": n, "success": s, "failed": f, "p50_ms": int(p) if p is not None else None}
            cur = await conn.execute(
                f"SELECT DISTINCT ON ({key}) {key}, run_id, status, created_at FROM runs ORDER BY {key}, created_at DESC")
            for name, run_id, status, at in await cur.fetchall():
                out.setdefault(name, {"runs": 0, "success": 0, "failed": 0, "p50_ms": None})
                out[name]["last_run"] = {"run_id": run_id, "status": status, "created_at": at.isoformat()}
    return out


async def service_health(hours: int = 24) -> dict[tuple[str, str], dict]:
    """(服务, 环境) → 近 N 小时运行/失败 + 最近一次运行。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT service, env, count(*), count(*) FILTER (WHERE status='failed') FROM runs"
            " WHERE service IS NOT NULL AND created_at > now() - make_interval(hours => %s) GROUP BY 1, 2", (hours,))
        counts = {(s, e): (n, f) for s, e, n, f in await cur.fetchall()}
        cur = await conn.execute(
            "SELECT DISTINCT ON (service, env) service, env, run_id, status, created_at FROM runs"
            " WHERE service IS NOT NULL ORDER BY service, env, created_at DESC")
        last = {(s, e): {"run_id": r, "status": st, "created_at": c.isoformat()} for s, e, r, st, c in await cur.fetchall()}
    keys = set(counts) | set(last)
    return {k: {"runs_24h": counts.get(k, (0, 0))[0], "failed_24h": counts.get(k, (0, 0))[1], "last_run": last.get(k)} for k in keys}


async def search(term: str, limit: int = 8) -> list[dict]:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_LIST_COLS} FROM runs WHERE run_id LIKE %s OR summary ILIKE %s ORDER BY created_at DESC LIMIT %s",
            (term + "%", "%" + term + "%", limit))
        return [_list_row(r) for r in await cur.fetchall()]


async def stale_running(older_than_s: int) -> list[str]:
    """长时间停在 running 却没有任何新事件的运行（worker 崩溃遗留），启动对账用。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT r.run_id FROM runs r WHERE r.status IN ('running','queued')"
            " AND COALESCE((SELECT max(created_at) FROM run_events e WHERE e.run_id=r.run_id), r.created_at)"
            "   < now() - make_interval(secs => %s)", (older_than_s,))
        return [r[0] for r in await cur.fetchall()]
