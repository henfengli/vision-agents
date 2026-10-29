"""装配：把各层组件接成一个可运行的整体。API 进程与 worker 进程用同一份装配。

    数据库 → 定义 / 配置（播种）→ 通知 → 项目内核 → 工具 → agent 工厂
    → 提交端 → 定时（含自动重试）→ 回归重放 → 事件入口 → 上游联动
    → （worker：执行队列 + 定时 + 维护循环）

同机部署：生产机、测试机上各一个 agent 服务，共用一个库。每台都跑定时（幂等键保证只建一条）和维护，
执行队列只认领本机负责的环境（部署配置 env / services，以及代管的 remote_envs）的运行。模型账号的并发上限经库在各台之间共用。
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
from .model.fallback import FALLBACK, PRIMARY, switch_for
from .notify import Notifier
from .orchestration.chain import Chainer
from .orchestration.executor import Executor
from .orchestration.maintenance import Maintenance
from .orchestration.pipeline import Deps, Pipeline
from .orchestration.replay import Replayer
from .orchestration.scheduler import Scheduler
from .orchestration.submitter import Submitter
from .registry import Registry
from .services import envspec
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
    chainer: Chainer
    executor: Executor | None = None
    _background: list[asyncio.Task] = field(default_factory=list)

    async def start_worker(self) -> None:
        """在本进程里跑执行队列、定时和维护循环（API 与 worker 同进程）。
        线上主机必须写明负责哪个环境：不写就会认领所有环境的运行（生产的运行跑到测试机上、测试的跑到生产机上）。"""
        if not self.settings.env and self.settings.profile != "dev":
            raise RuntimeError("部署配置没有写 env（这台主机负责哪个环境）：在 ~/.config/agent-platform/local.yaml 里写 "
                               "env: prod 或 env: test（测试机再写 services）。只有开发机（AGENT_ENV=dev）可以不写")
        await envspec.check_remote_envs(self.registry, self.settings)
        pipeline = Pipeline(Deps(settings=self.settings, registry=self.registry, factory=self.factory,
                                 notifier=self.notifier, model_pool=self.model_pool, service_mcp=self.service_mcp,
                                 on_finished=self.replayer.on_finished, after_run=self.chainer.on_finished))
        # 在执行流程之外最终失败的运行（自动重试没能开始、人取消了等着的重试）也要补上通知、投递、联动
        self.scheduler.settle_failed = pipeline.settle_failed
        self.submitter.on_failed_final = pipeline.settle_failed
        maintenance = Maintenance(self.settings, orphaned=pipeline.orphaned, notifier=self.notifier)
        self.executor = Executor(pipeline, self.settings.worker.max_concurrent_runs,
                                 self.settings.env, self.settings.services, self.settings.remote_envs)
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


def _model_outage_notifier(notifier: Notifier):
    """主模型从正常变成挂了（重试完还失败、切到备用）时按通知规则发 model_fallback；同一次故障只发一次。"""
    async def notify(primary: str, fallback: str, error: str) -> None:
        import socket

        from .notify import Message
        await notifier.emit("model_fallback", Message(
            title=f"主模型 {primary} 调用失败，已切到备用模型 {fallback}",
            text=f"主机 {socket.gethostname()}：主模型重试完还失败，运行改用备用模型 {fallback} 接着跑，"
                 f"过一会儿自动再试主模型（恢复了就切回来，不再另发通知）。\n\n最近一次的错误：{error}"),
            service=None, env=None, task=None, trigger=None)
    return notify


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
    # 平台 MCP 的进程：写了 sandbox 的跑在沙箱里（所有服务所有环境的配置都遮），写了 memory 的限内存
    masks = settings.always_hidden | await envspec.all_secret_paths(registry)
    toolbox = Toolbox(settings, notifier, registry=registry, kernels=kernels,
                      mcp_tools=await load_mcp_tools(settings.mcp_servers, mcp_bridge.containment(settings, masks)))
    # 主 / 备用模型的切换状态：agent 和平台的辅助调用共用一份，主模型挂了大家一起先用备用
    switch = switch_for(settings.model)
    switch.on_outage = _model_outage_notifier(notifier)
    if switch.enabled:
        log.info("模型：主模型 %s，备用模型 %s（主模型重试完还失败就切，切过去 %d 秒后再试主模型）",
                 switch.names[PRIMARY], switch.names[FALLBACK], switch.hold_s)
    factory = AgentFactory(settings, toolbox, switch)
    model_pool = ModelPool(settings.model, switch=switch)
    model_pool.on_call = _record_model_call
    submitter = Submitter(registry)
    return Runtime(settings=settings, registry=registry, notifier=notifier, kernels=kernels,
                   service_mcp=ServiceMcp(), toolbox=toolbox, factory=factory,
                   model_pool=model_pool, submitter=submitter, scheduler=Scheduler(registry, submitter),
                   replayer=Replayer(submitter, model_pool, registry), events=EventRouter(registry, submitter),
                   chainer=Chainer(registry, submitter))
