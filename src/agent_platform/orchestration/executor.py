"""执行队列的消费端：runs 表就是队列。

- 认领：status=queued 的行按优先级（人在等的先）再按创建时间，FOR UPDATE SKIP LOCKED，多个 worker 并发也不会重复认领；
  只认领本主机负责的环境（部署配置 env，再按 services 限服务）的运行；点名的上游还没成功的、任务并发已满的先跳过
- 报到：每 20 秒往 workers 表报一次（负责的环境、服务、在跑几个），控制台据此显示主机在不在线
- 唤醒：进入 queued 时 pg_notify('runs_queued')，LISTEN 毫秒级唤醒；5 秒轮询兜底
- 并发：最多 max_concurrent 个运行同时执行，满了就不再认领
- 心跳：执行中的运行每 20 秒刷新 heartbeat_at（只刷还归本 worker、还在执行的；不归了就停下）；
  进程崩溃后心跳停了，维护循环把它们标为失败（可续跑）
- 取消：提交端把台账标成 cancelled 后 pg_notify('run_cancel', run_id)，持有它的 worker 取消执行
- 退出：取消全部执行中的运行，记为 interrupted（可续跑）
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket

from .. import __version__
from ..store import db, runs, workers
from .pipeline import Pipeline

log = logging.getLogger(__name__)

POLL_S = 5.0
HEARTBEAT_S = 20.0


class Executor:
    def __init__(self, pipeline: Pipeline, max_concurrent: int = 10, env: str = "", services: list[str] | None = None):
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"
        self.env = env
        self.services = list(services or [])
        self._pipeline = pipeline
        self.max_concurrent = max_concurrent
        self._sem = asyncio.Semaphore(max_concurrent)
        self._running: dict[str, asyncio.Task] = {}
        self._wake = asyncio.Event()
        self._loops: list[asyncio.Task] = []

    def start(self) -> None:
        self._loops = [asyncio.create_task(self._claim_forever()), asyncio.create_task(self._listen_forever()),
                       asyncio.create_task(self._heartbeat_forever())]
        log.info("执行队列已启动（worker %s，环境 %s，服务 %s）", self.worker_id, self.env or "不限",
                 "、".join(self.services) or "不限")

    async def stop(self, grace_s: float = 10.0) -> None:
        for t in self._loops:
            t.cancel()
        tasks = list(self._running.values())
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=grace_s)
        try:
            await workers.stopped(self.worker_id)
        except Exception:  # noqa: BLE001 —— 库已经断了：维护循环按 90 秒没报到判离线
            log.warning("执行主机下线登记失败", exc_info=True)

    async def report(self) -> None:
        """报到：这台主机负责的环境、服务、在跑几个（控制台的主机列表、排队太久时的原因说明）。"""
        await workers.heartbeat(self.worker_id, host=socket.gethostname(), env=self.env, services=self.services,
                                version=__version__, max_concurrent=self.max_concurrent, running=len(self._running))

    @property
    def running(self) -> list[str]:
        return list(self._running)

    # —— 循环 ——

    async def _claim_forever(self) -> None:
        while True:
            await self._sem.acquire()
            self._wake.clear()
            try:
                run_id = await runs.claim_next(self.worker_id, self.env, self.services)
            except Exception:  # noqa: BLE001 —— 库连不上：稍后再试
                log.exception("认领排队运行失败")
                run_id = None
            if run_id is None:
                self._sem.release()
                try:
                    await asyncio.wait_for(self._wake.wait(), POLL_S)
                except (TimeoutError, asyncio.TimeoutError):
                    pass
                continue
            self._running[run_id] = asyncio.create_task(self._run(run_id), name=f"run:{run_id}")

    async def _run(self, run_id: str) -> None:
        try:
            await self._pipeline.execute(run_id)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001 —— execute 自己会落失败；这里只兜住意外
            log.exception("执行运行 %s 时出错", run_id)
        finally:
            self._running.pop(run_id, None)
            self._sem.release()
            self._wake.set()                         # 腾出位置，马上看看还有没有排队的

    async def _listen_forever(self) -> None:
        import psycopg

        while True:
            try:
                async with await psycopg.AsyncConnection.connect(db.dsn(), autocommit=True) as conn:
                    await conn.execute("LISTEN runs_queued")
                    await conn.execute("LISTEN run_cancel")
                    async for n in conn.notifies():
                        if n.channel == "runs_queued":
                            self._wake.set()
                        elif n.channel == "run_cancel" and (task := self._running.get(n.payload)):
                            log.info("取消运行 %s", n.payload)
                            task.cancel()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 —— 监听断了：轮询兜底，过一会儿重连
                log.warning("执行队列的 LISTEN 连接断开，5 秒后重连", exc_info=True)
                await asyncio.sleep(5)

    async def _heartbeat_forever(self) -> None:
        while True:
            try:
                await self.report()
            except Exception:  # noqa: BLE001
                log.warning("执行主机报到失败", exc_info=True)
            await asyncio.sleep(HEARTBEAT_S)
            try:
                stop = await runs.heartbeat(self.worker_id, self.running)
            except Exception:  # noqa: BLE001
                log.exception("刷新运行心跳失败")
                continue
            for run_id in stop:                      # 已被取消（通知可能漏了）或被别的主机判成孤儿：停下
                if task := self._running.get(run_id):
                    log.warning("运行 %s 已不归本 worker 执行（取消或判为孤儿），停止", run_id)
                    task.cancel()
