"""Temporal Activities：run 执行的三个步骤。

prepare_run → run_agent → finalize_run，每步独立重试/超时，
Temporal 事件历史即执行台账；业务台账（runs/run_events）仍写 PG 供查询。

依赖注入：Temporal 要求 activity 是模块级函数，不能走构造函数——
Worker 启动时 configure() 注入 Deps，activity 体内禁止访问未注入的全局状态。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from temporalio import activity

from ..agent.approvals import current_run_id
from ..agent.roles import resolve
from ..memory import distill, recall_block
from ..store import artifacts as artifacts_store
from ..store import cases as cases_store
from ..store import definitions as definitions_store
from ..store import knowledge as knowledge_store
from ..store import runs
from .spec import RunSpec


@dataclass
class Deps:
    settings: Any
    engine: Any
    model_pool: Any
    notifier: Any
    langfuse: Any          # LangfuseClient | None


_deps: Deps | None = None


def configure(deps: Deps) -> None:
    global _deps
    _deps = deps


def _d() -> Deps:
    if _deps is None:
        raise RuntimeError("activities 未配置：worker 启动时先调用 configure()")
    return _deps


@activity.defn
async def prepare_run(raw: dict) -> dict:
    """步骤 1：建/更新台账行 + 谱系固定 + 角色解析 + 记忆召回 + 拼 prompt。

    API 触发时 run 行已由 Submitter 建好；调度触发（run_id 为空）时
    在这里现场生成 run_id 并建行——activities 允许非确定性。
    资产图任务（spec.artifacts 非空）不做单角色解析与召回：角色/产物
    在节点物化时逐个解析；这里只固定任务版本、落图拓扑事件（Viewer 血缘图）。
    """
    d = _d()
    spec = RunSpec.from_dict(raw)
    if not spec.run_id:
        spec.run_id = uuid.uuid4().hex[:16]
        spec.session_id = spec.run_id
        await runs.create(spec.run_id, spec.task_type, spec.role, domain=None,
                          trigger_source=spec.trigger or "schedule", caller="",
                          input_data=spec.input, session_id=spec.session_id)
    await runs.set_status(spec.run_id, "running")
    current_run_id.set(spec.run_id)

    # 谱系固定：记录本 run 实际使用的定义版本——事后排查"当时用的是哪版
    # prompt"靠它，而不是靠猜。版本取 prepare 这一刻的生效版本（直读库）。
    task_version = await definitions_store.active_version(
        "task", d.settings.env, spec.task_type)
    role_version = (await definitions_store.active_version(
        "role", d.settings.env, spec.role)) if spec.role else None
    await runs.set_def_versions(spec.run_id, task_version, role_version)

    if spec.artifacts is not None:
        from .artgraph import NodeDef, topo_layers
        nodes = {n: NodeDef.model_validate(nd) for n, nd in spec.artifacts.items()}
        topo_layers(nodes)  # 声明期校验：环/悬空依赖在 prepare 即失败
        await runs.log_event(spec.run_id, "graph", {
            "nodes": [{"id": n, "label": n} for n in nodes],
            "edges": [{"source": dep, "target": n}
                      for n, node in nodes.items() for dep in node.deps]})
        return spec.to_dict()

    role = resolve(spec.role, await d.engine.roles())
    spec.domain = spec.domain or (role.domains[0] if role.domains else None)
    # 目标环境：run 操作哪套业务环境——域连接信息（code_paths/只读库）与
    # 记忆分区都按它解析；定义版本仍按实例标签固定（一套部署一套定义）
    t_env = spec.effective_env(d.settings.env)
    if spec.domain and spec.domain in d.settings.domains:
        spec.code_paths = d.settings.domains[spec.domain].for_env(t_env).code_paths

    spec.prompt = spec.question
    if not spec.resume:
        recalled = await recall_block(
            t_env, spec.domain, spec.question,
            error_text=spec.error_text, domain_code_paths=spec.code_paths,
            embedder=d.model_pool.embed, session_id=spec.session_id)
        if recalled:
            spec.prompt = f"{recalled}\n\n{spec.question}"
            await runs.log_event(spec.run_id, "note",
                                 {"stage": "recall", "content": recalled})
    return spec.to_dict()


@activity.defn
async def run_agent(raw: dict) -> dict:
    """步骤 2：DeepAgents 执行。崩溃由 Temporal 按策略重试本步骤。

    审批等待（危险命令）在本 activity 内通过 DB+NOTIFY 挂起，
    hook 每轮等待调 activity.heartbeat()——Temporal 视为活跃，不占额外资源。
    """
    d = _d()
    spec = RunSpec.from_dict(raw)
    agent = await d.engine.agent()
    # session_id 即 LangGraph thread：同一 session 自动续上下文；缺省退回 run_id
    config = {"configurable": {"thread_id": spec.session_id or spec.run_id}}

    with _run_span(d, spec) as span:
        if span is not None:
            ctx = span.get_span_context()
            await runs.log_event(spec.run_id, "trace",
                                 {"trace_id": format(ctx.trace_id, "032x"),
                                  "span_id": format(ctx.span_id, "016x")})
        if spec.resume:
            await runs.log_event(spec.run_id, "note",
                                 {"stage": "resume", "session_id": spec.session_id})
            result = await _invoke_streaming(agent, None, config, spec.run_id)
        else:
            result = await _invoke_streaming(
                agent, {"messages": [{"role": "user", "content": spec.prompt}]},
                config, spec.run_id)

    output_text = _extract_final_text(result)
    await runs.log_event(spec.run_id, "llm",
                         {"stage": "final", "content": output_text})
    return {"answer": output_text}


@activity.defn
async def finalize_run(raw: dict, output: dict) -> dict:
    """步骤 3：状态落库 + 记忆沉淀（含纠正反馈的旧记忆取代）。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    await runs.set_status(spec.run_id, "success", output=output)
    # 纠正式反馈：新结论沉淀前，把本 session 最近一次 run 沉淀的记忆标记为被取代。
    # 只杀最近的判断——纠正针对的是上一次结论，不误伤 session 里沉淀正确的历史知识。
    t_env = spec.effective_env(d.settings.env)  # 记忆按目标环境分区
    if spec.correction and spec.session_id:
        last = await runs.latest_of_session(spec.session_id, exclude=spec.run_id)
        old_ids = [last["run_id"]] if last else []
        await knowledge_store.supersede_by_runs(t_env, old_ids, spec.run_id)
        await cases_store.supersede_by_runs(t_env, old_ids, spec.run_id)
    try:
        await distill(d.model_pool, t_env, spec.domain,
                      spec.run_id, spec.task_type,
                      {"question": spec.question, "error": spec.error_text},
                      output, spec.code_paths, session_id=spec.session_id)
    except Exception:  # noqa: BLE001 —— 沉淀失败不影响主流程
        pass
    return output


