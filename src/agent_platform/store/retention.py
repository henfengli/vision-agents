"""数据保留：按天数清理会无限增长、过期后没用的数据。维护循环每 6 小时调一次（orchestration/maintenance.py）。

- run_events     运行的过程事件。运行台账本身（输入、输出、配方、状态）一直保留；被 👎 过的运行的事件不清（回归重放要看）
- checkpoints    LangGraph 的会话 checkpoint（表由 langgraph-checkpoint-postgres 建）：一个 thread（会话×服务×环境）
                 最后一轮结束超过保留期就整串删掉，之后这个会话不能再续跑，新一轮从头开始
- recall_hits    召回埋点
"""

from __future__ import annotations

from . import db

_TERMINAL = "('success','failed','cancelled')"

# thread_id 的拼法与 RunSpec.thread_id 一致：{session_id}@{service 或 -}:{env}
_STALE_THREADS = f"""
SELECT session_id || '@' || COALESCE(service, '-') || ':' || env FROM runs
GROUP BY session_id, service, env
HAVING max(created_at) < now() - make_interval(days => %s) AND bool_and(status IN {_TERMINAL})
"""


async def purge_run_events(days: int) -> int:
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "DELETE FROM run_events e USING runs r WHERE e.run_id = r.run_id"
            f" AND r.created_at < now() - make_interval(days => %s) AND r.status IN {_TERMINAL}"
            " AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.run_id = r.run_id AND f.score < 0)", (days,))
        return cur.rowcount


async def purge_checkpoints(days: int) -> int:
    total = 0
    async with db.pool().connection() as conn:
        for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
            cur = await conn.execute("SELECT to_regclass(%s)", (table,))
            if (await cur.fetchone())[0] is None:
                continue
            cur = await conn.execute(f"DELETE FROM {table} WHERE thread_id IN ({_STALE_THREADS})", (days,))
            total += cur.rowcount
    return total


async def purge_recall_hits(days: int) -> int:
    async with db.pool().connection() as conn:
        cur = await conn.execute("DELETE FROM recall_hits WHERE created_at < now() - make_interval(days => %s)", (days,))
        return cur.rowcount
