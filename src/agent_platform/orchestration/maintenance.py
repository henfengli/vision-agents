"""后台维护：周期性地把"到时间了的事"办掉。随 worker 进程运行，每分钟一轮。每台主机各跑一份，都是幂等的。

- 心跳停了的运行（执行进程崩溃 / 被杀，不论在哪台主机）标为失败，详情页可续跑
- 每 6 小时按保留期清一次数据（过程事件、会话 checkpoint、召回埋点；部署配置 retention）和本机的工作目录
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time

from ..config import Settings
from ..store import retention, runs

log = logging.getLogger(__name__)

ORPHAN_AFTER_S = 120          # 心跳每 20 秒一次，2 分钟没动静就是执行进程没了
PURGE_EVERY_S = 6 * 3600


class Maintenance:
    def __init__(self, settings: Settings):
        self._s = settings
        self._purged_at = 0.0

    async def run_forever(self) -> None:
        while True:
            for job in (self._recover_orphans, self._purge):
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

    async def _purge(self) -> None:
        if time.monotonic() - self._purged_at < PURGE_EVERY_S and self._purged_at:
            return
        self._purged_at = time.monotonic()
        k = self._s.retention
        events = await retention.purge_run_events(k.run_events_days)
        checkpoints = await retention.purge_checkpoints(k.checkpoints_days)
        hits = await retention.purge_recall_hits(k.recall_hits_days)
        files = await asyncio.to_thread(purge_dir, self._s.scratch_dir, k.scratch_days)
        if events or checkpoints or hits or files:
            log.info("数据保留：清理过程事件 %d 条、checkpoint %d 行、召回埋点 %d 条、工作目录 %d 项",
                     events, checkpoints, hits, files)


def purge_dir(root: str, days: int) -> int:
    """工作目录里超过 days 天没动过的文件和目录删掉（queries/<run_id>/ 按目录算）。→ 删掉的项数。"""
    if days <= 0 or not os.path.isdir(root):
        return 0
    cutoff = time.time() - days * 86400
    removed = 0
    for top in os.scandir(root):
        entries = list(os.scandir(top.path)) if top.is_dir() and top.name == "queries" else [top]
        for e in entries:
            try:
                if e.stat(follow_symlinks=False).st_mtime >= cutoff:
                    continue
                if e.is_dir(follow_symlinks=False):
                    shutil.rmtree(e.path)
                else:
                    os.remove(e.path)
                removed += 1
            except OSError:
                log.warning("清理工作目录失败：%s", e.path, exc_info=True)
    return removed
