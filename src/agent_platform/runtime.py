"""装配：把各层组件接成一个可运行的整体。API 进程与 worker 进程用同一份装配。

    数据库 → 定义 / 配置（播种）→ 通知 → 进程控制 → 项目内核 → 人工门 → 工具 → agent 工厂
    → 提交端 → 定时 → 回归重放 → 事件入口 → （worker：执行队列 + 定时 + 维护循环）
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field

from . import observability
from .agent.approvals import Gatekeeper
from .agent.factory import AgentFactory
from .agent.tools.catalog import Toolbox
from .agent.tools.mcp_bridge import ServiceMcp, load_mcp_tools
from .config import Settings
from .model import ModelPool
from .notify import Notifier
from .orchestration.executor import Executor
from .orchestration.maintenance import Maintenance
from .orchestration.pipeline import Deps, Pipeline
from .orchestration.replay import Replayer
from .orchestration.scheduler import Scheduler
from .orchestration.submitter import Submitter
from .registry import Registry
from .services.control import ProcessController
from .services.kernel import KernelManager
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
    kernels: KernelManager
    service_mcp: ServiceMcp
    gate: Gatekeeper
    toolbox: Toolbox
    factory: AgentFactory
    model_pool: ModelPool
    submitter: Submitter
    scheduler: Scheduler
    replayer: Replayer
    events: EventRouter
    executor: Executor | None = None
    _background: list[asyncio.Task] = field(default_factory=list)

    async def start_worker(self) -> None:
        """在本进程里跑执行队列、定时和维护循环（单机部署：API 与 worker 同进程）。"""
        pipeline = Pipeline(Deps(settings=self.settings, registry=self.registry, factory=self.factory, gate=self.gate,
                                 notifier=self.notifier, model_pool=self.model_pool, service_mcp=self.service_mcp,
                                 on_finished=self.replayer.on_finished))
        self.executor = Executor(pipeline, self.settings.worker.max_concurrent_runs)
        self.executor.start()
        maintenance = Maintenance(self.controller, self.notifier)
        self._background += [asyncio.create_task(self.scheduler.run_forever()),
                             asyncio.create_task(maintenance.run_forever())]

    async def close(self) -> None:
        if self.executor is not None:
            await self.executor.stop()
        for t in self._background:
            t.cancel()
        await self.kernels.close()
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
    kernels = KernelManager(settings.scratch_dir, settings.kernel.idle_minutes, settings.kernel.max_kernels)
    gate = Gatekeeper(registry, notifier)
    toolbox = Toolbox(settings, gate, notifier, controller=controller, kernels=kernels,
                      mcp_tools=await load_mcp_tools(settings.mcp_servers))
    factory = AgentFactory(settings, toolbox)
    model_pool = ModelPool(settings.model.url, settings.model.name, settings.model.tokens,
                           settings.model.max_concurrency, embedding_name=settings.model.embedding_name)
    submitter = Submitter(registry)
    return Runtime(settings=settings, registry=registry, notifier=notifier, controller=controller, kernels=kernels,
                   service_mcp=ServiceMcp(), gate=gate, toolbox=toolbox, factory=factory, model_pool=model_pool, submitter=submitter,
                   scheduler=Scheduler(registry, submitter), replayer=Replayer(submitter, model_pool),
                   events=EventRouter(registry, submitter))
