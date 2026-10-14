"""runs / run_events：执行台账。

session_id 是会话唯一标识（LangGraph thread 是它的实现细节，不出 engine 层）。
run 状态机：queued → running → success / failed。

caller 约定（粒度总则见设计文档 §3.0）：caller 记「身份」、trigger_source
记「来源通道」，两列各管一件事。caller 永不为空——调用方没给身份时在本
模块漏斗里回退为 trigger_source（调度跑的 caller 就是 "schedule"），
审计查询不需要 COALESCE。有身份时调用方给纯身份（服务名/用户名），
不要在 caller 里重复来源前缀。
"""
from __future__ import annotations

import json
from datetime import datetime

from . import db


async def create(run_id: str, task_type: str, role: str, domain: str | None,
                 trigger_source: str, caller: str, input_data: dict,
                 dedup_key: str = "", session_id: str | None = None,
                 target_env: str = "") -> None:
    # 唯一建行漏斗：身份缺失回退来源通道，保证 caller 非空
    caller = (caller or "").strip() or trigger_source
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


_IDEM_PREFIX = "idem:"
_IDEM_WINDOW_S = 86400  # 幂等键 24h 有效（Stripe 同款窗口）


def idempotency_dedup_key(key: str) -> str:
    """调用方幂等键 → dedup_key 列的存储形态（复用 idx_runs_dedup 索引）。"""
    return f"{_IDEM_PREFIX}{key}"


async def find_by_idempotency(key: str) -> dict | None:
    """幂等键查重：命中排队/运行中/成功的 run。

    与任务级 dedup 的差异：提交重试场景要拦住"第一个 run 还在跑"的
    重复提交，所以非终态也命中；失败的 run 允许同键重提（修正后重试是
    合理用法，Stripe 幂等键同款语义）。
    """
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM runs WHERE dedup_key = %s"
            " AND status IN ('queued','running','success')"
            " AND created_at > now() - make_interval(secs => %s)"
            " ORDER BY created_at DESC LIMIT 1",
            (idempotency_dedup_key(key), _IDEM_WINDOW_S))
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


# 允许排序的列 → SQL 表达式（duration/tokens 可能 NULL，COALESCE 垫底）
_SORTS = {"created_at": "created_at", "duration_ms": "COALESCE(duration_ms,-1)",
          "tokens": "COALESCE(tokens,-1)"}

_LIST_COLS = ("run_id, session_id, task_type, role, domain, target_env,"
              " status, trigger_source, caller, tokens, duration_ms,"
              " created_at")