@activity.defn
async def mark_failed(raw: dict, error: str) -> None:
    spec = RunSpec.from_dict(raw)
    await runs.log_event(spec.run_id, "note",
                         {"stage": "error", "error": error[:2000]})
    await runs.set_status(spec.run_id, "failed",
                          output={"error": error[:4000]})


# ==================== 内部工具 ====================

class _NullSpan:
    def __enter__(self):
        return None

    def __exit__(self, *a):
        return False


def _run_span(d: Deps, spec: RunSpec):
    """Langfuse run span：挂业务属性；未启用观测时是空上下文。"""
    from ..langfuse import tracer
    t = tracer()
    if t is None:
        return _NullSpan()
    return t.start_as_current_span(
        "agent.run",
        attributes={"agent.run_id": spec.run_id,
                    "agent.task_type": spec.task_type,
                    "agent.role": spec.role,
                    "agent.env": d.settings.env,
                    "agent.target_env": spec.effective_env(d.settings.env),
                    "agent.session_id": spec.session_id or ""})


async def _invoke_streaming(agent: Any, payload: Any, config: dict,
                            run_id: str) -> dict:
    """事件流执行：模型步/工具调用实时落 PG 台账（SSE 与 Viewer 数据源）。"""
    if not hasattr(agent, "astream_events"):
        return await agent.ainvoke(payload, config=config)

    async for ev in agent.astream_events(payload, config=config, version="v2"):
        node = (ev.get("metadata") or {}).get("langgraph_node", "")
        name = ev.get("name", "")
        kind, data = ev.get("event", ""), ev.get("data") or {}
        if kind == "on_tool_start":
            await runs.log_event(run_id, "tool_call",
                                 {"node": node, "tool": name,
                                  "args": _clip(data.get("input"))})
        elif kind == "on_tool_end":
            await runs.log_event(run_id, "tool_result",
                                 {"node": node, "tool": name,
                                  "output": _clip(data.get("output"))})
        elif kind == "on_chat_model_end":
            msg = data.get("output")
            content = getattr(msg, "content", "") if msg is not None else ""
            if content:
                await runs.log_event(run_id, "thought",
                                     {"node": node, "content": _clip(content)})

    snap = await agent.aget_state(config)
    return {"messages": (snap.values.get("messages") if snap else []) or []}


