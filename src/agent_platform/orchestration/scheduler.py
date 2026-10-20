"""定时触发：任务上的 schedule 触发器 × 环境 → Temporal Schedule，一个组合一个。

Schedule id = run:<任务>:<触发器>:<环境>。sync() 幂等：该有的建/改，多余的删。
定义一改（任务、服务启停、服务的环境开关）就调一次；另有周期对账兜底。

什么时候不建：任务（或父任务）停用、触发器停用、任务不允许该环境、服务停用或服务在该环境停用。
子任务只有自己声明了 triggers 才有自己的定时——否则每个子任务都会继承父任务的定时，重复触发。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from ..domain import TaskDef
from ..domain.cron import next_fire
from ..registry import Registry

log = logging.getLogger(__name__)

PREFIX = "run:"


@dataclass(frozen=True)
class Fire:
    task: str
    trigger_id: str
    env: str
    cron: str
    timezone: str
    service: str | None

    @property
    def schedule_id(self) -> str:
        return f"{PREFIX}{self.task}:{self.trigger_id}:{self.env}"


class Scheduler:
    def __init__(self, client, registry: Registry, task_queue: str):
        self._client = client
        self._reg = registry
        self._queue = task_queue

    async def wanted(self) -> list[Fire]:
        services = {s.name: s.spec for s in await self._reg.services()}
        raw = {t.name: t.spec for t in await self._reg.tasks()}
        out = []
        for name, own in raw.items():
            if own.extends and "triggers" not in own.model_fields_set:
                continue
            entry = await self._reg.task(name)
            task: TaskDef = entry.spec
            parent = raw.get(task.extends) if task.extends else None
            if not task.enabled or (parent is not None and not parent.enabled):
                continue
            for t in task.triggers_of("schedule"):
                service = t.service if task.service == "*" else task.service
                svc = services.get(service) if service else None
                if service and (svc is None or not svc.enabled):
                    continue
                for env in t.envs:
                    if task.allows_env(env) and (svc is None or svc.view(service, env).enabled):
                        out.append(Fire(name, t.id, env, t.cron, t.timezone, service))
        return out

    async def sync(self) -> int:
        from temporalio.client import (
            Schedule,
            ScheduleActionStartWorkflow,
            ScheduleOverlapPolicy,
            SchedulePolicy,
            ScheduleSpec,
            ScheduleUpdate,
        )
        from temporalio.common import WorkflowIDReusePolicy

        from .workflows import ScheduleWorkflow

        wanted = {f.schedule_id: f for f in await self.wanted()}
        existing = set()
        async for s in await self._client.list_schedules():
            if s.id.startswith(PREFIX):
                existing.add(s.id)
        for sid in existing - set(wanted):
            try:
                await self._client.get_schedule_handle(sid).delete()
            except Exception:
                log.exception("删除定时 %s 失败", sid)
        for sid, f in wanted.items():
            schedule = Schedule(
                action=ScheduleActionStartWorkflow(
                    ScheduleWorkflow.run, args=[f.task, f.trigger_id, f.env], id=f"fire:{sid}",
                    task_queue=self._queue, id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE),
                spec=ScheduleSpec(cron_expressions=[f.cron], time_zone_name=f.timezone),
                policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP))      # 上一次还没跑完就跳过这次
            try:
                if sid in existing:
                    await self._client.get_schedule_handle(sid).update(lambda _, s=schedule: ScheduleUpdate(schedule=s))
                else:
                    await self._client.create_schedule(sid, schedule)
            except Exception:
                log.exception("同步定时 %s 失败", sid)
        return len(wanted)

    async def upcoming(self, limit: int | None = None) -> list[dict]:
        """接下来的触发（本地按 cron 算，不问 Temporal）：[{task, trigger_id, service, env, at}]，按时间排序。"""
        now = datetime.now(UTC)
        out = []
        for f in await self.wanted():
            at = next_fire(f.cron, f.timezone, now)
            if at:
                out.append({"task": f.task, "trigger_id": f.trigger_id, "service": f.service, "env": f.env,
                            "at": at.isoformat()})
        out.sort(key=lambda x: x["at"])
        return out[:limit] if limit else out

