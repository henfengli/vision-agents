"""Temporal Activities：run 执行的三个步骤。

prepare_run → run_agent → finalize_run，每步独立重试/超时，
 Temporal 事件历史即执行台账；业务台账（runs/run_events）仍写 PG 供查询。

Worker 启动时 configure() 注入依赖；activity 体内禁止访问未注入的全局状态。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from temporalio import activity

from ..memory import distill, recall_block
from ..roles import resolve
from ..store import ledger


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
async def prepare_run(spec: dict) -> dict:
    """步骤 1：建/更新台账行 + 角色解析 + 记忆召回 + 拼 prompt。

    API 触发时 run 行已由 gateway 建好；调度触发（spec.run_id 为空）时
    在这里现场生成 run_id 并建行——activities 允许非确定性。
    """
    d = _d()
    if not spec.get("run_id"):
        import uuid
        spec["run_id"] = uuid.uuid4().hex[:16]
        await ledger.create_run(
            spec["run_id"], spec["task_type"], spec["role"],
            domain=None, trigger_source=spec.get("trigger", "schedule"),
            caller=None, input_data=spec.get("input") or {},
            dedup_key=None, session_id=spec["run_id"])
        spec["session_id"] = spec["run_id"]
    await ledger.set_status(spec["run_id"], "running")
    from ..runtime.approvals import current_run_id
    current_run_id.set(spec["run_id"])

    role_defs = await d.engine.roles()
    role = resolve(spec["role"], role_defs)
    domain = spec.get("domain") or (role.domains[0] if role.domains else None)
    code_paths = []
    if domain and domain in d.settings.domains:
        code_paths = d.settings.domains[domain].code_paths

    prompt = spec["question"]
    recalled = ""
    if not spec.get("resume"):
        recalled = await recall_block(
            d.settings.env, domain, spec["question"],
            error_text=spec.get("error_text"), domain_code_paths=code_paths,
            embedder=getattr(d.model_pool, "embed", None),
            session_id=spec.get("session_id"))
        if recalled:
            prompt = f"{recalled}\n\n{spec['question']}"
            await _log(spec["run_id"], "note", {"stage": "recall", "content": recalled})
    return {"run_id": spec["run_id"], "prompt": prompt, "domain": domain,
            "code_paths": code_paths, "recalled": bool(recalled)}


@activity.defn
async def run_agent(spec: dict) -> dict:
    """步骤 2：DeepAgents 执行。崩溃由 Temporal 按策略重试本步骤。

    审批等待（bash 危险命令）在本 activity 内通过 DB+NOTIFY 挂起，
    hook 每轮等待调 activity.heartbeat()——Temporal 视为活跃，不占额外资源。
    """
    d = _d()
    run_id = spec["run_id"]
    agent = await d.engine.agent()
    # session_id 即 LangGraph thread：同一 session 自动续上下文；缺省退回 run_id
    config = {"configurable": {"thread_id": spec.get("session_id") or spec["run_id"]}}

    seq = await ledger.max_seq(run_id)

    async def log(kind: str, payload: dict) -> None:
        nonlocal seq
        seq += 1
        await ledger.append_event(run_id, seq, kind, payload)

    with _run_span(d, spec) as span:
        if span is not None:
            ctx = span.get_span_context()
            await log("trace", {"trace_id": format(ctx.trace_id, "032x"),
                                "span_id": format(ctx.span_id, "016x")})
        if spec.get("resume"):
            await log("note", {"stage": "resume",
                               "session_id": spec["session_id"]})
            result = await _invoke_streaming(agent, None, config, log)
        else:
            result = await _invoke_streaming(
                agent, {"messages": [{"role": "user", "content": spec["prompt"]}]},
                config, log)

    output_text = _extract_final_text(result)
    await log("llm", {"stage": "final", "content": output_text})
    return {"answer": output_text}


@activity.defn
async def finalize_run(spec: dict, output: dict) -> dict:
    """步骤 3：状态落库 + 记忆沉淀（含纠正反馈的旧记忆取代）。"""
    d = _d()
    await ledger.set_status(spec["run_id"], "done", output=output,
                            duration_ms=0)
    # 纠正式反馈：新结论沉淀前，把本 session 最近一次 run 沉淀的记忆标记为被取代。
    # 只杀最近的判断——纠正针对的是上一次结论，不误伤 session 里沉淀正确的历史知识。
    if spec.get("correction"):
        from ..store import cases as cases_store
        from ..store import knowledge as knowledge_store
        last = await ledger.runs_by_session(
            spec["session_id"], exclude=spec["run_id"], limit=1)
        old_ids = [r["run_id"] for r in last]
        await knowledge_store.supersede_by_runs(d.settings.env, old_ids,
                                                spec["run_id"])
        await cases_store.supersede_by_runs(d.settings.env, old_ids,
                                            spec["run_id"])
    try:
        await distill(d.model_pool, d.settings.env, spec.get("domain"),
                      spec["run_id"], spec["task_type"],
                      {"question": spec["question"], "error": spec.get("error_text")},
                      output, spec.get("code_paths") or [],
                      session_id=spec.get("session_id"))
    except Exception:  # noqa: BLE001 —— 沉淀失败不影响主流程
        pass
    return output


@activity.defn
async def mark_failed(spec: dict, error: str) -> None:
    await ledger.append_event(spec["run_id"], 9999, "note",
                              {"stage": "error", "error": error[:2000]})
    await ledger.set_status(spec["run_id"], "failed",
                            output={"error": error[:4000]}, duration_ms=0)


# ==================== 内部工具 ====================

async def _log(run_id: str, kind: str, payload: dict) -> None:
    seq = await ledger.max_seq(run_id)
    await ledger.append_event(run_id, seq + 1, kind, payload)


class _NullSpan:
    def __enter__(self): return None
    def __exit__(self, *a): return False


def _span_ctx(span):
    return span.get_span_context() if span is not None else None


def _run_span(d: Deps, spec: dict):
    """Langfuse run span：挂业务属性；未启用观测时是空上下文。"""
    from ..langfuse_client import tracer
    t = tracer()
    if t is None:
        return _NullSpan()
    return t.start_as_current_span(
        "agent.run",
        attributes={"agent.run_id": spec["run_id"],
                    "agent.task_type": spec["task_type"],
                    "agent.role": spec["role"],
                    "agent.env": d.settings.env,
                    "agent.session_id": spec.get("session_id") or ""})


async def _invoke_streaming(agent: Any, payload: Any, config: dict, log) -> dict:
    """事件流执行：模型步/工具调用实时落 PG 台账（SSE 与 Viewer 数据源）。"""
    if not hasattr(agent, "astream_events"):
        return await agent.ainvoke(payload, config=config)

    async for ev in agent.astream_events(payload, config=config, version="v2"):
        node = (ev.get("metadata") or {}).get("langgraph_node", "")
        name = ev.get("name", "")
        kind, data = ev.get("event", ""), ev.get("data") or {}
        if kind == "on_tool_start":
            await log("tool_call", {"node": node, "tool": name,
                                    "args": _clip(data.get("input"))})
        elif kind == "on_tool_end":
            await log("tool_result", {"node": node, "tool": name,
                                      "output": _clip(data.get("output"))})
        elif kind == "on_chat_model_end":
            msg = data.get("output")
            content = getattr(msg, "content", "") if msg is not None else ""
            if content:
                await log("thought", {"node": node, "content": _clip(content)})

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
