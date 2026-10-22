"""定时触发：任务上的 schedule 触发器 × 环境，进程内按 cron 触发（替代 Temporal Schedule）。

每 20 秒看一眼：上一次看之后到现在之间该触发的，各提交一次运行。
- 不重复：每次触发带幂等键 schedule:<任务>:<触发器>:<环境>:<计划时间>，worker 重启或多个 worker 同时在跑都只会建一条
- 不重叠：同一个触发器在同一环境上一次还没跑完（排队 / 运行中），这次跳过
- 停机期间错过的不补（启动时只回看 90 秒，覆盖重启间隙）

什么时候不触发：任务（或父任务）停用、触发器停用、任务不允许该环境、服务停用或服务在该环境停用。
子任务只有自己声明了 triggers 才有自己的定时——否则每个子任务都会继承父任务的定时，重复触发。
定义改了不用通知谁：每轮都读最新定义（定义缓存最多 5 秒）。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from ..domain import Rejected, RunRequest, RunTrigger, TaskDef
from ..domain.cron import next_fire
from ..registry import Registry
from ..store import runs

log = logging.getLogger(__name__)

TICK_S = 20.0
LOOKBACK_S = 90


@dataclass(frozen=True)
class Fire:
    task: str
    trigger_id: str
    env: str
    cron: str
    timezone: str
    service: str | None


class Scheduler:
    def __init__(self, registry: Registry, submitter=None):
        self._reg = registry
        self._submitter = submitter

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

    async def run_forever(self) -> None:
        since = datetime.now(timezone.utc) - timedelta(seconds=LOOKBACK_S)
        while True:
            now = datetime.now(timezone.utc)
            try:
                await self.tick(since, now)
            except Exception:  # noqa: BLE001 —— 下一轮再来
                log.exception("定时触发检查失败")
            since = now
            await asyncio.sleep(TICK_S)

    async def tick(self, since: datetime, until: datetime) -> int:
        """(since, until] 之间该触发的都提交，返回提交数。"""
        fired = 0
        for f in await self.wanted():
            at = next_fire(f.cron, f.timezone, since)
            while at is not None and at <= until:
                fired += await self._fire(f, at)
                at = next_fire(f.cron, f.timezone, at)
        return fired

    async def _fire(self, f: Fire, at: datetime) -> int:
        if busy := await runs.active_of_trigger(f.task, f.trigger_id, f.env):
            log.info("定时 %s/%s@%s 上一次（%s）还没跑完，跳过 %s", f.task, f.trigger_id, f.env, busy, at.isoformat())
            return 0
        entry = await self._reg.task(f.task)
        trigger = entry.spec.trigger(f.trigger_id) if entry else None
        if trigger is None or trigger.type != "schedule":
            return 0
        base, _, obj = f.task.partition(":")
        req = RunRequest(task=base, subtask=obj or None, env=f.env, input=trigger.input,
                         service=trigger.service if entry.spec.service == "*" else None)
        key = f"schedule:{f.task}:{f.trigger_id}:{f.env}:{at.astimezone(timezone.utc).isoformat()}"
        try:
            accepted = await self._submitter.submit(
                req, trigger=RunTrigger(type="schedule", id=f.trigger_id, caller="schedule"), idempotency_key=key)
        except Rejected as e:
            log.warning("定时触发 %s/%s@%s 被拒：%s（%s）", f.task, f.trigger_id, f.env, e.message, e.code)
            return 0
        return 0 if accepted.dedup else 1

    async def upcoming(self, limit: int | None = None) -> list[dict]:
        """接下来的触发（按 cron 算）：[{task, trigger_id, service, env, at}]，按时间排序。"""
        now = datetime.now(timezone.utc)
        out = []
        for f in await self.wanted():
            at = next_fire(f.cron, f.timezone, now)
            if at:
                out.append({"task": f.task, "trigger_id": f.trigger_id, "service": f.service, "env": f.env,
                            "at": at.isoformat()})
        out.sort(key=lambda x: x["at"])
        return out[:limit] if limit else out
