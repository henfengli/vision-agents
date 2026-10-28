"""触发记录（trigger_ticks）：定时、事件、上游联动、自动重试每做一次判定记一条——建了哪条运行，或者为什么没建。

控制台据此回答「昨晚的巡检为什么没跑」「Dagster 推过来了，为什么没有任务接」。
同一次判定在几台主机上都会做（定时各台都按同一个时刻判）：带 key 的只留第一条。
"""

from __future__ import annotations

import json
from typing import Any

from . import db

KINDS = ("schedule", "event", "after", "retry")
# fired 建了运行 / deduped 命中去重或幂等（返回已有运行） / skipped 上一次还没跑完等 / filtered 过滤条件不满足 /
# waiting 联动在等其它上游 / rejected 被闸门或校验拒了 / unmatched 事件没有任务接
OUTCOMES = ("fired", "deduped", "skipped", "filtered", "waiting", "rejected", "unmatched")


async def record(kind: str, outcome: str, *, task: str | None = None, trigger_id: str | None = None,
                 env: str | None = None, source: str | None = None, run_id: str | None = None, reason: str = "",
                 detail: dict | None = None, key: str | None = None) -> None:
    """记一条；记失败不影响触发本身（只是少一条记录）。"""
    try:
        async with db.pool().connection() as conn:
            await conn.execute(
                "INSERT INTO trigger_ticks (kind, outcome, task, trigger_id, env, source, run_id, reason, detail, key)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (kind, outcome, task, trigger_id, env, source, run_id, reason[:1000],
                 json.dumps(detail, ensure_ascii=False, default=str) if detail else None, key))
    except Exception:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning("触发记录写入失败：%s %s %s", kind, outcome, task, exc_info=True)


async def list_ticks(*, task: str | None = None, kind: str | None = None, outcome: str | None = None,
                     env: str | None = None, hours: int | None = None, before: int | None = None,
                     limit: int = 100) -> list[dict[str, Any]]:
    """新的在前。task 写父任务时连同子任务；before：翻页，只取 id 比它小的。"""
    conds, params = [], []
    if task:
        conds.append("(task=%s OR task LIKE %s)")
        params += [task, task + ":%"]
    for clause, val in (("kind=%s", kind), ("outcome=%s", outcome), ("env=%s", env)):
        if val:
            conds.append(clause)
            params.append(val)
    if hours:
        conds.append("at > now() - make_interval(hours => %s)")
        params.append(hours)
    if before:
        conds.append("id < %s")
        params.append(before)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    async with db.pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, at, kind, task, trigger_id, env, source, outcome, run_id, reason, detail FROM trigger_ticks"
            f"{where} ORDER BY id DESC LIMIT %s", (*params, max(1, min(limit, 500))))
        rows = await cur.fetchall()
    return [{"id": r[0], "at": r[1].isoformat(), "kind": r[2], "task": r[3], "trigger_id": r[4], "env": r[5],
             "source": r[6], "outcome": r[7], "run_id": r[8], "reason": r[9], "detail": r[10]} for r in rows]


async def purge(days: int) -> int:
    if days <= 0:
        return 0
    async with db.pool().connection() as conn:
        cur = await conn.execute("DELETE FROM trigger_ticks WHERE at < now() - make_interval(days => %s)", (days,))
        return cur.rowcount or 0