def _clip(value: Any, limit: int = 2000) -> str:
    text = value if isinstance(value, str) else repr(value)
    return text if len(text) <= limit else text[:limit] + "…[截断]"


def _extract_final_text(result: dict) -> str:
    messages = result.get("messages") or []
    if not messages:
        return ""
    last = messages[-1]
    content = getattr(last, "content", None) or last.get("content", "")
    return content if isinstance(content, str) else str(content)


# ==================== 资产化任务图 activities ====================
# 解释器（纯逻辑）在 artgraph.py；这里是它的全部 IO 落点。
# 节点产物经 artifacts 表流转；执行细节落 run_events 台账（Viewer 可见）。

# code 节点的确定性函数注册表：内核代码登记（要 code review 的逻辑本就该在代码里），
# 域包/任务定义只引用名字。用法：@code_node("inspection.collect_scope")
CODE_NODES: dict[str, Callable[..., Any]] = {}


def code_node(name: str):
    def deco(fn):
        CODE_NODES[name] = fn
        return fn
    return deco


def _summarize(content: Any, limit: int = 500) -> str:
    text = content if isinstance(content, str) else json.dumps(
        content, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…[截断，完整内容用 read_artifact 读取]"


@activity.defn
async def art_materialize(raw: dict, name: str, node_def: dict,
                          payload: dict) -> dict:
    """物化一个产物节点：输入指纹未变直接复用旧产物，否则按类型执行。

    payload: {"deps": {名: 内容}} 或 map 扇出时的 {"item", "index", "deps"}。
    """
    d = _d()
    spec = RunSpec.from_dict(raw)
    t_env = spec.effective_env(d.settings.env)  # 产物复用按目标环境分区
    hash_ = artifacts_store.input_hash(
        {"name": name, "node": node_def}, payload)

    reused = await artifacts_store.find_reusable(
        spec.task_type, name, hash_, prefer_run=spec.run_id,
        target_env=t_env)
    if reused is not None:
        await artifacts_store.put(spec.run_id, spec.task_type, name,
                                  reused["content"], hash_, status="reused",
                                  target_env=t_env)
        await runs.log_event(spec.run_id, "note",
                             {"stage": "artifact", "node": name,
                              "status": "reused", "reason": "输入指纹未变"})
        return {"content": reused["content"], "reused": True}

    await runs.log_event(spec.run_id, "note",
                         {"stage": "artifact", "node": name, "status": "start"})
    content = await _execute_node(d, spec, name, node_def, payload)
    await artifacts_store.put(spec.run_id, spec.task_type, name, content, hash_,
                              target_env=t_env)
    await runs.log_event(spec.run_id, "note",
                         {"stage": "artifact", "node": name,
                          "status": "materialized",
                          "content": _summarize(content)})
    return {"content": content, "reused": False}


async def _execute_node(d: Deps, spec: RunSpec, name: str, node_def: dict,
                        payload: dict) -> Any:
    deps = payload.get("deps") or {}
    if node_def.get("code"):
        fn = CODE_NODES.get(node_def["code"])
        if fn is None:
            raise ValueError(f"code 节点 {node_def['code']} 未在 CODE_NODES 注册")
        result = fn(payload)
        return await result if hasattr(result, "__await__") else result

    if node_def.get("route"):
        route = node_def["route"]
        choices = route["choices"]
        deps_text = "\n".join(f"- {k}: {_summarize(v)}" for k, v in deps.items())
        resp = await d.model_pool.chat([
            {"role": "system",
             "content": f"你是分诊器（{route.get('by', 'router')}）。"
                        f"只能回复以下枚举之一，不要任何其他字符：{choices}"},
            {"role": "user",
             "content": f"任务：{spec.task_type}\n输入：{_summarize(spec.input)}\n"
                        f"依赖产物：\n{deps_text}"}])
        choice = (resp.choices[0].message.content or "").strip().strip('"')
        if choice not in choices:
            raise ValueError(f"route 节点 {name} 返回枚举外取值：{choice!r}")
        return choice

    # agent 节点：角色 + 契约 + 依赖产物清单（大产物由 agent 用工具按需读）
    agent_cfg = node_def["agent"]
    role_name = agent_cfg["role"]
    deps_text = "\n".join(f"- {k}: {_summarize(v)}" for k, v in deps.items()) or "（无）"
    item = payload.get("item")
    question = (
        f"你是 {role_name}。本次是资产图任务的节点 {name}。\n"
        f"产出契约：{agent_cfg.get('contract', '按角色职责产出')}\n"
        f"任务输入：{_summarize(spec.input)}\n"
        + (f"本次处理对象（第 {payload.get('index', 0) + 1} 项）："
           f"{_summarize(item, 1000)}\n" if payload.get("item") is not None else "")
        + f"依赖产物（摘要；完整内容用 read_artifact 工具按名字读取）：\n{deps_text}\n"
          f"要求：只输出本节点产物的 JSON 内容本身，不要解释。")
    agent = await d.engine.agent()
    config = {"configurable": {"thread_id": f"{spec.run_id}:{name}"}}
    result = await _invoke_streaming(agent, {"messages": [
        {"role": "user", "content": question}]}, config, spec.run_id)
    text = _extract_final_text(result)
    try:  # 契约产物尽量结构化；模型多说话就保留原文
        return json.loads(text.strip().removeprefix("```json")
                          .removesuffix("```").strip())
    except (json.JSONDecodeError, AttributeError):
        return text


@activity.defn
async def art_gate(run_id: str, node: str, summary: str) -> bool:
    """产物闸门：人工审批通过才物化。拒绝/超时 = 节点记 rejected（跳过）。"""
    from ..agent import approvals
    d = _d()
    approval_id = await approvals.request_approval(
        run_id, f"产物门禁｜节点 {node}\n{summary}")
    if d.notifier is not None:
        await d.notifier.send_action_card(
            "产物待审批", f"run `{run_id}` 的节点 `{node}`：\n{summary}",
            "去审批", f"{d.settings.viewer_base_url}/approvals/{run_id}")
    try:
        await approvals.wait_decision(approval_id)
        return True
    except Exception:  # 拒绝或超时：安全侧默认，不物化
        spec_task, t_env = "", ""
        run = await runs.get(run_id)
        if run:
            spec_task = run["task_type"]
            t_env = run.get("target_env") or ""
        await artifacts_store.mark(run_id, spec_task, node, "rejected",
                                   target_env=t_env)
        return False


@activity.defn
async def art_mark(run_id: str, task_type: str, name: str, status: str,
                   target_env: str = "") -> None:
    """记录节点跳过/拒绝状态（Viewer 血缘图染色的数据源）。"""
    await artifacts_store.mark(run_id, task_type, name, status,
                               target_env=target_env)
    await runs.log_event(run_id, "note",
                         {"stage": "artifact", "node": name, "status": status})


# ==================== 内建任务处理器（#5 园丁等的口子） ====================


@activity.defn
async def run_builtin_task(raw: dict) -> dict:
    """内建任务：不过模型的确定性维护作业（如 memory-gardener）。

    单 activity 完成 建行→执行→落终态：维护作业允许整体重试，
    无需拆步骤。新增内建任务 = 在 HANDLERS 登记一个 async 函数。
    """
    d = _d()
    spec = RunSpec.from_dict(raw)
    if not spec.run_id:
        spec.run_id = uuid.uuid4().hex[:16]
        spec.session_id = spec.run_id
        await runs.create(spec.run_id, spec.task_type, spec.role, domain=None,
                          trigger_source=spec.trigger or "schedule", caller="",
                          input_data=spec.input, session_id=spec.session_id)
    await runs.set_status(spec.run_id, "running")
    task_version = await definitions_store.active_version(
        "task", d.settings.env, spec.task_type)
    await runs.set_def_versions(spec.run_id, task_version, None)

    handler = HANDLERS.get(spec.handler or "")
    if handler is None:
        raise ValueError(f"未知内建任务处理器：{spec.handler}")
    try:
        output = await handler(d)
    except Exception as e:
        await runs.set_status(spec.run_id, "failed",
                              output={"error": str(e)[:4000]})
        raise
    await runs.set_status(spec.run_id, "success", output=output)
    return output


async def _gardener_handler(d: Deps) -> dict:
    """园丁按目标环境逐个巡检：记忆分区与域连接信息都按目标环境解析。"""
    from ..memory.gardener import run_gardener
    report = {}
    for env in d.settings.target_envs or [d.settings.env]:
        doms = {name: dom.for_env(env)
                for name, dom in d.settings.domains.items()}
        report[env] = await run_gardener(env, doms)
    return report


HANDLERS: dict[str, Callable[[Deps], Awaitable[dict]]] = {
    "memory-gardener": _gardener_handler,
}
