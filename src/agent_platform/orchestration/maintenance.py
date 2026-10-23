"""后台维护：周期性地把"到时间了的事"办掉。随 worker 进程运行，每分钟一轮。

- 心跳停了的运行（执行进程崩溃 / 被杀）标为失败，详情页可续跑
- 租约到期的进程停掉并通知
- 每 6 小时按保留期清一次数据（过程事件、会话 checkpoint、召回埋点；部署配置 retention）
"""

from __future__ import annotations

import asyncio
import logging
import time

from ..config import RetentionConfig
from ..notify import Message, Notifier
from ..services.control import ProcessController
from ..store import retention
from ..store import runs

log = logging.getLogger(__name__)

ORPHAN_AFTER_S = 120          # 心跳每 20 秒一次，2 分钟没动静就是执行进程没了
PURGE_EVERY_S = 6 * 3600


class Maintenance:
    def __init__(self, controller: ProcessController, notifier: Notifier, keep: RetentionConfig | None = None):
        self._controller = controller
        self._notifier = notifier
        self._keep = keep or RetentionConfig()
        self._purged_at = 0.0

    async def run_forever(self) -> None:
        while True:
            for job in (self._recover_orphans, self._expire_leases, self._purge):
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

    async def _expire_leases(self) -> None:
        for inst in await self._controller.sweep():
            await self._notifier.emit(
                "process_stopped",
                Message(title=f"进程租约到期已停止：{inst['service']}/{inst['process']}@{inst['env']}",
                        text="需要继续用的话在控制台重新启动或调大租约。",
                        link=self._notifier.link(f"/services/{inst['service']}?tab=processes")),
                service=inst["service"], env=inst["env"])

    async def _purge(self) -> None:
        if time.monotonic() - self._purged_at < PURGE_EVERY_S and self._purged_at:
            return
        self._purged_at = time.monotonic()
        k = self._keep
        events = await retention.purge_run_events(k.run_events_days)
        checkpoints = await retention.purge_checkpoints(k.checkpoints_days)
        hits = await retention.purge_recall_hits(k.recall_hits_days)
        if events or checkpoints or hits:
            log.info("数据保留：清理过程事件 %d 条、checkpoint %d 行、召回埋点 %d 条", events, checkpoints, hits)
