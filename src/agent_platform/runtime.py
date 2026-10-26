"""装配：把各层组件接成一个可运行的整体。API 进程与 worker 进程用同一份装配。

    数据库 → 定义 / 配置（播种）→ 通知 → 项目内核 → 工具 → agent 工厂
    → 提交端 → 定时 → 回归重放 → 事件入口 → （worker：执行队列 + 定时 + 维护循环）

同机部署：生产机、测试机上各一个 agent 服务，共用一个库。每台都跑定时（幂等键保证只建一条）和维护，
执行队列只认领本机负责的环境（部署配置 env / services）的运行。模型账号的并发上限经库在各台之间共用。
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field

from . import observability
from .agent.factory import AgentFactory
from .agent.tools import mcp_bridge
from .agent.tools.catalog import Toolbox
from .agent.tools.mcp_bridge import ServiceMcp, load_mcp_tools
from .config import Settings
from .model import ModelPool
from .model import pool as model_pool_mod
from .notify import Notifier
from .orchestration.executor import Executor
from .orchestration.maintenance import Maintenance
from .orchestration.pipeline import Deps, Pipeline
from .orchestration.replay import Replayer
from .orchestration.scheduler import Scheduler
from .orchestration.submitter import Submitter
from .registry import Registry
from .services.kernel import KernelManager
from .store import db, runs
from .store.definitions import DefinitionStore
from .triggers.events import EventRouter

log = logging.getLogger(__name__)


@dataclass
class Runtime:
    settings: Settings
    registry: Registry
    notifier: Notifier
    kernels: KernelManager
    service_mcp: ServiceMcp
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
        """在本进程里跑执行队列、定时和维护循环（API 与 worker 同进程）。"""
        maintenance = Maintenance(self.settings)
        pipeline = Pipeline(Deps(settings=self.settings, registry=self.registry, factory=self.factory,
                                 notifier=self.notifier, model_pool=self.model_pool, service_mcp=self.service_mcp,
                                 on_finished=self.replayer.on_finished))
        self.executor = Executor(pipeline, self.settings.worker.max_concurrent_runs,
                                 self.settings.env, self.settings.services)
        self.executor.start()
        self._background += [asyncio.create_task(self.scheduler.run_forever()),
                             asyncio.create_task(maintenance.run_forever())]

    async def close(self) -> None:
        if self.executor is not None:
            await self.executor.stop()
        for t in self._background:
            t.cancel()
        await self.kernels.close()
        await mcp_bridge.SESSIONS.close()
        await self.factory.close()
        await self.model_pool.close()
        await db.close_db()


async def _record_model_call(run_id: str, payload: dict) -> None:
    """平台自己的辅助模型调用（记忆沉淀、交接摘要、回归判定）记进该运行的时间线，token 计入运行。"""
    await runs.log_event(run_id, "model_call", payload)
    await runs.add_tokens(run_id, int(payload.get("tokens") or 0))


async def assemble(settings: Settings) -> Runtime:
    observability.setup(settings.otel)
    await db.open_db(settings.db_dsn)
    model_pool_mod.share_quota_via_db()          # prod、test 共用一个模型账号：并发上限经库共用
    for d in (settings.scratch_dir, settings.assets_dir, settings.agent_conf_dir):
        os.makedirs(d, exist_ok=True)
    os.chmod(settings.agent_conf_dir, 0o700)

    registry = Registry(DefinitionStore())
    await registry.seed(settings.seeds_dir)

    notifier = Notifier(registry, settings.public_url)
    kernels = KernelManager(settings.scratch_dir, settings.kernel.idle_minutes, settings.kernel.max_kernels,
                            limits=settings.limits, require_sandbox=settings.require_sandbox)
    toolbox = Toolbox(settings, notifier, registry=registry, kernels=kernels,
                      mcp_tools=await load_mcp_tools(settings.mcp_servers))
    factory = AgentFactory(settings, toolbox)
    model_pool = ModelPool(settings.model)
    model_pool.on_call = _record_model_call
    submitter = Submitter(registry)
    return Runtime(settings=settings, registry=registry, notifier=notifier, kernels=kernels,
                   service_mcp=ServiceMcp(), toolbox=toolbox, factory=factory,
                   model_pool=model_pool, submitter=submitter, scheduler=Scheduler(registry, submitter),
                   replayer=Replayer(submitter, model_pool, registry), events=EventRouter(registry, submitter))
