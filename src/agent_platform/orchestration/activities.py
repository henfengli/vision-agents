"""Temporal activities：一次运行的各个步骤。

    prepare → run_agent / 任务图节点 / run_builtin → finalize → deliver
                                    └─ 任何一步失败 → fail → deliver

每步独立重试与超时；运行台账（runs / run_events）写在 PG，供页面与接口查询。
Temporal 要求 activity 是模块级函数，依赖在 worker 启动时 configure() 注入。
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from .. import observability
from ..agent import factory as agent_factory
from ..agent import scope as run_scope
from ..agent.approvals import ApprovalRejected, Gatekeeper
from ..config import Settings
from ..domain import Rejected, RunRequest, RunTrigger, compose_profile
from ..domain.graph import NodeDef
from ..memory import distill, recall
from ..memory.gardener import run_gardener
from ..notify import Message, Notifier
from ..registry import Registry
from ..store import artifacts as artifacts_store
from ..store import assets as assets_store
from ..store import cases as cases_store
from ..store import knowledge as knowledge_store
from ..store import runs
from . import gates
from .spec import RunSpec

log = logging.getLogger(__name__)


@dataclass
class Deps:
    settings: Settings
    registry: Registry
    factory: agent_factory.AgentFactory
    gate: Gatekeeper
    notifier: Notifier
    model_pool: Any
    submitter: Any          # 定时触发经提交端发起运行


_deps: Deps | None = None


def configure(deps: Deps) -> None:
    global _deps
    _deps = deps


def _d() -> Deps:
    if _deps is None:
        raise RuntimeError("activities 未配置：worker 启动时先调用 configure()")
    return _deps


def rejected(e: Rejected) -> ApplicationError:
    """闸门拒绝 → 不重试的业务错误，原因码随错误带回 workflow。"""
    return ApplicationError(e.message, e.code, type="Rejected", non_retryable=True)


# ==================== 步骤 ====================


@activity.defn
async def prepare(raw: dict) -> dict:
    """定版本、重过开关（1–4 环）、拼提示：档案 → 运行环境 → 召回 → 方法 → 问题。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    run = await runs.get(spec.run_id)
    if run is None or run["status"] == "cancelled":
        raise ApplicationError("运行已取消", type="Cancelled", non_retryable=True)
    task = await d.registry.task(spec.task)
    if task is None:
        raise rejected(Rejected("unknown_task", f"任务 {spec.task} 已不存在"))
    try:
        await gates.check_switches(d.registry, task_name=spec.task, task=task.spec, service=spec.service, env=spec.env)
    except Rejected as e:
        raise rejected(e) from None

    role_version = None
    if spec.role:
        _role, versions = await d.registry.resolved_role(spec.role)
        role_version = versions[-1]
    await runs.set_status(spec.run_id, "running")
    await runs.set_versions(spec.run_id, task.version, role_version)

    if spec.form == "rule":
        out = spec.rule_output or {}
        await runs.log_event(spec.run_id, "stage", {
            "stage": "rule", "title": f"规则先行命中 · {out.get('category')}",
            "content": f"报错匹配规则 `{out.get('pattern')}`，直接给出结论，未调用模型。"})
        return spec.to_dict()
    if spec.form == "graph":
        nodes = {n: NodeDef.model_validate(x) for n, x in (spec.graph or {}).items()}
        await runs.log_event(spec.run_id, "stage", {
            "stage": "graph", "title": f"任务图 · {len(nodes)} 个节点",
            "nodes": [{"id": n, "kind": _node_kind(x)} for n, x in nodes.items()],
            "edges": [{"from": dep, "to": n} for n, x in nodes.items() for dep in x.deps]})
        return spec.to_dict()
    if spec.form != "agent":
        return spec.to_dict()

    view = await _view(d, spec)
    spec.code_paths = view.code_paths if view else []
    if spec.resume:                      # 续跑：提示已在 checkpoint 里，不重新拼
        return spec.to_dict()

    parts: list[str] = []
    service_profile = view.profile if view else {}
    profile = compose_profile(spec.service, service_profile, spec.task, task.spec.profile)
    if profile:
        parts.append(profile)
        await runs.log_event(spec.run_id, "stage", {"stage": "profile", "title": "档案", "content": profile})
    if view:
        parts.append(view.prompt_block())

    if spec.recall and spec.service:
        memory = await d.registry.config("memory")
        found = await recall(env=spec.env, service=spec.service, task=spec.task, query=spec.question,
                             error_text=spec.error_text, code_paths=spec.code_paths, session_id=spec.session_id,
                             run_id=spec.run_id, limit=memory.knowledge_limit, embedder=d.model_pool.embed)
        if found.text:
            parts.append(found.text)
            await runs.log_event(spec.run_id, "stage", {
                "stage": "recall", "title": f"召回 · 知识 {len(found.knowledge)} 条" + (" · 同类案例 1 条" if found.case_id else ""),
                "content": found.text, "hits": found.knowledge, "case_id": found.case_id})
        methods = await assets_store.search_active(spec.env, spec.service, spec.task.split(":")[0], limit=memory.asset_limit)
        if methods:
            block = _methods_block(methods)
            parts.append(block)
            await assets_store.mark_used([a["id"] for a in methods])
            await runs.log_event(spec.run_id, "stage", {
                "stage": "assets", "title": f"方法 · {len(methods)} 条", "content": block,
                "assets": [{"id": a["id"], "kind": a["kind"], "name": a["name"]} for a in methods]})

    parts.append(spec.question)
    spec.prompt = "\n\n".join(parts)
    return spec.to_dict()


