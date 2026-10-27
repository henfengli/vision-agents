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
import re
import time
import uuid
from contextvars import ContextVar
from typing import Any

from ..config import Settings
from ..domain import PromptsConfig, Rejected, ResolvedRole
from ..store import runs
from . import scope as run_scope
from .tools.catalog import Toolbox

log = logging.getLogger(__name__)

SUBMIT_TOOL = "submit_result"
_ACCEPTED = "已收到结构化结果"

# 模型调用次数上限（一次"想 → 调工具"算一次）。到了不报错：停用工具，让 agent 交代查到了什么、还剩什么（ExecutionGuard）。
MODEL_CALL_LIMIT = 80
SUBAGENT_MODEL_CALL_LIMIT = 40
# LangGraph 的步数上限只是兜底（每轮约 3 个节点：压缩检查、模型、工具），正常情况下先到上面的次数上限
STEP_LIMIT = MODEL_CALL_LIMIT * 3 + 40
SUBAGENT_STEP_LIMIT = SUBAGENT_MODEL_CALL_LIMIT * 3 + 30

WRAP_UP = ("[步数用完] 这次运行的模型调用次数已到上限，工具已停用。不要再调用工具，直接用文字回答：\n"
           "1. 已经查明的事实和依据（命令输出、SQL、代码位置）；\n2. 结论（证据不足的标为推测）；\n"
           "3. 还没做完的事和建议的下一步。")
WRAP_UP_SUBMIT = (f"[步数用完] 这次运行的模型调用次数已到上限，除了 {SUBMIT_TOOL} 其他工具都已停用。"
                  f"用目前查到的调用 {SUBMIT_TOOL} 交回结构化结果（拿不准的按字段说明标出），交完再用文字简述："
                  "查明了什么、结论（证据不足的标为推测）、还没做完的事。")

# 修剪旧的工具输出（参照 Kilo Code 的 prune）：最近的工具输出原样保留，更早的换成一行说明，省上下文
PRUNE_KEEP_LAST = 6            # 最近这么多条工具结果不动
PRUNE_PROTECT_CHARS = 60_000   # 从后往前累计到这么多字之后的才修剪
PRUNE_MIN_CHARS = 20_000       # 能省下的不到这么多就不修剪（修剪会改变提示前缀，少动为好）
PRUNE_SKIP = ("todo", "task", SUBMIT_TOOL)      # task：子代理的结论，重查要重跑整个子代理

# 重复调用（参照 Kilo Code 的 doom loop）：同一工具同样参数、结果也一样，连续第 3 次提醒，第 5 次不再执行
REPEAT_WARN = 3
REPEAT_BLOCK = 5
REPEAT_SKIP = ("todo",)
_REPEAT_NOTE = "\n\n[注意] "
_BLOCKED = "[重复调用] "

