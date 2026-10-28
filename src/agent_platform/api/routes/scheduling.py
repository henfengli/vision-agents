"""调度的可见面：触发记录、执行主机与排队情况。

    GET /v1/ticks?task=&kind=&outcome=&env=&hours=&before=&limit=   触发记录（新的在前；before = 翻页用的 id）
    GET /v1/workers                                                   执行主机（在线 / 离线）+ 排队情况
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected
from ...store import runs, ticks, workers
from ..deps import RT, WHO, Caller, Runtime

router = APIRouter(prefix="/v1")


@router.get("/ticks")
async def list_ticks(task: str | None = None, kind: str | None = None, outcome: str | None = None,
                     env: str | None = None, hours: int | None = None, before: int | None = None, limit: int = 100,
                     _: Caller = WHO):
    if kind and kind not in ticks.KINDS:
        raise Rejected("invalid_request", f"kind 只能是 {'、'.join(ticks.KINDS)}", 422)
    if outcome and outcome not in ticks.OUTCOMES:
        raise Rejected("invalid_request", f"outcome 只能是 {'、'.join(ticks.OUTCOMES)}", 422)
    items = await ticks.list_ticks(task=task, kind=kind, outcome=outcome, env=env, hours=hours, before=before,
                                   limit=limit)
    return {"items": items, "next_before": items[-1]["id"] if len(items) >= max(1, min(limit, 500)) else None}


@router.get("/workers")
async def list_workers(rt: Runtime = RT, _: Caller = WHO):
    """主机列表 + 排队情况；每组排队的运行标出有没有在线的主机负责（没有 = 运行会一直排着）。"""
    hosts = await workers.list_workers()
    queue = await runs.queue_summary()
    for g in queue["groups"]:
        g["served"] = bool(workers.serving(hosts, g["env"], g["service"]))
    return {"workers": hosts, "queue": queue, "queued_alert_s": rt.settings.worker.queued_alert_s}
