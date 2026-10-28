"""后台维护：周期性地把"到时间了的事"办掉。随 worker 进程运行，每分钟一轮。每台主机各跑一份，都是幂等的。

- 心跳停了的运行（执行进程崩溃 / 被杀，不论在哪台主机）标为失败；任务配了自动重试就排上，否则发失败通知、触发联动
- 点名等上游的排队运行：上游已经失败 / 取消了还在排着的（提交端漏处理时兜底）标成 upstream_failed
- 排队太久（部署配置 worker.queued_alert_s）还没被认领的告警一次，说清是不是没有在线的主机负责
- 每 6 小时按保留期清一次数据（过程事件、会话 checkpoint、召回埋点、触发记录、离线很久的主机；部署配置 retention）
  和本机的工作目录
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from typing import Awaitable, Callable

from ..config import Settings
from ..store import retention, runs, ticks, workers

log = logging.getLogger(__name__)

ORPHAN_AFTER_S = 120          # 心跳每 20 秒一次，2 分钟没动静就是执行进程没了
PURGE_EVERY_S = 6 * 3600


class Maintenance:
    def __init__(self, settings: Settings, *, orphaned: Callable[[str], Awaitable[None]] | None = None,
                 notifier=None):
        self._s = settings
        self._purged_at = 0.0
        self._orphaned = orphaned        # Pipeline.orphaned：判成孤儿之后排自动重试或按最终失败收尾
        self._notifier = notifier

    async def run_forever(self) -> None:
        while True:
            for job in (self._recover_orphans, self._upstream_sweep, self._queue_alerts, self._purge):
                await self._safely(job)
            await asyncio.sleep(60)

    async def _safely(self, job) -> None:
        try:
            await job()
        except Exception:  # noqa: BLE001 —— 一项失败不影响其余，下一轮再来
            log.exception("维护任务 %s 失败", getattr(job, "__name__", job))

    async def _recover_orphans(self) -> None:
        for run_id in await runs.fail_orphans(ORPHAN_AFTER_S):
            try:                                     # 一条出错不耽误别的孤儿
                await runs.log_event(run_id, "error", {"title": "orphaned", "content": "执行进程中断，可在详情页续跑"})
                if self._orphaned is not None:
                    await self._orphaned(run_id)
            except Exception:  # noqa: BLE001
                log.exception("孤儿运行 %s 的收尾失败", run_id)

    async def _upstream_sweep(self) -> None:
        for run_id, upstream, status in await runs.blocked_by_upstream():
            reason = f"点名等的上游运行 {upstream[:8]} {'失败' if status == 'failed' else '被取消'}了，这次没有执行"
            for rid in await runs.fail_dependents(upstream, reason):
                await runs.log_event(rid, "error", {"title": "upstream_failed", "content": reason})
            log.info("运行 %s 等的上游 %s 已经 %s，标为 upstream_failed", run_id, upstream, status)

    async def _queue_alerts(self) -> None:
        after = self._s.worker.queued_alert_s
        if after <= 0:
            return
        stuck = await runs.queued_too_long(after)
        if not stuck:
            return
        online = await workers.list_workers()
        for r in stuck:
            hosts = workers.serving(online, r["env"], r["service"])
            where = f"{r['env']}" + (f" / {r['service']}" if r["service"] else "")
            why = (f"没有在线的主机负责 {where}：负责它的 agent 服务可能没在跑" if not hosts
                   else f"负责 {where} 的主机（{'、'.join(h['host'] for h in hosts)}）一直腾不出执行名额")
            text = f"排队超过 {after // 60} 分钟还没开始执行：{why}"
            await runs.log_event(r["run_id"], "stage", {"stage": "queue", "title": "排队太久", "content": text})
            if self._notifier is not None:
                from ..notify import Message
                await self._notifier.emit("run_queued_long", Message(
                    title=f"排队太久：{r['task']}", text=f"{r['service'] or '平台'} · {r['env']}\n\n{text}",
                    link=self._notifier.link(f"/runs/{r['run_id']}"), link_title="查看运行"),
                    service=r["service"], env=r["env"], task=r["task"], trigger=None)

    async def _purge(self) -> None:
        if time.monotonic() - self._purged_at < PURGE_EVERY_S and self._purged_at:
            return
        self._purged_at = time.monotonic()
        k = self._s.retention
        events = await retention.purge_run_events(k.run_events_days)
        checkpoints = await retention.purge_checkpoints(k.checkpoints_days)
        hits = await retention.purge_recall_hits(k.recall_hits_days)
        tick_rows = await ticks.purge(k.trigger_ticks_days)
        hosts = await workers.purge()
        files = await asyncio.to_thread(purge_dir, self._s.scratch_dir, k.scratch_days)
        if events or checkpoints or hits or tick_rows or hosts or files:
            log.info("数据保留：清理过程事件 %d 条、checkpoint %d 行、召回埋点 %d 条、触发记录 %d 条、离线主机 %d 台、工作目录 %d 项",
                     events, checkpoints, hits, tick_rows, hosts, files)


def purge_dir(root: str, days: int) -> int:
    """工作目录里超过 days 天没动过的文件和目录删掉（queries/<run_id>/、work/<会话>/ 按目录算）。→ 删掉的项数。"""
    if days <= 0 or not os.path.isdir(root):
        return 0
    cutoff = time.time() - days * 86400
    removed = 0
    for top in os.scandir(root):
        entries = list(os.scandir(top.path)) if top.is_dir() and top.name in ("queries", "work") else [top]
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
