"""定时触发：任务上的 schedule 触发器 × 环境，进程内按 cron 触发。

每 20 秒看一眼：上一次看之后到现在之间该触发的，各提交一次运行。
- 不重复：每次触发带幂等键 schedule:<任务>:<触发器>:<环境>:<计划时间>，worker 重启或多个 worker 同时在跑都只会建一条
- 不重叠：同一个触发器在同一环境上一次还没跑完（排队 / 运行中），这次跳过
- 停机期间错过的不补（启动时只回看 90 秒，覆盖重启间隙）
- 每次判定（建了 / 跳过 / 被拒）写一条触发记录（store/ticks），控制台看得到"为什么没跑"
- 同一个循环里顺带做自动重试：失败后定好了 retry_at 的运行，到点续跑

什么时候不触发：任务（或父任务）停用、触发器停用、任务不允许该环境、服务停用或服务在该环境停用。
子任务只有自己声明了 triggers 才有自己的定时——否则每个子任务都会继承父任务的定时，重复触发。
定义改了不用通知谁：每轮都读最新定义（定义缓存最多 5 秒）。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from ..domain import Caller, Rejected, RunRequest, RunTrigger, TaskDef
from ..domain.cron import next_fire
from ..registry import Registry
from ..store import runs, ticks

log = logging.getLogger(__name__)

TICK_S = 20.0
LOOKBACK_S = 90
RETRY = Caller(name="retry", kind="system")


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
        # 自动重试没能开始时按最终失败收尾（通知、投递、联动）：runtime 接上 Pipeline.settle_failed
        self.settle_failed: Callable[[str], Awaitable[None]] | None = None

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
            try:
                await self.retry_due()
            except Exception:  # noqa: BLE001
                log.exception("自动重试检查失败")
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
        key = f"schedule:{f.task}:{f.trigger_id}:{f.env}:{at.astimezone(timezone.utc).isoformat()}"
        common = {"kind": "schedule", "task": f.task, "trigger_id": f.trigger_id, "env": f.env, "key": key,
                  "detail": {"planned_at": at.isoformat()}}
        if busy := await runs.active_of_trigger(f.task, f.trigger_id, f.env):
            log.info("定时 %s/%s@%s 上一次（%s）还没跑完，跳过 %s", f.task, f.trigger_id, f.env, busy, at.isoformat())
            await ticks.record(outcome="skipped", run_id=busy, reason=f"上一次（{busy[:8]}）还没跑完，这次跳过", **common)
            return 0
        entry = await self._reg.task(f.task)
        trigger = entry.spec.trigger(f.trigger_id) if entry else None
        if trigger is None or trigger.type != "schedule":
            return 0
        base, _, obj = f.task.partition(":")
        req = RunRequest(task=base, subtask=obj or None, env=f.env, input=trigger.input,
                         service=trigger.service if entry.spec.service == "*" else None)
        try:
            accepted = await self._submitter.submit(
                req, trigger=RunTrigger(type="schedule", id=f.trigger_id, caller="schedule"), idempotency_key=key)
        except Rejected as e:
            log.warning("定时触发 %s/%s@%s 被拒：%s（%s）", f.task, f.trigger_id, f.env, e.message, e.code)
            await ticks.record(outcome="rejected", reason=e.message, **{**common, "detail": {**common["detail"], "code": e.code}})
            return 0
        if accepted.dedup:
            # 别的主机已经按这个时刻建过了（幂等键命中）：触发记录那台记过，这里不再记
            return 0
        await ticks.record(outcome="fired", run_id=accepted.run_id, reason=f"按 {f.cron} 到点", **common)
        return 1

    # —— 自动重试 ——

    async def retry_due(self) -> int:
        """到点的自动重试：领走（几台主机只有一台拿到；领走 = 把 retry_at 往后推当租约）→ 续跑。
        - 服务在这个环境暂停了自动触发：顺延，不开始（维护窗口过了再跑）
        - 开始不了（任务停用了、会话里有别的轮在跑…）：取消重试、按最终失败收尾。重试已经被人取消了的不再收一次
        - 其他异常（库连不上…）：留着租约，到期后再领；一条出错不耽误同一批别的"""
        started = 0
        for run_id in await runs.claim_due_retries():
            try:
                started += await self._retry_one(run_id)
            except Exception:  # noqa: BLE001
                log.exception("自动重试 %s 没能开始，租约到期后再试", run_id)
        return started

    async def _retry_one(self, run_id: str) -> int:
        run = await runs.get(run_id)
        if run is None or run["status"] != "failed" or not run.get("retry_at"):
            return 0
        common = {"kind": "retry", "task": run["task"], "env": run["env"], "source": run_id, "run_id": run_id}
        if run["service"] and (svc := await self._reg.service(run["service"])) is not None \
                and svc.spec.view(run["service"], run["env"]).triggers_paused:
            await runs.postpone_retry(run_id, runs.RETRY_LEASE_S)
            await ticks.record(outcome="skipped", reason=f"服务 {run['service']} 在 {run['env']} 暂停了自动触发，重试顺延",
                               **common)
            return 0
        try:
            await self._submitter.resume(run_id, RETRY, auto=True)
        except Rejected as e:
            # 先把重试取消掉再收尾：取消成功才说明还归这里收（人恰好在这时取消了重试的，取消那边已经收过了）
            if await runs.clear_retry(run_id):
                await runs.log_event(run_id, "stage", {"stage": "retry", "title": "自动重试没能开始", "content": e.message})
                await ticks.record(outcome="rejected", reason=e.message, detail={"code": e.code}, **common)
                if self.settle_failed is not None:
                    await self.settle_failed(run_id)
            return 0
        await ticks.record(outcome="fired", reason=f"第 {run.get('attempt') or 1} 次执行失败后自动重试", **common)
        return 1

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
