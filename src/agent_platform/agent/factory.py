"""AgentFactory：按角色装配 agent，并执行一次调用。

一个角色 = 一个 agent：系统提示 = 平台基础约定 + 角色提示，工具 = 角色白名单 + 运行所在服务的 MCP 工具
（角色 service_tools=false 时不带）。角色声明了 subagents 时，这些角色作为子代理挂上：主角色运行中按需委派子问题，
子代理用自己的提示词和工具、独立上下文，结论交回主角色——动态委派，不是静态流水线。

编译好的 agent 按（角色, 服务, 角色与子代理的版本, 服务 MCP 的版本）缓存：定义一改版本号就变，
下一次运行自然用新定义，无需 TTL 轮询重建。DeepAgents 是 pre-1.0 依赖，本模块是唯一 import 它的地方。

会话 = LangGraph thread（PG checkpointer），崩溃后同 thread 断点续跑。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..config import Settings
from ..domain import ResolvedRole
from ..store import runs
from .tools.catalog import Toolbox

log = logging.getLogger(__name__)

BASE_PROMPT = """你是 agent-platform 上的一个业务 agent。平台约定：
- 每次运行都绑定一个服务和一个环境（见用户消息里的 [运行环境]），你的工具只作用于它们，不要尝试操作别的服务或环境。
- 档案（[档案——…]）是人写的一手事实，优先级最高；历史知识与方法是过去运行沉淀的，可能过时，与代码或数据矛盾时以实际为准并指出。
- 工作目录：bash 的当前目录与文件工具（read_file/write_file/edit_file/ls/grep）的根目录是同一块可写区（py 里是 $SCRATCH）；服务代码只读，用 bash 直接读取原路径。
- 要跑项目自己的代码（import 项目模块、调口径函数、用项目的数据访问层取数、复现某个函数的报错），用 py：它就在本环境的项目 Python 里，配置已就位，变量在会话内保留。不要在 bash 里自己拼环境去跑项目代码。
- 配置文件（各环境的配置、密钥文件）在 bash 里被遮蔽、读到的是空文件；本环境的配置用 service_info(what=config) 读，密钥已打码。
- 脚本先写进工作目录、跑通，再用 save_asset 收编成方法；以后同类运行会自动召回。
- 结论要可核对：给出依据（命令输出、SQL、代码位置），不确定就明说。"""


SUBAGENT_PROMPT = """你是 agent-platform 上被主 agent 委派来处理一个子问题的子代理。
- 你和主 agent 在同一次运行里：同一个服务、同一个环境，工具只作用于它们。
- 只做交给你的那件事，做完给出可核对的结论（依据：命令输出、SQL、代码位置），不确定就明说。
- 跑项目代码用 py；配置用 service_info(what=config) 读。"""


def _scratch_backend(scratch_dir: str) -> Any:
    from deepagents.backends import FilesystemBackend
    return FilesystemBackend(root_dir=scratch_dir, virtual_mode=True)


class AgentFactory:
    def __init__(self, settings: Settings, toolbox: Toolbox):
        self._s = settings
        self._toolbox = toolbox
        self._cache: dict[tuple, Any] = {}
        self._lock = asyncio.Lock()
        self._saver_cm: Any = None
        self._saver: Any = None
        self._http: Any = None

    async def close(self) -> None:
        if self._saver_cm is not None:
            await self._saver_cm.__aexit__(None, None, None)
            self._saver_cm = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def agent_for(self, role: ResolvedRole, subagents: list[ResolvedRole], version_key: tuple,
                        service: str | None = None, service_tools: list | None = None, service_key: str = "") -> Any:
        """缓存键 = 角色（含子代理）的版本 + 运行所在服务的 MCP 工具版本：同一角色在不同服务上带的服务工具不同。"""
        variant = (role.name, service or "", service_key)
        key = (*variant, version_key)
        if key in self._cache:
            return self._cache[key]
        async with self._lock:
            if key not in self._cache:
                # 同一角色在同一服务上的旧版本不再需要
                for k in [k for k in self._cache if k[:3] == variant]:
                    self._cache.pop(k)
                self._cache[key] = await self._build(role, subagents, service_tools or [])
        return self._cache[key]

    async def _build(self, role: ResolvedRole, subagents: list[ResolvedRole], service_tools: list) -> Any:
        try:
            from deepagents import create_deep_agent
        except ImportError as e:
            raise RuntimeError("未安装 deepagents：pip install agent-platform 会装锁定版本") from e
        for r in (role, *subagents):
            unknown = self._toolbox.unknown(r.tools)
            if unknown:
                log.warning("角色 %s 声明了未登记的工具：%s（已忽略）", r.name, "、".join(unknown))
        prompt = BASE_PROMPT + (f"\n\n[角色：{role.title}]\n{role.prompt}" if role.prompt else "")
        if subagents:
            prompt += "\n\n[可委派的子代理] 子问题明显属于下面某个角色的专长时，用 task 工具交给它，它会用自己的工具独立完成并交回结论：\n" \
                + "\n".join(f"- {r.name}（{r.title}）：{r.description or '—'}" for r in subagents)
        subs = [{"name": r.name, "description": f"{r.title}：{r.description}" if r.description else r.title,
                 "system_prompt": SUBAGENT_PROMPT + (f"\n\n[角色：{r.title}]\n{r.prompt}" if r.prompt else ""),
                 "tools": self._toolbox.langchain_tools(r.tools, service_tools if r.service_tools else None)}
                for r in subagents]
        return create_deep_agent(
            model=self._model(), tools=self._toolbox.langchain_tools(role.tools, service_tools if role.service_tools else None),
            system_prompt=prompt, subagents=subs or None,
            checkpointer=await self._checkpointer(), backend=_scratch_backend(self._s.scratch_dir))

    async def _checkpointer(self) -> Any:
        if self._saver is None:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            self._saver_cm = AsyncPostgresSaver.from_conn_string(self._s.db_dsn)
            self._saver = await self._saver_cm.__aenter__()
            await self._saver.setup()
        return self._saver

    def _model(self) -> Any:
        """OpenAI 兼容协议指向内部模型网关；多 token 逐请求轮换（RotatingTokenAuth）。"""
        import httpx
        from langchain.chat_models import init_chat_model

        from ..model.pool import RotatingTokenAuth
        if self._http is None:
            self._http = httpx.AsyncClient(auth=RotatingTokenAuth(self._s.model.tokens), timeout=600)
        return init_chat_model(f"openai:{self._s.model.name}", base_url=self._s.model.url,
                               api_key=self._s.model.tokens[0], http_async_client=self._http)


async def invoke(agent: Any, run_id: str, thread_id: str, prompt: str | None) -> str:
    """执行一次（prompt=None 表示从 checkpoint 续跑），事件实时落 run_events，返回最终答案。"""
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 200}
    payload = None if prompt is None else {"messages": [{"role": "user", "content": prompt}]}
    tokens = 0
    async for ev in agent.astream_events(payload, config=config, version="v2"):
        kind, name, data = ev.get("event", ""), ev.get("name", ""), ev.get("data") or {}
        if kind == "on_tool_start":
            await runs.log_event(run_id, "tool_call", {"tool": name, "args": _clip_obj(data.get("input"))})
        elif kind == "on_tool_end":
            out = data.get("output")
            await runs.log_event(run_id, "tool_result", {"tool": name, "output": _clip(getattr(out, "content", out))})
        elif kind == "on_chat_model_end":
            msg = data.get("output")
            usage = getattr(msg, "usage_metadata", None) or {}
            n = int(usage.get("total_tokens") or 0)
            tokens += n
            content = _text(getattr(msg, "content", ""))
            if content and getattr(msg, "tool_calls", None):
                await runs.log_event(run_id, "thought", {"content": _clip(content), "tokens": n or None})
    if tokens:
        await runs.add_tokens(run_id, tokens)
    state = await agent.aget_state(config)
    messages = (state.values.get("messages") if state else None) or []
    return _text(getattr(messages[-1], "content", "")) if messages else ""


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):     # 多段内容（文本块 + 其它）
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in content)
    return str(content or "")


def _clip(value: Any, limit: int = 4000) -> str:
    text = value if isinstance(value, str) else _text(value) if isinstance(value, list) else repr(value)
    return text if len(text) <= limit else text[:limit] + f"…[截断，共 {len(text)} 字符]"


def _clip_obj(value: Any, limit: int = 4000) -> Any:
    if isinstance(value, dict):
        return {k: (_clip(v, limit) if isinstance(v, str) and len(v) > limit else v) for k, v in value.items()}
    return _clip(value, limit)
