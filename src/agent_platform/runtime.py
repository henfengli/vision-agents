"""装配：把各层组件接成一个可运行的整体。API 进程与 worker 进程用同一份装配。

    数据库 → 定义 / 配置（播种）→ 通知 → 进程控制 → 人工门 → 工具 → agent 工厂
    → Temporal → 提交端 → 定时 → 事件入口 → （worker：Temporal Worker + 维护循环）
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from . import observability
from .agent.approvals import Gatekeeper
from .agent.factory import AgentFactory
from .agent.tools.catalog import Toolbox
from .agent.tools.mcp_bridge import load_mcp_tools
from .config import Settings
from .model import ModelPool
from .notify import Notifier
from .orchestration import activities
from .orchestration.maintenance import Maintenance
from .orchestration.scheduler import Scheduler
from .orchestration.submitter import Submitter
from .registry import Registry
from .services.control import ProcessController
from .store import db
from .store.definitions import DefinitionStore
from .triggers.events import EventRouter

log = logging.getLogger(__name__)


@dataclass
class Runtime:
    settings: Settings
    registry: Registry
    notifier: Notifier
    controller: ProcessController
    gate: Gatekeeper
    toolbox: Toolbox
    factory: AgentFactory
    model_pool: ModelPool
    temporal: Any
    submitter: Submitter
    scheduler: Scheduler
    events: EventRouter
    _background: list[asyncio.Task] = field(default_factory=list)
    _worker: Any = None

    def resync_schedules(self) -> None:
        """定义改了（任务、服务、服务的环境开关）：后台同步定时，不阻塞请求。"""
        async def run() -> None:
            try:
                await self.scheduler.sync()
            except Exception:
                log.exception("同步定时失败")
        self._background.append(asyncio.create_task(run()))

    async def start_worker(self) -> None:
        """在本进程里跑 Temporal Worker 和维护循环（单机部署：API 与 worker 同进程）。"""
        from .orchestration.worker import create_worker

        deps = activities.Deps(settings=self.settings, registry=self.registry, factory=self.factory, gate=self.gate,
                               notifier=self.notifier, model_pool=self.model_pool, submitter=self.submitter)
        self._worker = create_worker(self.temporal, deps, self.settings.temporal.task_queue)
        maintenance = Maintenance(self.temporal, self.submitter, self.scheduler, self.controller, self.notifier)
        self._background += [asyncio.create_task(self._worker.run()), asyncio.create_task(maintenance.run_forever())]

    async def close(self) -> None:
        if self._worker is not None:
            await self._worker.shutdown()
        for t in self._background:
            t.cancel()
        await self.factory.close()
        await db.close_db()


async def assemble(settings: Settings) -> Runtime:
    observability.setup(settings.langfuse)
    await db.open_db(settings.db_dsn)
    for d in (settings.scratch_dir, settings.assets_dir, settings.instances_dir):
        os.makedirs(d, exist_ok=True)

    registry = Registry(DefinitionStore())
    await registry.seed(settings.seeds_dir)

    notifier = Notifier(registry, settings.public_url)
    controller = ProcessController(settings, registry)
    gate = Gatekeeper(registry, notifier)
    toolbox = Toolbox(settings, gate, notifier, controller=controller, mcp_tools=await load_mcp_tools(settings.mcp_servers))
    factory = AgentFactory(settings, toolbox)
    model_pool = ModelPool(settings.model.url, settings.model.name, settings.model.tokens,
                           settings.model.max_concurrency, embedding_name=settings.model.embedding_name)

    from temporalio.client import Client
    temporal = await Client.connect(settings.temporal.address, namespace=settings.temporal.namespace)
    submitter = Submitter(registry, temporal, settings.temporal.task_queue, gate)
    scheduler = Scheduler(temporal, registry, settings.temporal.task_queue)

    rt = Runtime(settings=settings, registry=registry, notifier=notifier, controller=controller, gate=gate,
                 toolbox=toolbox, factory=factory, model_pool=model_pool, temporal=temporal, submitter=submitter,
                 scheduler=scheduler, events=EventRouter(registry, submitter))
    rt.resync_schedules()
    return rt