async def list_filtered(*, target_env: str | None = None,
                        status: str | None = None, domain: str | None = None,
                        task: str | None = None, source: str | None = None,
                        q: str | None = None, hours: int | None = None,
                        sort: str = "created_at", asc: bool = False,
                        after: str | None = None, before: str | None = None,
                        limit: int = 50) -> tuple[list[dict], int, str | None,
                                                  str | None]:
    """Runs 列表页查询：显式过滤 + keyset 双向翻页 + 同条件总数。

    返回 (rows, total, next_cursor, prev_cursor)。keyset 而非 OFFSET：
    runs 持续追加，OFFSET 深翻页会漏/重行。光标 = 排序值|created_at|run_id
    （后两者决胜保证稳定序），after=下一页 / before=上一页。
    """
    sortcol = _SORTS.get(sort, "created_at")
    conds: list[str] = []
    params: list = []
    for clause, val in (("target_env=%s", target_env), ("status=%s", status),
                        ("domain=%s", domain), ("task_type=%s", task),
                        ("trigger_source=%s", source)):
        if val:
            conds.append(clause)
            params.append(val)
    if hours:
        conds.append("created_at > now() - make_interval(hours => %s)")
        params.append(hours)
    if q:
        conds.append("(run_id ILIKE %s OR input->>'question' ILIKE %s)")
        params += [q + "%", "%" + q + "%"]
    where = (" WHERE " + " AND ".join(conds)) if conds else ""

    async with db.pool().connection() as conn:
        cur = await conn.execute("SELECT count(*) FROM runs" + where, params)
        total = (await cur.fetchone())[0]

        page_conds, page_params = list(conds), list(params)
        cursor = after or before
        going_forward = before is None       # before=翻回上一页：反向取再翻转
        natural_desc = not asc               # 排序方向（默认 desc）
        if cursor:
            # 手改 URL 的光标不送到 PG（cast 失败是 500）：格式不对就 400
            parts = cursor.split("|", 2)
            if len(parts) != 3:
                raise ValueError("非法分页光标")
            sv, ts, rid = parts
            try:
                datetime.fromisoformat(ts)
            except ValueError:
                raise ValueError("非法分页光标（时间戳无法解析）") from None
            # 取「更大」还是「更小」由 排序方向×翻页方向 共同决定：
            # after 沿排序方向继续（desc 取更小），before 取另一侧
            take_gt = (asc == going_forward)
            op = ">" if take_gt else "<"
            page_conds.append(f"({sortcol}, created_at, run_id) {op}"
                              " (%s, %s::timestamptz, %s)")
            page_params += [sv, ts, rid]
        pwhere = (" WHERE " + " AND ".join(page_conds)) if page_conds else ""
        order = "DESC" if natural_desc == going_forward else "ASC"
        cur = await conn.execute(
            f"SELECT {_LIST_COLS} FROM runs{pwhere}"
            f" ORDER BY {sortcol} {order}, created_at {order}, run_id {order}"
            " LIMIT %s", (*page_params, limit + 1))
        rows = await cur.fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    if not going_forward:
        rows.reverse()

    def _cursor(r) -> str:
        sv = {"duration_ms": r[10], "tokens": r[9]}.get(sort)
        if sv is None:  # NULL 与 COALESCE 对齐；created_at 用 isoformat
            sv = -1 if sort in ("duration_ms", "tokens") else r[11].isoformat()
        return f"{sv}|{r[11].isoformat()}|{r[0]}"

    next_c = prev_c = None
    if rows:
        if going_forward:
            next_c = _cursor(rows[-1]) if has_more else None
            prev_c = _cursor(rows[0]) if (after or before) else None
        else:
            prev_c = _cursor(rows[0]) if has_more else None
            next_c = _cursor(rows[-1])
    return ([_list_row(r) for r in rows], total, next_c, prev_c)


def _list_row(r) -> dict:
    return {"run_id": r[0], "session_id": r[1], "task_type": r[2],
            "role": r[3], "domain": r[4], "target_env": r[5], "status": r[6],
            "trigger_source": r[7], "caller": r[8], "tokens": r[9],
            "duration_ms": r[10], "created_at": r[11].isoformat()}


async def list_recent(target_env: str | None = None, limit: int = 100) -> list[dict]:
    """最近 run 概要（总览面板/API）；列表页请用 list_filtered。"""
    rows, _, _, _ = await list_filtered(target_env=target_env, limit=limit)
    return rows


async def session_exists(session_id: str) -> bool:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM runs WHERE session_id = %s LIMIT 1", (session_id,))
        return await cur.fetchone() is not None


async def list_sessions(limit: int = 30) -> list[dict]:
    """最近 web 会话（按最后活动倒序）：预览取会话内第一个问题。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT session_id,"
            " max(created_at) AS last_at, count(*) AS runs,"
            " (array_agg(input->>'question' ORDER BY created_at))[1] AS first_q,"
            " (array_agg(role ORDER BY created_at DESC))[1] AS role,"
            " (array_agg(domain ORDER BY created_at DESC))[1] AS domain,"
            " (array_agg(target_env ORDER BY created_at DESC))[1] AS env"
            " FROM runs WHERE trigger_source = 'web_chat'"
            " GROUP BY session_id ORDER BY last_at DESC LIMIT %s", (limit,))
        rows = await cur.fetchall()
    return [{"session_id": r[0], "last_at": r[1].isoformat(), "runs": r[2],
             "first_q": r[3] or "", "role": r[4], "domain": r[5], "env": r[6]}
            for r in rows]


async def of_session(session_id: str) -> list[dict]:
    """会话全部 run（正序）：对话页历史回放用。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, role, domain, target_env, status, input, output,"
            " created_at FROM runs WHERE session_id = %s"
            " ORDER BY created_at", (session_id,))
        rows = await cur.fetchall()
    return [{"run_id": r[0], "role": r[1], "domain": r[2], "target_env": r[3],
             "status": r[4], "input": r[5], "output": r[6],
             "created_at": r[7].isoformat()} for r in rows]


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