@activity.defn
async def run_agent(raw: dict) -> dict:
    """按任务的角色装配 agent 执行；会话即 LangGraph thread，续跑从 checkpoint 接着走。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    role, versions = await d.registry.resolved_role(spec.role or "")
    agent = await d.factory.agent_for(role, versions)
    with run_scope.bind(await _scope(d, spec, role.tools)), \
            observability.run_span("agent.run", run_id=spec.run_id, task=spec.task, service=spec.service, env=spec.env):
        answer = await _heartbeating(agent_factory.invoke(
            agent, spec.run_id, thread_id=spec.session_id, prompt=None if spec.resume else spec.prompt))
    await runs.log_event(spec.run_id, "final", {"content": answer})
    return {"answer": answer}


@activity.defn
async def run_builtin(raw: dict) -> dict:
    """内建任务：不过模型的确定性维护作业。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    handler = BUILTINS.get(spec.handler or "")
    if handler is None:
        raise ApplicationError(f"未知的内建处理器：{spec.handler}（可用：{'、'.join(BUILTINS)}）",
                               "invalid_definition", type="Rejected", non_retryable=True)
    output = await _heartbeating(handler(d, spec))
    await runs.log_event(spec.run_id, "final", {"content": json.dumps(output, ensure_ascii=False, indent=2)})
    return output


