"""后台维护：周期性地把"到时间了的事"办掉。随 worker 进程运行。

- 每分钟：到期的审批单标为过期（提交审批过期 → 运行记为取消）；租约到期的进程停掉并通知
- 每 5 分钟：定时触发与定义对账（定义改动时已即时同步，这里兜底）
- 启动时：台账里"运行中"但 Temporal 已不在跑的运行标为失败（可续跑）
"""

from __future__ import annotations

import asyncio
import logging

from ..notify import Message, Notifier
from ..services.control import ProcessController
from ..store import approvals as approvals_store
from ..store import runs
from .scheduler import Scheduler
from .submitter import Submitter

log = logging.getLogger(__name__)


class Maintenance:
    def __init__(self, temporal, submitter: Submitter, scheduler: Scheduler, controller: ProcessController,
                 notifier: Notifier):
        self._temporal = temporal
        self._submitter = submitter
        self._scheduler = scheduler
        self._controller = controller
        self._notifier = notifier

    async def run_forever(self) -> None:
        await self._recover_orphans()
        tick = 0
        while True:
            for job in (self._expire_approvals, self._expire_leases):
                await self._safely(job)
            if tick % 5 == 0:
                await self._safely(self._scheduler.sync)
            tick += 1
            await asyncio.sleep(60)

    async def _safely(self, job) -> None:
        try:
            await job()
        except Exception:
            log.exception("维护任务 %s 失败", getattr(job, "__name__", job))

    async def _expire_approvals(self) -> None:
        for a in await approvals_store.expire_overdue():
            if a["kind"] == "submit":
                await self._submitter.on_submit_decision(a)

    async def _expire_leases(self) -> None:
        for inst in await self._controller.sweep():
            await self._notifier.emit(
                "process_stopped",
                Message(title=f"进程租约到期已停止：{inst['service']}/{inst['process']}@{inst['env']}",
                        text="需要继续用的话在控制台重新启动或调大租约。",
                        link=self._notifier.link(f"/services/{inst['service']}?tab=processes")),
                service=inst["service"], env=inst["env"])

    async def _recover_orphans(self) -> None:
        """台账说在运行、Temporal 却没有在跑的（worker 崩溃、Temporal 数据丢失），标为失败。"""
        from temporalio.client import WorkflowExecutionStatus

        for run_id in await runs.stale_running(1800):
            try:
                desc = await self._temporal.get_workflow_handle(run_id).describe()
                if desc.status == WorkflowExecutionStatus.RUNNING:
                    continue
            except Exception:  # noqa: BLE001 —— 查不到 workflow 就是遗留
                pass
            await runs.log_event(run_id, "error", {"title": "orphaned", "content": "执行进程中断，可在详情页续跑"})
            await runs.set_status(run_id, "failed", output={"error": "执行进程中断"}, error_code="orphaned")