async def get_events(run_id: str, after_seq: int = -1) -> list[dict]:
    """run 的事件流。after_seq 推进 SQL：SSE/详情页按 seq 增量轮询，
    全量拉取再内存过滤会让长 run 的轮询总量变成 O(N²)。

    默认 -1 = 全量：log_event 的 seq 从 1 起，但直插/种子里存在 seq=0
    的事件（如 trace），过滤条件必须写成 seq > after_seq 且默认 -1，
    调用方传 0 会恰好丢掉 seq=0。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT seq, kind, payload, created_at FROM run_events"
            " WHERE run_id = %s AND seq > %s ORDER BY seq",
            (run_id, after_seq))
        rows = await cur.fetchall()
    return [{"seq": r[0], "kind": r[1], "payload": r[2],
             "created_at": r[3].isoformat()} for r in rows]


async def get_graph_event(run_id: str) -> dict | None:
    """资产图 run 的最新拓扑事件（详情页每轮都要，与事件增量拉取解耦）。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT payload FROM run_events WHERE run_id = %s AND kind = 'graph'"
            " ORDER BY seq DESC LIMIT 1", (run_id,))
        row = await cur.fetchone()
    return row[0] if row and isinstance(row[0], dict) else None


async def events_of_runs(run_ids: list[str]) -> dict[str, list[dict]]:
    """批量取多个 run 的事件（会话历史回放）：一次查询，按 run 分组。
    逐 run 调 get_events 是 N+1。"""
    if not run_ids:
        return {}
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT run_id, seq, kind, payload, created_at FROM run_events"
            " WHERE run_id = ANY(%s) ORDER BY run_id, seq", (run_ids,))
        rows = await cur.fetchall()
    out: dict[str, list[dict]] = {}
    for rid, seq, kind, payload, created in rows:
        out.setdefault(rid, []).append(
            {"seq": seq, "kind": kind, "payload": payload,
             "created_at": created.isoformat()})
    return out


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


async def usage_24h() -> dict:
    """近 24h 各角色/任务的 run 数与成功数——管理页列表的影响面列。

    返回 {"role": {名: {"runs": n, "ok": n}}, "task": {...}}。
    """
    out = {"role": {}, "task": {}}
    async with db.pool().connection() as conn:
        for col, key in (("role", "role"), ("task_type", "task")):
            cur = await conn.execute(
                f"SELECT {col}, count(*),"
                f" count(*) FILTER (WHERE status='success') FROM runs"
                f" WHERE created_at > now() - interval '24 hours'"
                f" GROUP BY {col}")
            out[key] = {name: {"runs": n, "ok": ok}
                        for name, n, ok in await cur.fetchall()}
    return out


async def trace_id_of(run_id: str) -> str:
    """从台账事件取 Langfuse trace_id（未启用观测时为空串）。"""
    events = await get_events(run_id)
    return next((e["payload"].get("trace_id") for e in events
                 if e["kind"] == "trace" and isinstance(e["payload"], dict)), "")


async def overview(hours: int = 24) -> dict:
    """总览页聚合：近 N 小时状态计数 + 任务分布 + 最近失败 5 条。"""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT status, count(*) FROM runs"
            " WHERE created_at > now() - make_interval(hours => %s)"
            " GROUP BY status", (hours,))
        by_status = dict(await cur.fetchall())
        cur = await conn.execute(
            "SELECT task_type, count(*),"
            " count(*) FILTER (WHERE status='success'),"
            " count(*) FILTER (WHERE status='failed')"
            " FROM runs WHERE created_at > now() - make_interval(hours => %s)"
            " GROUP BY task_type ORDER BY count(*) DESC LIMIT 8", (hours,))
        tasks = [{"task_type": r[0], "total": r[1], "success": r[2],
                  "failed": r[3]} for r in await cur.fetchall()]
        cur = await conn.execute(
            "SELECT run_id, task_type, role, target_env, created_at FROM runs"
            " WHERE status='failed' ORDER BY created_at DESC LIMIT 5")
        failed = [{"run_id": r[0], "task_type": r[1], "role": r[2],
                   "target_env": r[3], "created_at": r[4].isoformat()}
                  for r in await cur.fetchall()]
    return {"by_status": by_status, "tasks": tasks, "failed": failed,
            "hours": hours}


def _row_to_dict(cur, row) -> dict:
    return {d.name: v for d, v in zip(cur.description, row)}