# 这次执行的模型调用计数（主 agent 一份，每个子代理调用各一份；contextvar：并发的子代理互不影响）
_BUDGET: ContextVar[dict | None] = ContextVar("model_call_budget", default=None)


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
        return [_patch_middleware(), _guard_middleware(),
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


def _guard_middleware() -> Any:
    """执行护栏（参照 Kilo Code）：
    - 模型调用次数到上限：这次调用不让再用工具（结构化任务只留 submit_result），追加收尾说明，让它交代结果
    - 修剪旧的工具输出：发给模型的消息里，较早的大段工具结果换成一行说明（状态里的原文不动）
    - 重复调用：同一工具同样参数连续第 3 次且结果都一样，结果后面加提醒；第 5 次不再执行"""
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.messages import HumanMessage, ToolMessage

    class ExecutionGuard(AgentMiddleware):
        async def awrap_model_call(self, request: Any, handler: Any) -> Any:
            budget = _BUDGET.get()
            messages = prune_tool_outputs(request.messages, budget.setdefault("pruned", set()) if budget is not None else None)
            overrides: dict[str, Any] = {"messages": messages} if messages is not request.messages else {}
            if budget is not None:
                budget["calls"] += 1
                if budget["calls"] > budget["max"]:
                    submit = [t for t in request.tools if _tool_name(t) == SUBMIT_TOOL]
                    overrides["messages"] = [*(overrides.get("messages") or request.messages),
                                             HumanMessage(WRAP_UP_SUBMIT if submit else WRAP_UP)]
                    # 停用工具：结构化任务只留交结果的口子；其余保留工具定义但不许调用（有的网关不收"历史里有工具调用却没给工具"）
                    overrides.update({"tools": submit} if submit else {"tool_choice": "none"})
                    if not budget.get("wrapped"):
                        budget["wrapped"] = True
                        await _log_stage("step_limit", f"模型调用到上限（{budget['max']} 次）：停用工具，让 agent 收尾",
                                         budget.get("agent"))
            return await handler(request.override(**overrides) if overrides else request)

        async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
            call = request.tool_call
            name = call.get("name") or ""
            if name in REPEAT_SKIP:
                return await handler(request)
            state = request.state
            messages = (state.get("messages") if isinstance(state, dict) else getattr(state, "messages", None)) or []
            repeats, same = repeated_calls(messages, call)
            if repeats + 1 >= REPEAT_BLOCK and same:    # 结果在变的是轮询（sleep 再查），不拦
                text = (f"{_BLOCKED}已经连续 {repeats + 1} 次用同样的参数调用 {name}，结果都一样，不再执行。"
                        "换个查法（换参数、换工具、先看别的线索），或者用目前查到的给出结论。")
                await _log_blocked(name, call.get("args"), text)   # 工具没跑就没有 tool_call 事件：补上，时间线看得到
                return ToolMessage(content=text, tool_call_id=call.get("id") or "", name=name, status="error")
            result = await handler(request)
            if repeats + 1 >= REPEAT_WARN and same and isinstance(result, ToolMessage):
                warn = (f"{_REPEAT_NOTE}这是连续第 {repeats + 1} 次用同样的参数调用 {name}，前几次的结果都一样。"
                        "在等状态变化就先 bash sleep 一会儿再查；否则换个做法，别再原样重试。")
                result = result.model_copy(update={"content": _text(result.content) + warn})
            return result

    return ExecutionGuard()


def _tool_name(tool: Any) -> str:
    return tool.get("name", "") if isinstance(tool, dict) else getattr(tool, "name", "")


async def _log_stage(stage: str, title: str, agent: str | None = None) -> None:
    sc = run_scope.maybe_current()
    if sc is None:
        return
    try:
        await runs.log_event(sc.run_id, "stage", {"stage": stage, "title": title, **({"agent": agent} if agent else {})})
    except Exception:  # noqa: BLE001
        log.debug("记录阶段事件失败", exc_info=True)


async def _log_blocked(name: str, args: Any, text: str) -> None:
    sc = run_scope.maybe_current()
    if sc is None:
        return
    budget = _BUDGET.get() or {}
    who = {"agent": budget["agent"]} if budget.get("agent") else {}
    try:
        call = f"blocked-{uuid.uuid4().hex[:8]}"
        await runs.log_event(sc.run_id, "tool_call", {**who, "tool": name, "call": call, "args": _clip_obj(args)})
        await runs.log_event(sc.run_id, "tool_result", {**who, "tool": name, "call": call, "output": text})
    except Exception:  # noqa: BLE001
        log.debug("记录被拦下的调用失败", exc_info=True)


_SPILLED = re.compile(r"全文在 (\S+?)[：:，,\s]")


def prune_tool_outputs(messages: list, pruned: set | None = None) -> list:
    """较早的大段工具结果换成一行说明（只改这次发给模型的，状态里的不动）。没东西可修剪时原样返回同一个列表。
    pruned：这次执行里已经修剪过的 tool_call_id。新的可修剪的攒够 PRUNE_MIN_CHARS 才成批加进去，
    其间修剪的集合不变，发给模型的前缀保持稳定（不然每轮都改一条中间的消息，模型那边的前缀缓存全废）。"""
    tool_idx = [i for i, m in enumerate(messages) if getattr(m, "type", "") == "tool"]
    total, cand, saved = 0, [], 0
    for rank, i in enumerate(reversed(tool_idx)):
        m = messages[i]
        n = len(_text(m.content))
        total += n
        if rank < PRUNE_KEEP_LAST or total <= PRUNE_PROTECT_CHARS or n < 500 or (m.name or "") in PRUNE_SKIP:
            continue
        if pruned is None or m.tool_call_id not in pruned:
            cand.append(i)
            saved += n
    if pruned is None:
        if saved < PRUNE_MIN_CHARS:
            return messages
    else:
        if saved >= PRUNE_MIN_CHARS:
            pruned.update(messages[i].tool_call_id for i in cand)
        cand = [i for i in tool_idx if messages[i].tool_call_id in pruned]
        if not cand:
            return messages
    out = list(messages)
    for i in cand:
        m = out[i]
        text = _text(m.content)
        spilled = _SPILLED.search(text)
        where = f"全文在 {spilled.group(1)}，" if spilled else ""
        note = (f"[较早的工具输出已省略以节省上下文：{m.name or '工具'}，原 {len(text)} 字。{where}"
                f"开头：{text[:160].strip()}…；需要细节就重新查]")
        out[i] = m.model_copy(update={"content": note})
    return out


def repeated_calls(messages: list, call: dict) -> tuple[int, bool]:
    """在这次调用之前，紧挨着有几次同名同参数的调用；它们的结果是否都一样。"""
    def key(c: dict) -> tuple[str, str]:
        return c.get("name") or "", json.dumps(c.get("args") or {}, sort_keys=True, ensure_ascii=False, default=str)

    current, cid = key(call), call.get("id")
    before: list[tuple[str, tuple[str, str]]] = []
    for m in messages:
        kind = getattr(m, "type", "")
        if kind == "human":
            before = []                          # 新的一轮（同会话的上一次运行）不连着算
        if kind != "ai":
            continue
        for c in getattr(m, "tool_calls", None) or []:
            if c.get("id") == cid:
                break
            before.append((c.get("id") or "", key(c)))
    # 比结果时去掉守卫自己追加的提醒
    results = {getattr(m, "tool_call_id", ""): _text(m.content).split(_REPEAT_NOTE, 1)[0]
               for m in messages if getattr(m, "type", "") == "tool"}
    n, outputs = 0, set()
    for prev_id, k in reversed(before):
        if k != current:
            break
        out = results.get(prev_id)
        if out is None:                          # 同一条消息里并发的、还没有结果的：不算
            continue
        n += 1
        if not out.startswith(_BLOCKED):         # 被守卫拦下的不算"结果变了"，拦截保持有效
            outputs.add(out)
    return n, len(outputs) <= 1


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
        from langgraph.errors import GraphRecursionError
        # 子代理自己一份调用次数：到上限时它会被要求收尾，把查到的交回来
        token = _BUDGET.set({"calls": 0, "max": SUBAGENT_MODEL_CALL_LIMIT, "agent": subagent})
        try:
            result = await hit[0].ainvoke({"messages": [HumanMessage(content=description)]},
                                          {"recursion_limit": SUBAGENT_STEP_LIMIT})
        except GraphRecursionError:
            return (f"[子代理步数用完] {subagent} 走了 {SUBAGENT_STEP_LIMIT} 步还没结束（可能在原地打转）。"
                    "把子问题拆小、写清楚要交回什么再委派，或者自己接着做")
        finally:
            _BUDGET.reset(token)
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
    from langgraph.errors import GraphRecursionError
    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": STEP_LIMIT}
    payload = None if prompt is None else {"messages": [{"role": "user", "content": prompt}]}
    budget = {"calls": 0, "max": MODEL_CALL_LIMIT}
    token = _BUDGET.set(budget)
    try:
        try:
            await _stream(agent, run_id, payload, config)
        except GraphRecursionError:
            raise Rejected("step_limit", f"agent 走了 {STEP_LIMIT} 步（模型调用 + 工具调用）还没结束，可能在原地打转："
                                         "看最后几步在做什么，改提示词或把问题拆小；续跑会从断点接着走") from None
        messages = await _messages(agent, config)
        out: dict[str, Any] = {"answer": _answer(messages)}
        if structured:
            data = _submitted(messages)
            if data is None:                  # 没交或没交成：提醒一次
                await runs.log_event(run_id, "stage", {"stage": "output", "title": "提醒交回结构化结果",
                                                       "content": f"运行结束时还没有通过校验的 {SUBMIT_TOOL}，提醒一次。"})
                if not budget.get("wrapped"):              # 收尾过的保持收尾（只剩 submit_result），没收尾的至少再给 3 次
                    budget["max"] = max(budget["max"], budget["calls"] + 3)
                await _stream(agent, run_id, {"messages": [{"role": "user", "content":
                              f"还没有用 {SUBMIT_TOOL} 交回通过校验的结构化结果。请现在调用 {SUBMIT_TOOL} 交回。"}]}, config)
                messages = await _messages(agent, config)
                data = _submitted(messages)
                out["answer"] = _answer(messages) or out["answer"]
            out["data"] = data
        if budget.get("wrapped"):
            out["step_limit"] = True                       # 到了次数上限、是收尾时给的结论：运行详情据此标注
        return out
    finally:
        _BUDGET.reset(token)


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
        # ms 里有多少是在等账号的并发名额。按本次执行累计算：同时有几个子代理在调模型时是近似值
        if event["ms"] is not None and (queued := min(int(waited[0] - w0), event["ms"])) >= 500:
            event["queued_ms"] = queued
        # 思考：思考模型的 reasoning_content；没有时用调工具前说的话（不调工具的那次是最终回答，在 final 里）
        thought = reasoning.strip() or (content if calls else "")
        if thought:
            event["content"] = _clip(thought)
        await runs.log_event(run_id, "model_call", event)
        return n
    elif kind == "on_tool_start":
        # call：同一次工具调用的 tool_call / tool_result 用它配对（并发调同一个工具时只靠工具名配不准）
        await runs.log_event(run_id, "tool_call", {**who, "tool": name, "call": ev.get("run_id", "")[:12],
                                                   "args": _clip_obj(data.get("input"))})
    elif kind == "on_tool_end":
        out = data.get("output")
        await runs.log_event(run_id, "tool_result", {**who, "tool": name, "call": ev.get("run_id", "")[:12],
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
