"""Engine：DeepAgents/LangGraph 装配与 agent 生命周期。

DeepAgents 为 pre-1.0 锁版本依赖；本模块是唯一直接 import 它的地方，
角色定义来自自有 DB 配置层，与框架解耦。

Engine 复用同一个 agent 实例跨 run 服务（构建有成本），
角色变更后按 TTL 惰性重建；并发重建由锁保护。
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

from .roles import build_subagents, build_system_prompt, parse_defs, resolve_all

if TYPE_CHECKING:
    from ..config import Settings
    from ..store.definitions import DefinitionStore
    from .tools.registry import ToolRegistry

AGENT_REBUILD_TTL_S = 5.0  # 与 DefinitionStore 缓存 TTL 对齐：角色改后数秒内生效
# 成本取舍（刻意）：重建是 TTL 触发而非变更触发——持续有流量时每 5s 重建
# 一次 agent，create_deep_agent 的装配成本白付。变更 hash 比对更省，但要把
# ResolvedRole 列表做成可哈希快照，复杂度换省电；当前流量下重建成本可忽略，
# 保持简单。若未来 profile 显示重建可见，再换 hash 方案。


def create_agent(roles: list, tool_registry: "ToolRegistry",
                 model: Any, checkpointer: Any = None) -> Any:
    """装配主控 agent + 子角色。deepagents 缺失时给出可操作的报错。"""
    try:
        from deepagents import create_deep_agent
    except ImportError as e:
        raise RuntimeError(
            "未安装 deepagents：pip install agent-platform 会安装锁定版本；"
            "手动部署请执行 pip install deepagents==0.6.*"
        ) from e

    return create_deep_agent(
        model=model,
        tools=tool_registry.resolve(["bash"]),  # 主控自身保留 bash
        subagents=build_subagents(roles, tool_registry),
        system_prompt=build_system_prompt(roles),
        checkpointer=checkpointer,
    )


class Engine:
    """agent 生命周期管理：按需构建、TTL 惰性重建、角色热加载。"""

    def __init__(self, settings: "Settings", defs_store: "DefinitionStore",
                 tool_registry: "ToolRegistry", langfuse=None):
        self._settings = settings
        self._defs = defs_store
        self._tools = tool_registry
        self._langfuse = langfuse
        self._agent: Any = None
        self._built_at = 0.0
        self._lock = asyncio.Lock()
        self._checkpointer_cm: Any = None  # AsyncPostgresSaver 的异步上下文管理器
        self._saver: Any = None
        self._model_http: Any = None       # 主 agent 模型的 httpx 客户端（轮换 auth）

    async def close(self) -> None:
        """释放 checkpointer 与模型 http 连接。服务 shutdown 时调用。"""
        if self._checkpointer_cm is not None:
            await self._checkpointer_cm.__aexit__(None, None, None)
            self._checkpointer_cm = None
        if self._model_http is not None:
            await self._model_http.aclose()
            self._model_http = None

    async def graph_json(self) -> dict:
        """图拓扑（节点 + 边），供前端 dagre 布局渲染。"""
        agent = await self.agent()
        g = agent.get_graph()
        return {
            "nodes": [{"id": n.id, "label": n.name or n.id}
                      for n in g.nodes.values()
                      if not n.id.startswith("__")],
            "edges": [{"source": e.source, "target": e.target}
                      for e in g.edges
                      if not e.source.startswith("__") and not e.target.startswith("__")],
        }

    async def roles(self) -> dict:
        """当前环境的角色定义（未解析继承）：Langfuse 为源头
        （进程内缓存 → PG 持久缓存兜底）。

        角色名清单来自 PG 缓存表（Langfuse 不便按前缀列举+缓存）；
        降级模式（Langfuse 未启用）下等价于直接读 PG。
        继承解析由调用方做（activities 装配前 resolve，agent() 里 resolve_all）。
        """
        raw_names = [r["name"] for r in
                     await self._defs.list_active("role", self._settings.env)]
        defs = {}
        for name in raw_names:
            d = await self._fetch_role(name)
            if d is not None:
                defs[name] = {"name": name, **d}
        return parse_defs(list(defs.values()))

    async def _fetch_role(self, name: str) -> dict | None:
        if self._langfuse is None or not self._langfuse.enabled:
            return await self._defs.get_active("role", self._settings.env, name)

        engine_defs = self._defs
        env = self._settings.env

        class _PgFallback:
            async def get_cache(self, n):
                return await engine_defs.cache_get("role", env, n)

            async def put_cache(self, n, d):
                await engine_defs.cache_put("role", env, n, d)

        return await self._langfuse.fetch_role(name, _PgFallback())

    async def agent(self) -> Any:
        if self._agent is not None and \
                time.monotonic() - self._built_at < AGENT_REBUILD_TTL_S:
            return self._agent
        async with self._lock:
            if self._agent is not None and \
                    time.monotonic() - self._built_at < AGENT_REBUILD_TTL_S:
                return self._agent
            resolved = list(resolve_all(await self.roles()).values())
            self._agent = create_agent(resolved, self._tools, self._make_model(),
                                       checkpointer=await self._get_checkpointer())
            self._built_at = time.monotonic()
            return self._agent

    async def _get_checkpointer(self) -> Any:
        """会话持久化：AsyncPostgresSaver，每步落库，崩溃断点续跑。

        from_conn_string 返回异步上下文管理器，须 enter 后使用；
        连接生命周期与本 Engine 一致（close 时释放）。
        """
        if self._checkpointer_cm is None:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            self._checkpointer_cm = AsyncPostgresSaver.from_conn_string(
                self._settings.db_dsn)
            saver = await self._checkpointer_cm.__aenter__()
            await saver.setup()  # 幂等建 checkpoint 表
            self._saver = saver
        return self._saver

    def _make_model(self) -> Any:
        """LangChain 模型实例：OpenAI 兼容协议指到内部统一模型 API。

        多 token 轮询（与 ModelPool 同一配置语义）：RotatingTokenAuth 逐请求
        轮换 Authorization——主 agent 是流量大头，限流时 SDK 重试自动换 token。
        http client 与角色定义无关：全程只建一个、复用到 close 才释放，
        不随 TTL 重建（否则持续流量下每个重建周期泄漏一个连接池）；
        api_key 仅作占位，实际鉴权头每请求被 auth 覆盖。
        """
        import httpx
        from langchain.chat_models import init_chat_model

        from ..model.pool import RotatingTokenAuth
        if self._model_http is None:
            self._model_http = httpx.AsyncClient(
                auth=RotatingTokenAuth(self._settings.model.tokens))
        return init_chat_model(
            f"openai:{self._settings.model.name}",
            base_url=self._settings.model.url,
            api_key=self._settings.model.tokens[0],
            http_async_client=self._model_http,
        )
