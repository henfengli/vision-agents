"""服务装配与启动入口：uvicorn --factory agent_platform.main:build_app

真两阶段装配：
- build_app()（同步）：只建裸 app（health + 异常处理），不碰任何外部连接
- lifespan（uvicorn loop 内）：assemble_runtime() 完成全部真实装配——
  DB 池 → 建表 → 种子 → 连 Temporal → Submitter/Engine/Worker → 挂业务路由
  → 同步 Schedules；关闭时逆序释放

连接池与后台任务都绑定创建它们的 loop：全部组件都在 lifespan 内创建，
没有同步装配期占位，没有延迟绑定。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from .gateway import create_app, make_gateway_router
from .langfuse_client import LangfuseClient, setup_observability
from .model import ModelPool
from .notify import DingTalkRelay
from .orchestration import activities
from .orchestration.submitter import Submitter
from .orchestration.worker import create_worker
from .orchestration.workflows import sync_schedules
from .runtime.approvals import make_approval_hook
from .runtime.engine import Engine
from .settings import Settings, get_settings
from .store import close_pool, open_and_migrate
from .store.definitions import DefinitionStore
from .tasks import TaskRegistry
from .tasks.triggers import chat as chat_trigger
from .tasks.triggers import dagster_sensor, gitlab_webhook
from .tools import ToolRegistry
from .viewer import make_viewer_router

log = logging.getLogger(__name__)

# 首次启动的种子角色/任务：空库时写入，之后由 Admin API 管理（含版本历史）
SEED_ROLES = [
    {"name": "data_searcher",
     "description": "数据口径查询：先查知识库，再读代码分析口径，再查只读库",
     "domains": ["board", "config-center"],
     "tools": ["bash", "run_code", "sql_query", "read_file", "grep"],
     "prompt": "你是数据查询助手。工作约定：\n"
               "1. 先查知识库是否已有该指标口径；命中直接回答并附来源。\n"
               "2. 未命中：在业务域代码目录检索指标定义（grep），读懂计算逻辑。\n"
               "3. 按口径拼 SQL 查只读库；查询必带 LIMIT 100。\n"
               "4. 回答结构：数值 + 口径说明 + 代码位置 + 执行的 SQL。"},
    {"name": "ops_analyst",
     "description": "Dagster 报错分析：区分代码/数据/基础设施/上游问题",
     "domains": ["dagster", "board"],
     "tools": ["bash", "run_code", "sql_query", "read_file", "grep", "dingtalk_send"],
     "prompt": "你是运维分析助手。分析步骤：\n"
               "1. 参考同类案例（如 prompt 中已注入）。\n"
               "2. 用 curl 查 Dagster GraphQL 拿报错堆栈与上游状态。\n"
               "3. 读对应代码与最近变更；必要时查只读库验证数据假设。\n"
               "4. 输出结构化结论：category(code/data/infra/upstream)、confidence、evidence、suggestion。"},
]

SEED_TASKS = [
    {"name": "failure-analysis", "role": "ops_analyst",
     "triggers": ["dagster_sensor"],
     "input_schema": {"run_id": "str", "asset_key": "str", "error": "str"},
     "output_channel": "dingtalk", "dedup_key": "run_id",
     "dedup_window_s": 600, "timeout_s": 300, "env_gate": ["prod", "test"]},
    {"name": "data-qa", "role": "data_searcher",
     "triggers": ["sdk", "cli", "web_chat"],
     "input_schema": {"question": "str"},
     "output_channel": "caller", "timeout_s": 180},
    {"name": "daily-inspection", "role": "ops_analyst",
     "triggers": ["schedule"], "input_schema": {"scope": "str"},
     "output_channel": "dingtalk", "timeout_s": 900},
]


@dataclass
class Runtime:
    """lifespan 内装配出的全部运行时组件。"""
    settings: Settings
    defs: DefinitionStore
    tasks: TaskRegistry
    submitter: Submitter
    engine: Engine
    relay: DingTalkRelay
    langfuse: LangfuseClient
    temporal_client: object = None
    worker: object = None
    _worker_task: asyncio.Task | None = field(default=None, repr=False)

    async def stop(self) -> None:
        if self.worker is not None:
            await self.worker.shutdown()
        if self._worker_task is not None:
            self._worker_task.cancel()
        await self.engine.close()
        await close_pool()


async def assemble_runtime(settings: Settings) -> Runtime:
    """全部真实装配。必须在目标事件循环内调用（lifespan 或测试的 loop）。"""
    setup_observability(settings.langfuse)  # Langfuse OTEL（空操作可关）
    await open_and_migrate(settings.db.dsn)

    defs = DefinitionStore()
    await seed_if_empty(defs, settings.env)
    tasks = TaskRegistry(defs, settings.env)
    langfuse = LangfuseClient(settings.langfuse)
    relay = DingTalkRelay(settings.dingtalk.relay_url,
                          settings.dingtalk.access_token)
    model_pool = ModelPool(settings.model.url, settings.model.name,
                           settings.model.tokens, settings.model.max_concurrency,
                           embedding_name=settings.model.embedding_name)

    # 审批通知：bash 命中危险模式 → 钉钉 actionCard → Viewer 审批页
    approval_notify = None
    if settings.approvals.enabled:
        async def approval_notify(run_id: str, command: str) -> None:
            await relay.send_action_card(
                "危险操作待审批", f"run `{run_id}` 请求执行：\n```\n{command}\n```",
                "去审批", f"{settings.viewer_base_url}/approvals/{run_id}")

    approval_hook = (make_approval_hook(settings.approvals.danger_patterns,
                                        approval_notify)
                     if settings.approvals.enabled else None)

    async def write_asset_profile(asset_key: str, content: str,
                                  domain: str | None = None) -> None:
        from .store import knowledge as knowledge_store
        dom = domain or next(iter(settings.domains), None)
        if not dom:
            raise ValueError("无可用 domain，请显式指定")
        await knowledge_store.upsert(
            settings.env, dom, f"asset:{asset_key}:profile", content,
            source_run="agent-tool",
            embedder=getattr(model_pool, "embed", None))

    from .tools.mcp_bridge import load_mcp_tools
    extra_tools = await load_mcp_tools(settings.mcp_servers)

    def sql_dsn(domain: str | None) -> str | None:
        dom = domain or next(iter(settings.domains), None)
        cfg = settings.domains.get(dom) if dom else None
        return cfg.readonly_dsn if cfg else None

    tool_registry = ToolRegistry(settings.scratch_dir, relay=relay,
                                 review=approval_hook,
                                 profile_writer=write_asset_profile,
                                 sql_dsn=sql_dsn, extra_tools=extra_tools)
    engine = Engine(settings, defs, tool_registry, langfuse=langfuse)

    from temporalio.client import Client
    temporal_client = await Client.connect(
        settings.temporal.address, namespace=settings.temporal.namespace)
    submitter = Submitter(temporal_client, tasks,
                          settings.temporal.task_queue, settings.env)

    worker = await create_worker(
        temporal_client,
        activities.Deps(settings=settings, engine=engine,
                        model_pool=model_pool, notifier=relay,
                        langfuse=langfuse),
        settings.temporal.task_queue)

    rt = Runtime(settings=settings, defs=defs, tasks=tasks,
                 submitter=submitter, engine=engine, relay=relay,
                 langfuse=langfuse, temporal_client=temporal_client,
                 worker=worker,
                 _worker_task=asyncio.create_task(worker.run()))

    n = await sync_schedules(temporal_client, await tasks.list(),
                             settings.temporal.task_queue)
    if n:
        log.info("同步 %d 个 Temporal Schedule", n)
    return rt


async def seed_if_empty(defs: DefinitionStore, env: str) -> None:
    if await defs.list_active("role", env):
        return
    for role in SEED_ROLES:
        await defs.put("role", env, role["name"],
                       {k: v for k, v in role.items() if k != "name"},
                       updated_by="seed")
    for task in SEED_TASKS:
        await defs.put("task", env, task["name"],
                       {k: v for k, v in task.items() if k != "name"},
                       updated_by="seed")


def build_app(settings: Settings | None = None):
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app):
        rt = await assemble_runtime(settings)
        auth_routers = [
            make_gateway_router(settings, rt.submitter, rt.tasks, rt.defs,
                                langfuse=rt.langfuse),
            dagster_sensor.make_router(rt.submitter, rt.relay),
            gitlab_webhook.make_router(rt.submitter),
        ]
        for r in auth_routers:
            app.include_router(r)
        app.include_router(chat_trigger.make_router(rt.submitter))
        app.include_router(make_viewer_router(rt.submitter, rt.defs,
                                              settings.env, engine=rt.engine,
                                              langfuse=rt.langfuse))
        try:
            yield
        finally:
            await rt.stop()

    return create_app(settings, lifespan=lifespan)


# uvicorn 入口用工厂模式（--factory agent_platform.main:build_app）：
# 延迟到 worker 进程内才读配置/装配，避免 import 期副作用。