@activity.defn
async def finalize(raw: dict, output: dict, resolution: str) -> None:
    """落成功、处理纠正、沉淀记忆、发通知。沉淀失败不翻案运行结果。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    if await _cancelled(spec.run_id):
        return
    await runs.set_status(spec.run_id, "success", output=output, resolution=resolution)
    if spec.correction:
        previous = await runs.latest_of_session(spec.session_id, exclude=spec.run_id)
        if previous:
            await knowledge_store.supersede_by_runs(spec.env, [previous["run_id"]], spec.run_id)
            await cases_store.supersede_by_runs(spec.env, [previous["run_id"]], spec.run_id)
    if spec.save and spec.service and resolution == "agent":
        memory = await d.registry.config("memory")
        try:
            await distill(d.model_pool, env=spec.env, service=spec.service, run_id=spec.run_id, task=spec.task,
                          run_input=spec.input, run_output=output, code_paths=spec.code_paths,
                          session_id=spec.session_id, handoff_summary=memory.handoff_summary)
        except Exception:
            log.exception("运行 %s 的记忆沉淀失败", spec.run_id)
    await _announce(d, spec, "run_succeeded", "运行成功", str(output.get("answer") or output)[:1500])
    if resolution == "rule":
        await runs.log_event(spec.run_id, "final", {"content": output.get("answer", "")})


@activity.defn
async def fail(raw: dict, message: str, code: str) -> None:
    d = _d()
    spec = RunSpec.from_dict(raw)
    if await _cancelled(spec.run_id):
        return
    await runs.log_event(spec.run_id, "error", {"title": code, "content": message[:4000]})
    await runs.set_status(spec.run_id, "failed", output={"error": message[:4000]}, error_code=code)
    await _announce(d, spec, "run_failed", "运行失败", f"`{code}` {message[:1200]}")


@activity.defn
async def deliver(raw: dict) -> None:
    """按任务声明把终态结果推出去（通知渠道 / HTTP 回调）。投递失败只留事件，不改运行结果。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    if not spec.deliver:
        return
    run = await runs.get(spec.run_id)
    if run is None:
        return
    output = run.get("output") or {}
    try:
        if spec.deliver.get("url"):
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(spec.deliver["url"], json={
                    "run_id": spec.run_id, "task": spec.task, "service": spec.service, "env": spec.env,
                    "status": run["status"], "output": output})
                resp.raise_for_status()
        else:
            text = output.get("answer") or output.get("error") or json.dumps(output, ensure_ascii=False)[:1500]
            await d.notifier.send(spec.deliver["channel"], Message(
                title=f"{spec.task} · {_STATUS_TEXT.get(run['status'], run['status'])}", text=str(text)[:3000],
                link=d.notifier.link(f"/runs/{spec.run_id}"), link_title="查看运行"))
    except Exception as e:
        if activity.info().attempt < 3:
            raise                                   # 交给 Temporal 重试
        await runs.log_event(spec.run_id, "stage", {"stage": "deliver", "title": "结果投递失败",
                                                    "content": f"{type(e).__name__}: {str(e)[:500]}"})


@activity.defn
async def fire_schedule(task: str, trigger_id: str, env: str) -> str | None:
    """定时触发：和 API 走同一个提交入口（同样的闸门、去重、台账），只是身份是 schedule。"""
    d = _d()
    entry = await d.registry.task(task)
    trigger = entry.spec.trigger(trigger_id) if entry else None
    if trigger is None or trigger.type != "schedule":
        log.warning("定时触发 %s/%s 已不存在，忽略本次", task, trigger_id)
        return None
    base, obj = task.split(":", 1) if ":" in task else (task, None)
    req = RunRequest(task=base, subtask=obj, env=env, input=trigger.input,
                     service=trigger.service if entry.spec.service == "*" else None)
    try:
        accepted = await d.submitter.submit(req, trigger=RunTrigger(type="schedule", id=trigger_id, caller="schedule"))
    except Rejected as e:
        log.warning("定时触发 %s/%s@%s 被拒：%s（%s）", task, trigger_id, env, e.message, e.code)
        return None
    return accepted.run_id


# ==================== 任务图节点 ====================
# 解释器（纯逻辑）在 artgraph.py；这里是它的 IO 落点。产物经 artifacts 表流转。

# code 节点的确定性函数：在内核代码里登记（@code_node("名字")），任务定义只引用名字
CODE_NODES: dict[str, Callable[[dict], Any]] = {}


def code_node(name: str):
    def register(fn):
        CODE_NODES[name] = fn
        return fn
    return register


