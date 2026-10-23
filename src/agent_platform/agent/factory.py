"""AgentFactory：按角色装配 agent，并执行一次调用。

一个角色 = 一个 agent（langchain create_agent），中间件只挑用得上的两个：
- 补齐悬空的工具调用（中断 / 续跑后历史里有没回复的 tool_call，模型 API 会拒收）
- 上下文压缩（历史到模型上下文的 75% 时把早期消息压成摘要，提示词是平台配置 prompts.compaction）
系统提示 = 平台基础约定（prompts.base）+ 角色提示；工具 = 角色白名单 + 运行所在服务的 MCP 工具
（角色 service_tools=false 时不带）。没有框架自带的英文提示词、文件工具、待办清单——工具集见 tools/catalog.py。

子代理：角色声明了 subagents 时，这些角色各编译成一个 agent，主角色多一个 task 工具按需委派：子代理用自己的
提示词（prompts.subagent + 角色提示）和工具、独立上下文，最后一条回复交回主角色。只一层。

结构化输出：任务声明了 output_schema 时多一个 submit_result 工具（参数就是该 schema），调用时当场校验，
不符合就把错误告诉模型让它改；运行结束取最后一次通过校验的提交。没交就提醒一次。

编译好的 agent 按（角色, 服务, 服务 MCP 版本, 输出 schema）缓存，版本键 = 角色与子代理各层的版本 + 平台提示词版本：
定义一改版本号就变，下一次运行自然用新定义。会话 = LangGraph thread（PG checkpointer），崩溃后同 thread 断点续跑。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from ..config import Settings
from ..domain import PromptsConfig, ResolvedRole
from ..store import runs
from .tools.catalog import Toolbox

log = logging.getLogger(__name__)

SUBMIT_TOOL = "submit_result"
_ACCEPTED = "已收到结构化结果"


def system_prompt(role: ResolvedRole, subagents: list[ResolvedRole], prompts: PromptsConfig,
                  output_schema: dict | None = None) -> str:
    """主 agent 的系统提示（运行详情里的"系统提示"阶段展示的就是它）。"""
    prompt = prompts.base + (f"\n\n[角色：{role.title}]\n{role.prompt}" if role.prompt else "")
    if subagents:
        prompt += ("\n\n[可委派的子代理] 子问题明显属于下面某个角色的专长时，用 task 工具交给它（subagent 填名字），"
                   "它用自己的工具独立完成并交回结论。它看不到你的对话，说明里要写全背景和要交回什么：\n"
                   + "\n".join(f"- {r.name}（{r.title}）：{r.description or '—'}" for r in subagents))
    if output_schema:
        prompt += (f"\n\n[结构化结果] 本任务要求结构化结果：结论确定后调用 {SUBMIT_TOOL} 交回（字段见该工具的参数），"
                   "不符合要求会告诉你哪里不对，改好再交；交完再用一两句话给出文字结论。")
    return prompt


def _sub_prompt(role: ResolvedRole, prompts: PromptsConfig) -> str:
    return prompts.subagent + (f"\n\n[角色：{role.title}]\n{role.prompt}" if role.prompt else "")


def schema_key(schema: dict | None) -> str:
    if not schema:
        return ""
    return hashlib.sha1(json.dumps(schema, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


class AgentFactory:
    def __init__(self, settings: Settings, toolbox: Toolbox):
        self._s = settings
        self._toolbox = toolbox
        self._cache: dict[tuple, Any] = {}
        self._lock = asyncio.Lock()
        self._saver_cm: Any = None
        self._saver: Any = None
        self._http: Any = None

    @property
    def toolbox(self) -> Toolbox:
        return self._toolbox

    async def close(self) -> None:
        if self._saver_cm is not None:
            await self._saver_cm.__aexit__(None, None, None)
            self._saver_cm = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def agent_for(self, role: ResolvedRole, subagents: list[ResolvedRole], version_key: tuple,
                        service: str | None = None, service_tools: list | None = None, service_key: str = "",
                        prompts: PromptsConfig | None = None, output_schema: dict | None = None) -> Any:
        """缓存键 = 角色 × 服务 × 服务 MCP 版本 × 输出 schema；版本键（角色各层、子代理、平台提示词）变了就重建。"""
        variant = (role.name, service or "", service_key, schema_key(output_schema))
        key = (*variant, version_key)
        if key in self._cache:
            return self._cache[key]
        async with self._lock:
            if key not in self._cache:
                for k in [k for k in self._cache if k[:4] == variant]:   # 同一组合的旧版本不再需要
                    self._cache.pop(k)
                self._cache[key] = await self._build(role, subagents, service_tools or [],
                                                     prompts or PromptsConfig(), output_schema)
        return self._cache[key]

    async def _build(self, role: ResolvedRole, subagents: list[ResolvedRole], service_tools: list,
                     prompts: PromptsConfig, output_schema: dict | None) -> Any:
        from langchain.agents import create_agent

        for r in (role, *subagents):
            unknown = self._toolbox.unknown(r.tools)
            if unknown:
                log.warning("角色 %s 声明了未登记的工具：%s（已忽略）", r.name, "、".join(unknown))
        model = self._model()

        def tools_of(r: ResolvedRole) -> list:
            return self._toolbox.langchain_tools(r.tools, service_tools if r.service_tools else None)

        tools = tools_of(role)
        if subagents:
            # 子代理带名字（create_agent 把它记进事件的 lc_agent_name），主 agent 不带：时间线上只标子代理里发生的事
            subs = {r.name: (create_agent(model, tools=tools_of(r), system_prompt=_sub_prompt(r, prompts),
                                          middleware=self._middleware(model, prompts), name=r.name),
                             f"{r.title}：{r.description}" if r.description else r.title)
                    for r in subagents}
            tools.append(_task_tool(subs))
        if output_schema:
            tools.append(_submit_tool(output_schema))
        return create_agent(model, tools=tools, system_prompt=system_prompt(role, subagents, prompts, output_schema),
                            middleware=self._middleware(model, prompts), checkpointer=await self._checkpointer())

    def _middleware(self, model: Any, prompts: PromptsConfig) -> list:
        from langchain.agents.middleware import SummarizationMiddleware
        return [_patch_middleware(),
                SummarizationMiddleware(model, trigger=("tokens", int(self._s.model.context_tokens * 0.75)),
                                        keep=("messages", 20), summary_prompt=prompts.compaction)]

    async def _checkpointer(self) -> Any:
        if self._saver is None:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
            self._saver_cm = AsyncPostgresSaver.from_conn_string(self._s.db_dsn)
            self._saver = await self._saver_cm.__aenter__()
            await self._saver.setup()
        return self._saver

    def _model(self) -> Any:
        """OpenAI 兼容网关（Kimi）：token 轮换、账号配额排队、保留思考过程（model/chat.py）。"""
        from ..model.chat import chat_model
        from ..model.pool import http_client
        if self._http is None:
            self._http = http_client(self._s.model)
        return chat_model(self._s.model, self._http)


# ==================== 中间件与内置工具 ====================

def _patch_middleware() -> Any:
    """历史里有没回复的工具调用（运行中断后续跑、上一轮被取消）时补一条"已取消"的工具回复，否则模型 API 拒收。"""
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.messages import AIMessage, RemoveMessage, ToolMessage
    from langgraph.graph.message import REMOVE_ALL_MESSAGES

    class PatchDanglingToolCalls(AgentMiddleware):
        def before_agent(self, state: Any, runtime: Any) -> dict | None:  # noqa: ARG002
            messages = state["messages"]
            answered = {m.tool_call_id for m in messages if getattr(m, "type", "") == "tool"}
            if not any(c.get("id") and c["id"] not in answered
                       for m in messages if isinstance(m, AIMessage) for c in m.tool_calls):
                return None
            patched: list = []
            for m in messages:
                patched.append(m)
                if isinstance(m, AIMessage):
                    for c in m.tool_calls:
                        if c.get("id") and c["id"] not in answered:
                            patched.append(ToolMessage(content=f"[未执行] 工具 {c['name']} 的这次调用被中断，没有结果",
                                                       name=c["name"], tool_call_id=c["id"]))
            return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *patched]}

    return PatchDanglingToolCalls()


def _task_tool(subs: dict[str, tuple[Any, str]]) -> Any:
    """委派给子代理：子代理独立上下文跑完，最后一条回复作为工具结果交回。"""
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field

    class TaskArgs(BaseModel):
        subagent: str = Field(description="子代理名：" + "、".join(subs))
        description: str = Field(description="交给子代理的完整说明：背景、要查什么、要交回什么。它看不到你的对话")

    async def task(subagent: str, description: str) -> str:
        hit = subs.get(subagent)
        if hit is None:
            return f"[参数] 没有子代理 {subagent}（可选：{'、'.join(subs)}）"
        result = await hit[0].ainvoke({"messages": [HumanMessage(content=description)]}, {"recursion_limit": 120})
        for m in reversed(result.get("messages") or []):
            if isinstance(m, AIMessage) and _text(m.content).strip():
                return _text(m.content)
        return "（子代理没有给出文字结论）"

    listing = "\n".join(f"- {n}：{d}" for n, (_, d) in subs.items())
    return StructuredTool.from_function(
        coroutine=task, name="task", args_schema=TaskArgs,
        description=f"把一个子问题委派给子代理，它用自己的工具独立完成后交回结论。可用的子代理：\n{listing}")


def _submit_tool(schema: dict) -> Any:
    """结构化结果的提交口：参数即任务的 output_schema，当场校验，不合格把错误还给模型。"""
    import jsonschema
    from langchain_core.tools import StructuredTool

    validator = jsonschema.Draft202012Validator(schema)

    async def submit_result(**data: Any) -> str:
        errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
        if errors:
            detail = "；".join(f"{'/'.join(map(str, e.path)) or '（顶层）'}：{e.message}" for e in errors[:5])
            return f"[不符合要求] {detail}。改好后重新调用 {SUBMIT_TOOL}。"
        return f"{_ACCEPTED}。再用一两句话给出文字结论即可结束。"

    return StructuredTool(name=SUBMIT_TOOL, coroutine=submit_result, args_schema=schema,
                          description=schema.get("description") or "交回本任务要求的结构化结果（字段见参数），结论确定后调用。")


# ==================== 执行 ====================

async def invoke(agent: Any, run_id: str, thread_id: str, prompt: str | None, structured: bool = False) -> dict:
    """执行一次（prompt=None 表示从 checkpoint 续跑），事件实时落 run_events。
    → {"answer": 文字结论, "data": 结构化结果（声明了 output_schema 才有；没交成是 None）}。"""
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": 200}
    payload = None if prompt is None else {"messages": [{"role": "user", "content": prompt}]}
    await _stream(agent, run_id, payload, config)
    messages = await _messages(agent, config)
    out: dict[str, Any] = {"answer": _answer(messages)}
    if structured:
        data = _submitted(messages)
        if data is None:                  # 没交或没交成：提醒一次
            await runs.log_event(run_id, "stage", {"stage": "output", "title": "提醒交回结构化结果",
                                                   "content": f"运行结束时还没有通过校验的 {SUBMIT_TOOL}，提醒一次。"})
            await _stream(agent, run_id, {"messages": [{"role": "user", "content":
                          f"还没有用 {SUBMIT_TOOL} 交回通过校验的结构化结果。请现在调用 {SUBMIT_TOOL} 交回。"}]}, config)
            messages = await _messages(agent, config)
            data = _submitted(messages)
            out["answer"] = _answer(messages) or out["answer"]
        out["data"] = data
    return out


async def _stream(agent: Any, run_id: str, payload: Any, config: dict) -> None:
    """事件 → run_events：每次模型调用一条 model_call（谁、耗时、输入 / 输出 token、调了哪些工具、调工具前的思考），
    每次工具调用一对 tool_call / tool_result。子代理里发生的带 agent 字段。"""
    from ..model.pool import queue_wait

    tokens = 0
    started: dict[str, tuple[float, float]] = {}
    waited = [0.0]                                  # 这次执行里模型请求在配额上排队的累计毫秒（model/pool.py）
    token = queue_wait.set(waited)
    try:
        async for ev in agent.astream_events(payload, config=config, version="v2"):
            tokens += await _record(run_id, ev, started, waited)
    finally:
        queue_wait.reset(token)
    if tokens:
        await runs.add_tokens(run_id, tokens)


async def _record(run_id: str, ev: dict, started: dict[str, tuple[float, float]], waited: list[float]) -> int:
    """一条流事件 → run_events；返回这条带来的 token 数。"""
    kind, name, data = ev.get("event", ""), ev.get("name", ""), ev.get("data") or {}
    meta = ev.get("metadata") or {}
    who = {"agent": meta["lc_agent_name"]} if meta.get("lc_agent_name") else {}
    if kind == "on_chat_model_start":
        started[ev.get("run_id", "")] = (time.monotonic(), waited[0])
    elif kind == "on_chat_model_end":
        msg = data.get("output")
        usage = getattr(msg, "usage_metadata", None) or {}
        n = int(usage.get("total_tokens") or 0)
        t0, w0 = started.pop(ev.get("run_id", ""), (None, waited[0]))
        calls = [c.get("name") for c in getattr(msg, "tool_calls", None) or []]
        content = _text(getattr(msg, "content", ""))
        reasoning = _text((getattr(msg, "additional_kwargs", None) or {}).get("reasoning_content") or "")
        event = {**who, "model": meta.get("ls_model_name"), "ms": int((time.monotonic() - t0) * 1000) if t0 else None,
                 "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens"),
                 "tokens": n or None, "tool_calls": calls}
        # ms 里有多少是在等账号配额（并发 / RPM）。按本次执行累计算：同时有几个子代理在调模型时是近似值
        if event["ms"] is not None and (queued := min(int(waited[0] - w0), event["ms"])) >= 500:
            event["queued_ms"] = queued
        # 思考：思考模型的 reasoning_content；没有时用调工具前说的话（不调工具的那次是最终回答，在 final 里）
        thought = reasoning.strip() or (content if calls else "")
        if thought:
            event["content"] = _clip(thought)
        await runs.log_event(run_id, "model_call", event)
        return n
    elif kind == "on_tool_start":
        await runs.log_event(run_id, "tool_call", {**who, "tool": name, "args": _clip_obj(data.get("input"))})
    elif kind == "on_tool_end":
        out = data.get("output")
        await runs.log_event(run_id, "tool_result", {**who, "tool": name,
                                                     "output": _clip(getattr(out, "content", out))})
    return 0


async def _messages(agent: Any, config: dict) -> list:
    state = await agent.aget_state(config)
    return (state.values.get("messages") if state else None) or []


def _answer(messages: list) -> str:
    """最后一条有文字的模型回复。"""
    for m in reversed(messages):
        if getattr(m, "type", "") == "ai" and _text(getattr(m, "content", "")).strip():
            return _text(m.content)
    return ""


def _submitted(messages: list) -> dict | None:
    """最后一次通过校验的 submit_result 的参数。"""
    args = {c["id"]: c.get("args") or {} for m in messages if getattr(m, "type", "") == "ai"
            for c in getattr(m, "tool_calls", None) or [] if c.get("name") == SUBMIT_TOOL}
    data = None
    for m in messages:
        if getattr(m, "type", "") == "tool" and m.tool_call_id in args and _text(m.content).startswith(_ACCEPTED):
            data = args[m.tool_call_id]
    return data


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
