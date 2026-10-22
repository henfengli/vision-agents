"""后台维护：周期性地把"到时间了的事"办掉。随 worker 进程运行，每分钟一轮。

- 心跳停了的运行（执行进程崩溃 / 被杀）标为失败，详情页可续跑
- 到期的审批单标为过期（等待中的运行自己会醒来按拒绝处理）
- 租约到期的进程停掉并通知
"""

from __future__ import annotations

import asyncio
import logging

from ..notify import Message, Notifier
from ..services.control import ProcessController
from ..store import approvals as approvals_store
from ..store import runs

log = logging.getLogger(__name__)

ORPHAN_AFTER_S = 120          # 心跳每 20 秒一次，2 分钟没动静就是执行进程没了


class Maintenance:
    def __init__(self, controller: ProcessController, notifier: Notifier):
        self._controller = controller
        self._notifier = notifier

    async def run_forever(self) -> None:
        while True:
            for job in (self._recover_orphans, self._expire_approvals, self._expire_leases):
                await self._safely(job)
            await asyncio.sleep(60)

    async def _safely(self, job) -> None:
        try:
            await job()
        except Exception:  # noqa: BLE001 —— 一项失败不影响其余，下一轮再来
            log.exception("维护任务 %s 失败", getattr(job, "__name__", job))

    async def _recover_orphans(self) -> None:
        for run_id in await runs.orphaned(ORPHAN_AFTER_S):
            await runs.log_event(run_id, "error", {"title": "orphaned", "content": "执行进程中断，可在详情页续跑"})
            await runs.set_status(run_id, "failed", output={"error": "执行进程中断"}, error_code="orphaned")

    async def _expire_approvals(self) -> None:
        await approvals_store.expire_overdue()

    async def _expire_leases(self) -> None:
        for inst in await self._controller.sweep():
            await self._notifier.emit(
                "process_stopped",
                Message(title=f"进程租约到期已停止：{inst['service']}/{inst['process']}@{inst['env']}",
                        text="需要继续用的话在控制台重新启动或调大租约。",
                        link=self._notifier.link(f"/services/{inst['service']}?tab=processes")),
                service=inst["service"], env=inst["env"])