@activity.defn
async def art_materialize(raw: dict, name: str, node: dict, payload: dict) -> dict:
    """物化一个节点：输入指纹没变就复用旧产物，否则按节点类型执行。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    fingerprint = artifacts_store.input_hash({"name": name, "node": node}, payload)
    reused = await artifacts_store.find_reusable(spec.task, name, fingerprint, prefer_run=spec.run_id, env=spec.env)
    if reused is not None:
        await artifacts_store.put(spec.run_id, spec.task, name, reused["content"], fingerprint, status="reused", env=spec.env)
        await runs.log_event(spec.run_id, "artifact", {"node": name, "status": "reused", "content": "输入未变，复用上次产物"})
        return {"content": reused["content"]}

    await runs.log_event(spec.run_id, "artifact", {"node": name, "status": "running"})
    try:
        content = await _heartbeating(_execute_node(d, spec, name, NodeDef.model_validate(node), payload))
    except Exception as e:
        await artifacts_store.mark(spec.run_id, spec.task, name, "failed", env=spec.env)
        await runs.log_event(spec.run_id, "artifact", {"node": name, "status": "failed", "content": str(e)[:1000]})
        raise
    await artifacts_store.put(spec.run_id, spec.task, name, content, fingerprint, env=spec.env)
    await runs.log_event(spec.run_id, "artifact", {"node": name, "status": "materialized", "content": _summary(content)})
    return {"content": content}


@activity.defn
async def art_gate(raw: dict, name: str, when: str) -> bool:
    """闸门节点：条件命中后等人放行。拒绝或超时 = 节点跳过。"""
    d = _d()
    spec = RunSpec.from_dict(raw)
    with run_scope.bind(await _scope(d, spec, [])):
        try:
            await d.gate.hold(kind="artifact", title=f"任务图节点 {name} · {spec.task}",
                              detail=f"条件 {when} 已命中，放行后物化节点 {name}", payload={"node": name})
            return True
        except ApprovalRejected:
            await artifacts_store.mark(spec.run_id, spec.task, name, "rejected", env=spec.env)
            await runs.log_event(spec.run_id, "artifact", {"node": name, "status": "rejected"})
            return False


@activity.defn
async def art_mark(raw: dict, name: str, status: str) -> None:
    spec = RunSpec.from_dict(raw)
    await artifacts_store.mark(spec.run_id, spec.task, name, status, env=spec.env)
    await runs.log_event(spec.run_id, "artifact", {"node": name, "status": status})


async def _execute_node(d: Deps, spec: RunSpec, name: str, node: NodeDef, payload: dict) -> Any:
    deps_text = "\n".join(f"- {k}: {_summary(v)}" for k, v in (payload.get("deps") or {}).items()) or "（无）"
    if node.code:
        fn = CODE_NODES.get(node.code)
        if fn is None:
            raise ApplicationError(f"code 节点 {node.code} 没有在内核登记", type="Rejected", non_retryable=True)
        result = fn(payload)
        return await result if asyncio.iscoroutine(result) else result

    if node.route:
        choices = node.route["choices"]
        resp = await d.model_pool.chat([
            {"role": "system", "content": f"你是分诊器。只能回复以下取值之一，不要任何其他字符：{choices}"},
            {"role": "user", "content": f"任务：{spec.task}\n输入：{_summary(spec.input)}\n依赖产物：\n{deps_text}"}])
        choice = (resp.choices[0].message.content or "").strip().strip('"')
        if choice not in choices:
            raise ValueError(f"route 节点 {name} 返回了取值范围外的结果：{choice!r}")
        return choice

    role, versions = await d.registry.resolved_role(node.agent["role"])
    agent = await d.factory.agent_for(role, versions)
    item = payload.get("item")
    prompt = (f"本次是任务图 {spec.task} 的节点 {name}。\n"
              f"产出要求：{node.agent.get('contract') or '按角色职责产出'}\n"
              f"任务输入：{_summary(spec.input)}\n"
              + (f"本次处理对象（第 {payload.get('index', 0) + 1} 项）：{_summary(item, 1000)}\n" if item is not None else "")
              + f"上游产物（摘要；完整内容用 read_artifact 按名字读取）：\n{deps_text}\n"
              "只输出本节点产物（JSON 优先），不要解释。")
    with run_scope.bind(await _scope(d, spec, role.tools)):
        text = await agent_factory.invoke(agent, spec.run_id, thread_id=f"{spec.run_id}:{name}:{payload.get('index', 0)}",
                                          prompt=prompt)
    try:
        return json.loads(text.strip().removeprefix("```json").removesuffix("```").strip())
    except json.JSONDecodeError:
        return text


# ==================== 内建任务 ====================


async def _gardener(d: Deps, spec: RunSpec) -> dict:
    services = await d.registry.services()
    report = {}
    for env in (await d.registry.envs()).names:
        report[env] = await run_gardener(env, {s.name: s.spec.view(s.name, env).code_paths for s in services})
    return report


BUILTINS: dict[str, Callable[[Deps, RunSpec], Awaitable[dict]]] = {
    "memory-gardener": _gardener,
}


# ==================== 小工具 ====================

_STATUS_TEXT = {"success": "成功", "failed": "失败", "cancelled": "已取消"}


async def _view(d: Deps, spec: RunSpec):
    if not spec.service:
        return None
    s = await d.registry.service(spec.service)
    return s.spec.view(spec.service, spec.env) if s else None


async def _scope(d: Deps, spec: RunSpec, tools: list[str]) -> run_scope.RunScope:
    env = await d.registry.env(spec.env)
    return run_scope.RunScope(
        run_id=spec.run_id, session_id=spec.session_id, task=spec.task, env=spec.env, protected=env.protected,
        service=spec.service, view=await _view(d, spec), caller=spec.trigger.caller, tools=tuple(tools),
        notify_channel=(spec.deliver or {}).get("channel"))


async def _cancelled(run_id: str) -> bool:
    run = await runs.get(run_id)
    return run is None or run["status"] == "cancelled"


async def _announce(d: Deps, spec: RunSpec, event: str, title: str, text: str) -> None:
    await d.notifier.emit(event, Message(
        title=f"{title}：{spec.task}", text=f"{spec.service or '平台'} · {spec.env} · {spec.trigger.type}\n\n{text}",
        link=d.notifier.link(f"/runs/{spec.run_id}"), link_title="查看运行"),
        service=spec.service, env=spec.env, task=spec.task, trigger=spec.trigger.type)


async def _heartbeating(awaitable, every_s: float = 30.0):
    """慢步骤（模型单次调用可能超过 heartbeat 超时）期间定期报活；取消照常传播。"""
    task = asyncio.ensure_future(awaitable)
    while True:
        done, _ = await asyncio.wait({task}, timeout=every_s)
        if done:
            return task.result()
        activity.heartbeat("running")


def _methods_block(methods: list[dict], limit: int = 4000) -> str:
    """方法注入块：文本方法给全文；文件方法只给路径与清单，由 agent 直接读取/执行。"""
    lines = ["[方法——过去运行沉淀的做法；文件类直接用路径读取或执行，不要重写；过时了用 save_asset 更新]"]
    for a in methods:
        scope = f"任务 {a['task']}" if a["task"] else "服务通用"
        head = f"### {a['kind']}:{a['name']}（{scope}，已复用 {a['use_count']} 次）\n{a['summary']}"
        if a.get("path"):
            files = assets_store.list_files(a["path"])
            listing = "、".join(f["name"] for f in files[:8]) + (f" …共 {len(files)} 个" if len(files) > 8 else "")
            lines.append(f"{head}\n路径：{a['path']}\n文件：{listing}" + (f"\n说明：{a['content']}" if a["content"] else ""))
        else:
            body = a["content"] if len(a["content"]) <= limit else a["content"][:limit] + "\n…[已截断]"
            lines.append(f"{head}\n{body}")
    return "\n\n".join(lines)


def _summary(content: Any, limit: int = 500) -> str:
    text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…[截断]"


def _node_kind(node: NodeDef) -> str:
    if node.map:
        return "map"
    return "code" if node.code else "route" if node.route else "agent"
