"""一次运行的执行：worker 认领一条排队运行后调用 Pipeline.execute。

    prepare → agent / 内建 / 规则 → finalize → deliver
                   └─ 任一步失败 → fail → deliver

执行步骤（agent / 内建）限时：任务的 timeout_s（上限 MAX_EXEC_S）。
被取消（控制台 / 接口）就安静地停下，台账已由提交端标好；执行进程退出导致的中断记为 interrupted，可续跑。
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable

import httpx

from .. import __version__, observability
from ..agent import factory as agent_factory
from ..agent import scope as run_scope
from ..agent.tools.catalog import executor_label
from ..config import Settings
from ..domain import BUILTIN_HANDLERS, RETRYABLE_CODES, Rejected, RunTrigger, compose_profile, question_text
from ..memory import distill, recall
from ..memory.gardener import run_gardener
from ..notify import Message, Notifier
from ..registry import Registry
from ..services import envspec
from ..store import assets as assets_store
from ..store import knowledge as knowledge_store
from ..store import runs
from . import gates
from .spec import RunSpec

log = logging.getLogger(__name__)

MAX_EXEC_S = 7200


@dataclass
class Deps:
    settings: Settings
    registry: Registry
    factory: agent_factory.AgentFactory
    notifier: Notifier
    model_pool: Any
    service_mcp: Any = None                                           # agent.tools.mcp_bridge.ServiceMcp
    on_finished: Callable[[RunSpec], Awaitable[None]] | None = None   # 回归重放的判定挂在这里
    # 运行最终结束之后（成功 / 最终失败 / 准备阶段就失败）：上游联动和点名等它的运行（orchestration/chain.py）
    after_run: Callable[[str], Awaitable[None]] | None = None


def _pick(*values: bool | None) -> bool:
    """第一个不是 None 的开关（请求 > 任务 > 平台默认）。"""
    return next(v for v in values if v is not None)


async def build_spec(reg: Registry, run: dict) -> RunSpec:
    """台账行 + 任务的生效定义 → RunSpec。新提交、续跑、重跑、重放都从这里出发。"""
    entry = await reg.task(run["task"])
    if entry is None:
        raise Rejected("unknown_task", f"任务 {run['task']} 已不存在")
    task = entry.spec
    memory = await reg.config("memory")
    wanted = run.get("memory") or {}
    by_rule = run.get("resolution") == "rule"
    trigger = RunTrigger(**run["trigger"])
    replay = trigger.type == "replay"
    return RunSpec(
        run_id=run["run_id"], session_id=run["session_id"], task=run["task"], form="rule" if by_rule else task.form,
        role=task.role, rule_output=run["output"] if by_rule else None,
        service=run["service"], env=run["env"], input=run["input"],
        question=question_text(run["task"], task, run["input"]), trigger=trigger, timeout_s=task.timeout_s,
        # 回归重放：不投递、不沉淀（对比用，不该改动记忆或打扰群）；召回的隔离见 prepare
        deliver=None if replay or not task.deliver else task.deliver.model_dump(exclude_none=True),
        recall=_pick(wanted.get("recall"), task.memory.recall, memory.recall),
        save=False if replay else _pick(wanted.get("save"), task.memory.save, memory.save),
        handler=task.handler, resume=bool(run.get("resume")), correction=trigger.type == "correction",
        output_schema=task.output_schema)


class Pipeline:
    def __init__(self, deps: Deps):
        self._d = deps

    @property
    def registry(self) -> Registry:
        return self._d.registry

    async def execute(self, run_id: str) -> None:
        run = await runs.get(run_id)
        if run is None or run["status"] != "running":
            return
        try:
            spec = await build_spec(self._d.registry, run)
        except Rejected as e:
            await runs.log_event(run_id, "error", {"title": e.code, "content": e.message})
            await runs.set_status(run_id, "failed", output={"error": e.message}, error_code=e.code)
            await self._after_run(run_id)
            return
        try:
            spec = await self.prepare(spec)
            if spec.form == "agent":
                output, resolution = await self._limited(spec, self.run_agent(spec)), "agent"
            elif spec.form == "rule":
                output, resolution = spec.rule_output or {}, "rule"
            else:
                output, resolution = await self._limited(spec, self.run_builtin(spec)), "builtin"
            await self.finalize(spec, output, resolution)
        except asyncio.CancelledError:
            if await _cancelled(run_id):
                return                                   # 人取消的：台账已是 cancelled
            # 进程要退了：落 interrupted；没排上自动重试的就是最终失败，点名等它的、「失败后」的联动也要处理
            # （投递是可能慢的 HTTP，退出时不做；孤儿路径同样只在别的主机上补）
            await asyncio.shield(self._interrupted(spec))
            raise
        except Rejected as e:
            await self.fail(spec, e.message, e.code)
        except (TimeoutError, asyncio.TimeoutError):
            await self.fail(spec, f"执行超时（任务的 timeout_s = {spec.timeout_s}s）", "timeout")
        except Exception as e:  # noqa: BLE001 —— 模型 / 工具 / 框架的错误：记下来，交给人续跑或重跑
            log.exception("运行 %s 失败", run_id)
            await self.fail(spec, f"{type(e).__name__}: {e}", "error")
        await self._settle(spec)

    async def _settle(self, spec: RunSpec) -> None:
        """运行最终结束后的旁路：投递、回归重放的判定、上游联动。失败后还要自动重试的先不做（重试完再说）。"""
        run = await runs.get(spec.run_id)
        if run is None or run["status"] == "cancelled" or (run["status"] == "failed" and run.get("retry_at")):
            return
        await self.deliver(spec)
        if self._d.on_finished is not None:
            try:
                await self._d.on_finished(spec)
            except Exception:  # noqa: BLE001
                log.exception("运行 %s 结束后的回调失败", spec.run_id)
        await self._after_run(spec.run_id)

    async def _interrupted(self, spec: RunSpec) -> None:
        await self.fail(spec, "执行进程退出，运行中断（可续跑）", "interrupted")
        run = await runs.get(spec.run_id)
        if run is not None and run["status"] == "failed" and not run.get("retry_at"):
            await self._after_run(spec.run_id)

    async def _after_run(self, run_id: str) -> None:
        if self._d.after_run is not None:
            try:
                await self._d.after_run(run_id)
            except Exception:  # noqa: BLE001
                log.exception("运行 %s 的上游联动失败", run_id)

    async def settle_failed(self, run_id: str) -> None:
        """在执行流程之外最终失败的运行（判成孤儿后不再重试、自动重试没能开始、人取消了等着的重试）：
        补上失败通知、投递和联动。"""
        run = await runs.get(run_id)
        if run is None or run["status"] != "failed" or run.get("retry_at"):
            return
        try:
            spec = await build_spec(self._d.registry, run)
        except Rejected:
            await self._after_run(run_id)            # 任务都删了：只处理等它的运行
            return
        output = run.get("output") or {}
        await _announce(self._d, spec, "run_failed", "运行失败", f"`{run.get('error_code')}` {str(output.get('error', ''))[:1200]}")
        await self._settle(spec)

    async def orphaned(self, run_id: str) -> None:
        """维护循环把心跳停了的运行判成孤儿（执行进程崩溃 / 被杀）之后：任务配了自动重试就排上，否则按最终失败收尾。"""
        run = await runs.get(run_id)
        if run is None:
            return
        delay = await self._retry_in(run["task"], "orphaned", run.get("attempt") or 1, run["trigger"]["type"])
        if delay and await runs.schedule_retry(run_id, delay):
            await runs.log_event(run_id, "stage", {"stage": "retry", "title": _retry_title(run.get("attempt") or 1, delay,
                                                                                           await self._retry_max(run["task"]))})
            return
        await self.settle_failed(run_id)

    async def _retry_max(self, task_name: str) -> int:
        entry = await self._d.registry.task(task_name)
        return entry.spec.retry.max if entry and entry.spec.retry else 0

    async def _retry_in(self, task_name: str, code: str, attempt: int, trigger_type: str) -> int | None:
        """这次失败要不要自动重试：任务配了 retry、是 agent 任务、失败是临时性的、还没用完次数。→ 等几秒；None = 不重试。
        回归重放不重试（对比用）；对话、纠正不重试：人就在页面上看着，等重试期间会话的下一条消息会被挡住，要接着就点续跑。"""
        if code not in RETRYABLE_CODES or trigger_type in ("replay", "chat", "correction"):
            return None
        entry = await self._d.registry.task(task_name)
        if entry is None or entry.spec.form != "agent" or not entry.spec.retry:
            return None
        return entry.spec.retry.delay_s if attempt <= entry.spec.retry.max else None

    async def _limited(self, spec: RunSpec, coro: Awaitable[dict]) -> dict:
        return await asyncio.wait_for(coro, min(spec.timeout_s, MAX_EXEC_S))

    # —— 步骤 ——

    async def prepare(self, spec: RunSpec) -> RunSpec:
        """记配方、重过开关（1–4 环）、拼提示：当前时间 → 档案 → 运行环境 → 召回 → 方法 → 问题。"""
        d = self._d
        task = await d.registry.task(spec.task)
        if task is None:
            raise Rejected("unknown_task", f"任务 {spec.task} 已不存在")
        await gates.check_switches(d.registry, task_name=spec.task, task=task.spec, service=spec.service, env=spec.env)
        await self._record_recipe(spec, task)

        if spec.form == "rule":
            out = spec.rule_output or {}
            await runs.log_event(spec.run_id, "stage", {
                "stage": "rule", "title": f"规则先行命中 · {out.get('category')}",
                "content": f"报错匹配规则 `{out.get('pattern')}`，直接给出结论，未调用模型。"})
            return spec
        if spec.form != "agent":
            return spec

        view = await _view(d, spec)
        local = d.settings.is_local(spec.env)
        # 记忆里 code_ref 的新鲜度按代码目录的 git 核对：代管时本机这份不是这个环境的代码，不核对、不记提交
        spec.code_paths = view.code_paths if view and local else []
        if spec.resume:                      # 续跑：提示已在 checkpoint 里，不重新拼
            return spec

        parts: list[str] = [now_block()]
        profile = compose_profile(spec.service, view.profile if view else {}, spec.task, task.spec.profile)
        if profile:
            parts.append(profile)
            await runs.log_event(spec.run_id, "stage", {"stage": "profile", "title": "档案", "content": profile})
        if view:
            protected = (await d.registry.env(spec.env)).protected or not local
            parts.append(view.prompt_block(protected) if local
                         else view.prompt_block(protected, executor=executor_label(d.settings)))

        if spec.recall and spec.service:
            memory = await d.registry.config("memory")
            # 回归重放：用现在的记忆，去掉原运行自己沉淀的；交接摘要按原运行的会话找前序会话；只读，不记命中
            source = await runs.get(spec.replay_of) if spec.replay_of else None
            found = await recall(env=spec.env, service=spec.service, task=spec.task, query=spec.question,
                                 error_text=spec.error_text, code_paths=spec.code_paths,
                                 session_id=source["session_id"] if source else spec.session_id,
                                 run_id=spec.run_id, limit=memory.knowledge_limit, embedder=d.model_pool.embed,
                                 exclude_run=spec.replay_of, before=source["created_at"] if source else None)
            if found.text:
                parts.append(found.text)
                facts = sum(1 for h in found.knowledge if h["kind"] == "fact")
                lessons = len(found.knowledge) - facts
                await runs.log_event(spec.run_id, "stage", {
                    "stage": "recall", "title": f"召回 · 事实 {facts} 条 · 教训 {lessons} 条"
                    + ("（含同类报错命中）" if found.case_id else ""),
                    "content": found.text, "hits": found.knowledge, "lesson_id": found.case_id})
            methods = await assets_store.search_active(spec.env, spec.service, spec.task.split(":")[0],
                                                       limit=memory.asset_limit, exclude_run=spec.replay_of)
            if methods:
                block = _methods_block(methods)
                parts.append(block)
                if not spec.replay_of:
                    await assets_store.mark_used([a["id"] for a in methods])
                await runs.log_event(spec.run_id, "stage", {
                    "stage": "assets", "title": f"方法 · {len(methods)} 条", "content": block,
                    "assets": [{"id": a["id"], "kind": a["kind"], "name": a["name"]} for a in methods]})

        parts.append(spec.question)
        spec.prompt = "\n\n".join(parts)
        return spec

    async def _record_recipe(self, spec: RunSpec, task: Any) -> None:
        """配方：这次运行用到的每样定义各是第几版——任务（与父任务）、角色继承链每一层、子代理、服务、
        平台提示词，加上模型与平台版本。运行详情与回归重放的对比都看它。"""
        d = self._d
        recipe: dict[str, Any] = {"task": {"name": spec.task, "version": task.version},
                                  "model": d.settings.model.name, "platform": __version__}
        if (fb := d.settings.model.fallback_config()) is not None:
            recipe["model_fallback"] = fb.name       # 配了备用模型：哪几步真用了它看时间线（model_call 的 fallback）
        if task.spec.extends and (parent := await d.registry.task_raw(task.spec.extends)) is not None:
            recipe["task"]["parent"] = {"name": parent.name, "version": parent.version}
        role_version = None
        if spec.role:
            main, subs, key = await d.registry.agent_roles(spec.role)
            layers = [[{"name": n, "version": v} for n, v in zip(r.lineage, versions)]
                      for r, (_, versions) in zip((main, *subs), key)]
            recipe["role"] = {"name": main.name, "lineage": layers[0]}
            if subs and spec.form == "agent":
                recipe["subagents"] = [{"name": r.name, "lineage": layer} for r, layer in zip(subs, layers[1:])]
            role_version = layers[0][-1]["version"]
        if spec.service and (svc := await d.registry.service(spec.service)) is not None:
            recipe["service"] = {"name": svc.name, "version": svc.version}
        if spec.form == "agent":
            _prompts, recipe["prompts"] = await d.registry.config_versioned("prompts")
        await runs.set_recipe(spec.run_id, task.version, role_version, recipe)

    async def run_agent(self, spec: RunSpec) -> dict:
        """按任务的角色装配 agent 执行（带子代理与服务 MCP 工具）；会话即 LangGraph thread，续跑从 checkpoint 接着走。"""
        d = self._d
        role, subagents, version_key = await d.registry.agent_roles(spec.role or "")
        prompts, prompts_version = await d.registry.config_versioned("prompts")
        service_tools, service_key = await service_mcp_tools(d.registry, d.service_mcp, spec.service)
        agent = await d.factory.agent_for(role, subagents, (version_key, prompts_version), spec.service, service_tools,
                                          service_key, prompts=prompts, output_schema=spec.output_schema)
        if not spec.resume:
            await runs.log_event(spec.run_id, "stage", {
                "stage": "system", "title": f"系统提示 · 平台提示词 v{prompts_version} + 角色 {role.name}",
                "content": agent_factory.system_prompt(role, subagents, prompts, spec.output_schema)})
        extra = tuple(service_tools) if role.service_tools else ()
        with run_scope.bind(await _scope(d, spec, role.tools, extra)), \
                observability.run_span("agent.run", run_id=spec.run_id, task=spec.task, service=spec.service, env=spec.env):
            result = await agent_factory.invoke(agent, spec.run_id, thread_id=spec.thread_id,
                                                prompt=None if spec.resume else spec.prompt,
                                                structured=bool(spec.output_schema))
        answer, data = result["answer"], result.get("data")
        if spec.output_schema and data is None:
            raise Rejected("invalid_output", "agent 没有交回符合任务 output_schema 的结构化结果（已提醒一次）；"
                                             f"它最后的文字回复：{answer[:1000] or '（无）'}")
        output: dict[str, Any] = {"answer": answer or (json.dumps(data, ensure_ascii=False, indent=2) if data else "")}
        if spec.output_schema:
            output["data"] = data
        if result.get("step_limit"):
            output["step_limit"] = True        # 模型调用次数到上限、停用工具后给的收尾结论（可能没查完）
        await runs.log_event(spec.run_id, "final", {"content": output["answer"], **({"data": data} if data else {})})
        return output

    async def run_builtin(self, spec: RunSpec) -> dict:
        """内建任务：不过模型的确定性维护作业。"""
        handler = BUILTINS.get(spec.handler or "")
        if handler is None:
            raise Rejected("invalid_definition", f"未知的内建处理器：{spec.handler}（可用：{'、'.join(BUILTINS)}）")
        output = await handler(self._d, spec)
        await runs.log_event(spec.run_id, "final", {"content": json.dumps(output, ensure_ascii=False, indent=2)})
        return output

    async def finalize(self, spec: RunSpec, output: dict, resolution: str) -> None:
        """落成功；之后的纠正、沉淀、通知都是旁路，失败只留日志，不翻案运行结果。"""
        d = self._d
        if await _cancelled(spec.run_id):
            return
        if not await runs.set_status(spec.run_id, "success", output=output, resolution=resolution):
            return                     # 期间被取消或被判成孤儿：结果不再算数
        if resolution == "rule":
            await runs.log_event(spec.run_id, "final", {"content": output.get("answer", "")})
        try:
            if spec.correction:
                # 取代被纠正的那一轮（trigger.id）沉淀的；老的纠正运行没记 id，退回同会话的上一轮
                corrected = spec.trigger.id
                if not corrected and (previous := await runs.latest_of_session(spec.session_id, exclude=spec.run_id)):
                    corrected = previous["run_id"]
                if corrected:
                    await knowledge_store.supersede_by_runs([corrected], spec.run_id)
            if spec.save and spec.service and resolution == "agent":
                memory = await d.registry.config("memory")
                await distill(d.model_pool, env=spec.env, service=spec.service, run_id=spec.run_id, task=spec.task,
                              run_input=spec.input, run_output=output, code_paths=spec.code_paths,
                              session_id=spec.session_id, handoff_summary=memory.handoff_summary,
                              prompts=await d.registry.config("prompts"))
        except Exception:  # noqa: BLE001
            log.exception("运行 %s 的纠正 / 记忆沉淀失败", spec.run_id)
        await _announce(d, spec, "run_succeeded", "运行成功", str(output.get("answer") or output)[:1500])

    async def fail(self, spec: RunSpec, message: str, code: str) -> None:
        """落失败。任务配了自动重试、失败又是临时性的：同时定好重试时刻，这次先不发失败通知（重试用完还失败才发）。"""
        if await _cancelled(spec.run_id):
            return
        await runs.log_event(spec.run_id, "error", {"title": code, "content": message[:4000]})
        run = await runs.get(spec.run_id)
        attempt = (run or {}).get("attempt") or 1
        delay = await self._retry_in(spec.task, code, attempt, spec.trigger.type)
        if await runs.set_status(spec.run_id, "failed", output={"error": message[:4000]}, error_code=code, retry_in=delay):
            if delay:
                await runs.log_event(spec.run_id, "stage", {"stage": "retry", "title": _retry_title(
                    attempt, delay, await self._retry_max(spec.task))})
            else:
                await _announce(self._d, spec, "run_failed", "运行失败", f"`{code}` {message[:1200]}")

    async def deliver(self, spec: RunSpec) -> None:
        """按任务声明把终态结果推出去（通知渠道 / HTTP 回调）。重试 3 次；失败只留事件，不改运行结果。"""
        if not spec.deliver:
            return
        run = await runs.get(spec.run_id)
        if run is None:
            return
        output = run.get("output") or {}
        for attempt in range(3):
            try:
                if spec.deliver.get("url"):
                    async with httpx.AsyncClient(timeout=10) as client:
                        resp = await client.post(spec.deliver["url"], json={
                            "run_id": spec.run_id, "task": spec.task, "service": spec.service, "env": spec.env,
                            "status": run["status"], "output": output})
                        resp.raise_for_status()
                else:
                    text = output.get("answer") or output.get("error") or json.dumps(output, ensure_ascii=False)[:1500]
                    await self._d.notifier.send(spec.deliver["channel"], Message(
                        title=f"{spec.task} · {_STATUS_TEXT.get(run['status'], run['status'])}", text=str(text)[:3000],
                        link=self._d.notifier.link(f"/runs/{spec.run_id}"), link_title="查看运行"))
                return
            except Exception as e:  # noqa: BLE001
                if attempt < 2:
                    await asyncio.sleep(2 * (attempt + 1) ** 2)
                    continue
                await runs.log_event(spec.run_id, "stage", {"stage": "deliver", "title": "结果投递失败",
                                                            "content": f"{type(e).__name__}: {str(e)[:500]}"})


# ==================== 内建任务 ====================


async def _gardener(d: Deps, spec: RunSpec) -> dict:
    """本运行的 服务×环境：记忆里引用的代码改过的标为过期。运行由该环境、部署了该服务的那台主机上的 agent 服务执行，
    读的是线上的代码目录。没指定服务时（开发机）扫所有服务。"""
    if not d.settings.is_local(spec.env):
        # 代管：本机的代码目录是本机环境的那份，拿它核对 spec.env 的记忆会把没过期的标成过期
        return {"env": spec.env, "drift_expired": 0,
                "skipped": f"本机不是 {spec.env} 的部署主机（代管），代码对不上，不做漂移巡检"}
    services = [s for s in await d.registry.services() if not spec.service or s.name == spec.service]
    return {"env": spec.env, **await run_gardener(spec.env, {s.name: s.spec.view(s.name, spec.env).code_paths
                                                              for s in services})}


BUILTINS: dict[str, Callable[[Deps, RunSpec], Awaitable[dict]]] = {
    "memory-gardener": _gardener,
}
assert set(BUILTINS) == set(BUILTIN_HANDLERS), "内建处理器的实现和 domain.tasks.BUILTIN_HANDLERS 要一致"


# ==================== 小工具 ====================

_STATUS_TEXT = {"success": "成功", "failed": "失败", "cancelled": "已取消"}


async def service_mcp_tools(registry: Registry, service_mcp: Any, service: str | None) -> tuple[list, str]:
    """运行所在服务声明的 MCP 工具（服务启用的各环境一份连接，调用按运行的环境路由）。连不上只少工具，不挡运行。"""
    if not service or service_mcp is None:
        return [], ""
    s = await registry.service(service)
    if s is None or not s.spec.mcp:
        return [], ""
    envs = [e for e in (await registry.envs()).names if s.spec.view(service, e).enabled]
    try:
        return await service_mcp.tools_for(service, s.spec, envs)
    except Exception:  # noqa: BLE001
        log.exception("服务 %s 的 MCP 工具加载失败", service)
        return [], ""


async def _view(d: Deps, spec: RunSpec):
    if not spec.service:
        return None
    return await d.registry.service_view(spec.service, spec.env)


async def _scope(d: Deps, spec: RunSpec, tools: list[str], extra: tuple = ()) -> run_scope.RunScope:
    """沙箱的遮蔽与 home 白名单见 services/envspec.sandbox_paths：生产的运行里所有服务所有环境的配置文件都遮
    （board 的运行里同样读不到 dagster 的配置），测试的运行里只遮生产的；项目内核在生产再把给 agent 的配置 bind 上去。"""
    env = await d.registry.env(spec.env)
    hidden, allow = await envspec.sandbox_paths(d.registry, d.settings, spec.env)
    local = d.settings.is_local(spec.env)
    return run_scope.RunScope(
        run_id=spec.run_id, session_id=spec.session_id, task=spec.task, env=spec.env,
        protected=env.protected or not local, local=local,
        service=spec.service, view=await _view(d, spec), caller=spec.trigger.caller, tools=tuple(tools),
        extra_tools=extra, notify_channel=(spec.deliver or {}).get("channel"), hidden=hidden, allow=allow,
        replay_of=spec.replay_of)


async def _cancelled(run_id: str) -> bool:
    run = await runs.get(run_id)
    return run is None or run["status"] == "cancelled"


async def _announce(d: Deps, spec: RunSpec, event: str, title: str, text: str) -> None:
    await d.notifier.emit(event, Message(
        title=f"{title}：{spec.task}", text=f"{spec.service or '平台'} · {spec.env} · {spec.trigger.type}\n\n{text}",
        link=d.notifier.link(f"/runs/{spec.run_id}"), link_title="查看运行"),
        service=spec.service, env=spec.env, task=spec.task, trigger=spec.trigger.type)


def _retry_title(attempt: int, delay: int, max_retries: int) -> str:
    left = max(0, max_retries - attempt)
    return (f"第 {attempt} 次执行失败，{delay} 秒后自动重试"
            + (f"（之后还能再重试 {left} 次）" if left else "（最后一次）"))


_WEEKDAYS = "一二三四五六日"


def now_block(now: datetime | None = None) -> str:
    """当前时间（执行运行的这台主机的本地时间）：问"昨天、上个交易日、最近 7 天"时模型要知道今天是哪天。"""
    now = (now or datetime.now()).astimezone()
    offset = now.strftime("%z")
    tz = f"UTC{offset[:3]}:{offset[3:]}" if offset else "本地时间"
    return (f"[时间] 现在是 {now:%Y-%m-%d %H:%M}（{tz}，星期{_WEEKDAYS[now.weekday()]}）。"
            "说「今天 / 昨天 / 最近 N 天」按这个算；按交易日统计的，以库里的交易日历为准。")


def _methods_block(methods: list[dict], limit: int = 4000) -> str:
    """方法注入块：文本方法给全文；文件方法只给路径与清单，由 agent 直接读取/执行。"""
    lines = ["[方法——过去运行沉淀的做法；文件类直接用路径读取或执行，不要重写；过时了用 save_asset 更新]"]
    for a in methods:
        scope = f"任务 {a['task']}" if a["task"] else "服务通用"
        head = f"### {a['kind']}:{a['name']}（{scope}，已复用 {a['use_count']} 次）\n{a['summary']}"
        if a.get("path"):
            files = assets_store.list_files(a["path"])
            listing = "、".join(f["name"] for f in files[:8]) + (f" …共 {len(files)} 个" if len(files) > 8 else "")
            lines.append(f"{head}\n路径：{a['path']}（已在 py 内核的 sys.path 上，.py 可直接 import）\n文件：{listing}"
                     + (f"\n说明：{a['content']}" if a["content"] else ""))
        else:
            body = a["content"] if len(a["content"]) <= limit else a["content"][:limit] + "\n…[已截断]"
            lines.append(f"{head}\n{body}")
    return "\n\n".join(lines)
