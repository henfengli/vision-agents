"""提交端：一切"发起一次运行"的唯一入口（API、对话、控制台、定时、事件、重跑、续跑、纠正）。

submit 的顺序就是它的全部逻辑：

    幂等键命中？→ 解析任务（子任务不存在就按父任务建）→ 解析服务 → 解析环境 → 调用方权限
    → 校验输入 → 闸门链 → 任务去重 → 建台账行 → 需要审批就挂起，否则启动 workflow

建行之后的事都从台账行出发（build_spec）：立即启动、审批放行后启动、续跑，走的是同一段代码。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass

from ..domain import SYSTEM, TERMINAL, Caller, Rejected, RunRequest, RunTrigger, TaskDef, question_text
from ..domain.tasks import check_task_name
from ..registry import Registry
from ..store import approvals as approvals_store
from ..store import runs
from . import gates
from .spec import RunSpec

log = logging.getLogger(__name__)


@dataclass
class Accepted:
    """提交回执。wait>0 时 status 可能已是终态，output 随之带回。"""

    run_id: str
    session_id: str
    status: str
    output: dict | None = None
    dedup: bool = False                    # 命中幂等键或任务去重，返回的是已有运行
    subtask_created: str | None = None     # 这次顺带建了哪个子任务
    approval_id: int | None = None         # 命中审批策略，等人放行

    def dump(self) -> dict:
        return asdict(self)

    @classmethod
    def of(cls, run: dict, dedup: bool = False) -> "Accepted":
        return cls(run["run_id"], run["session_id"], run["status"], run.get("output"), dedup=dedup)


class Submitter:
    def __init__(self, registry: Registry, temporal, task_queue: str, gate):
        self._reg = registry
        self._temporal = temporal
        self._queue = task_queue
        self._gate = gate                      # 发提交审批的通知

    # ———————— 新提交 ————————

    async def submit(self, req: RunRequest, *, trigger: RunTrigger, caller: Caller = SYSTEM,
                     idempotency_key: str | None = None, rule: dict | None = None) -> Accepted:
        """rule：事件触发时规则先行命中的结论——照样过闸门、留台账，只是不调模型。"""
        if idempotency_key and (hit := await runs.find_idempotent(idempotency_key)):
            return Accepted.of(hit, dedup=True)

        task_name, created = await self._resolve_task(req, caller)
        task = (await self._reg.task(task_name)).spec
        service = await self._resolve_service(task_name, task, req.service)
        env = (await self._reg.env(req.env)).name
        if (why := caller.may_run(service, env)) is not None:
            raise Rejected("forbidden", why, 403)
        input_data = task.with_defaults(req.input)
        if errors := task.validate_input(input_data):
            raise Rejected("invalid_input", "输入不合法：" + "；".join(f"{k} {v}" for k, v in errors.items()),
                           detail={"fields": errors})

        admission = await gates.admit(self._reg, task_name=task_name, task=task, service=service, env=env,
                                      trigger_type=trigger.declared_type(), input_data=input_data)

        dedup_key = None
        if task.dedup and (key := task.dedup.key_of(input_data)):
            dedup_key = f"{task_name}|{service or ''}|{env}|{key}"
            if hit := await runs.find_dedup(dedup_key, task.dedup.window_s):
                return Accepted.of(hit, dedup=True)

        run_id = uuid.uuid4().hex[:16]
        needs_approval = bool(admission.approval_policy) and rule is None
        await runs.create(
            run_id=run_id, session_id=req.session_id or run_id, task=task_name, role=task.role, service=service,
            env=env, trigger_type=trigger.type, trigger_id=trigger.id, trigger_source=trigger.source,
            caller=trigger.caller or caller.name, summary=_summary(input_data, task.title or task_name),
            input_data=input_data, memory=req.memory.model_dump(exclude_none=True),
            status="awaiting_approval" if needs_approval else "queued",
            dedup_key=dedup_key, idempotency_key=idempotency_key,
            output={"answer": rule["conclusion"], **rule} if rule else None, resolution="rule" if rule else None)

        if needs_approval:
            approval = await approvals_store.create(
                kind="submit", title=f"提交审批 · {task_name} · 策略 {admission.approval_policy}",
                detail=admission.approval_message, run_id=run_id, service=service, env=env, task=task_name,
                payload={"policy": admission.approval_policy}, requested_by=trigger.caller or caller.name)
            await runs.log_event(run_id, "approval", {"approval_id": approval["id"], "title": approval["title"],
                                                      "content": admission.approval_message})
            await self._gate.announce(approval)
            return Accepted(run_id, req.session_id or run_id, "awaiting_approval",
                            subtask_created=created, approval_id=approval["id"])

        await self._start(await self.build_spec(run_id))
        return Accepted(run_id, req.session_id or run_id, "queued", subtask_created=created)

    async def _resolve_task(self, req: RunRequest, caller: Caller) -> tuple[str, str | None]:
        """→ (生效任务名, 新建的子任务名)。子任务可以写成 task="父:对象"，也可以 task + subtask。"""
        base, _, obj = req.task.partition(":")
        obj = req.subtask or obj
        parent = await self._reg.task_raw(base)
        if parent is None:
            raise Rejected("unknown_task", f"任务 {base} 不存在", 404)
        if not obj:
            return base, None
        if parent.spec.extends:
            raise Rejected("invalid_subtask", f"{base} 本身是子任务，不能再派生", 400)
        name = f"{base}:{obj}"
        try:
            check_task_name(name)
        except ValueError as e:
            raise Rejected("invalid_subtask", str(e)) from e
        if await self._reg.task_raw(name) is not None:
            return name, None
        await self._reg.create("task", name, {"extends": base, "auto_created": True}, f"auto:{caller.name}")
        log.info("按父任务 %s 自动建子任务 %s（%s）", base, name, caller.name)
        return name, name

    async def _resolve_service(self, task_name: str, task: TaskDef, requested: str | None) -> str | None:
        """专属任务：服务就是任务的服务（请求里写了别的 → 拒绝）；通用任务：请求必须给；平台任务：没有服务。"""
        if task.service == "*":
            if not requested:
                raise Rejected("service_required", f"{task_name} 是通用任务，需要指定 service")
            if await self._reg.service(requested) is None:
                raise Rejected("unknown_service", f"服务 {requested} 不存在", 404)
            return requested
        if requested and requested != task.service:
            raise Rejected("service_not_allowed",
                           f"任务 {task_name} 属于{('服务 ' + task.service) if task.service else '平台'}，不能用于 {requested}")
        return task.service

    # ———————— 从台账行出发 ————————

    async def build_spec(self, run_id: str, *, resume: bool = False) -> RunSpec:
        """台账行 + 任务的生效定义 → RunSpec。立即启动、审批放行、续跑都走这里。"""
        run = await runs.get(run_id)
        entry = await self._reg.task(run["task"])
        if entry is None:
            raise Rejected("unknown_task", f"任务 {run['task']} 已不存在")
        task = entry.spec
        memory = await self._reg.config("memory")
        wanted = run.get("memory") or {}
        by_rule = run.get("resolution") == "rule"
        return RunSpec(
            run_id=run_id, session_id=run["session_id"], task=run["task"], form="rule" if by_rule else task.form,
            role=task.role, rule_output=run["output"] if by_rule else None,
            service=run["service"], env=run["env"], input=run["input"],
            question=question_text(run["task"], task, run["input"]),
            trigger=RunTrigger(**run["trigger"]), timeout_s=task.timeout_s,
            deliver=task.deliver.model_dump(exclude_none=True) if task.deliver else None,
            recall=_pick(wanted.get("recall"), task.memory.recall, memory.recall),
            save=_pick(wanted.get("save"), task.memory.save, memory.save),
            graph={k: v.model_dump() for k, v in task.graph.items()} if task.graph else None,
            handler=task.handler, resume=resume, correction=run["trigger"]["type"] == "correction")

    async def _start(self, spec: RunSpec) -> None:
        from temporalio.common import WorkflowIDReusePolicy

        from .workflows import RunWorkflow
        try:
            await self._temporal.start_workflow(
                RunWorkflow.run, spec.to_dict(), id=spec.run_id, task_queue=self._queue,
                id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY)
        except Exception as e:
            await runs.set_status(spec.run_id, "failed", output={"error": f"启动失败：{e}"}, error_code="start_failed")
            raise Rejected("start_failed", f"运行启动失败（Temporal 不可用？）：{e}", 503) from e

    # ———————— 已有运行上的动作 ————————

    async def on_submit_decision(self, approval: dict) -> None:
        """提交审批有了结论：放行 → 启动；拒绝/过期 → 运行记为取消。"""
        run_id = approval["run_id"]
        run = await runs.get(run_id) if run_id else None
        if run is None or run["status"] != "awaiting_approval":
            return
        if approval["status"] == "approved":
            await runs.set_status(run_id, "queued")
            await self._start(await self.build_spec(run_id))
        else:
            why = f"提交审批未通过（{approval.get('decided_by') or '超时'}）" + (f"：{approval['comment']}" if approval.get("comment") else "")
            await runs.log_event(run_id, "error", {"title": "approval_rejected", "content": why})
            await runs.set_status(run_id, "cancelled", output={"error": why}, error_code="approval_rejected")

    async def rerun(self, run_id: str, caller: Caller) -> Accepted:
        """同样的任务、服务、环境、输入，开一个新运行（新会话）。过开关，不再过触发声明与策略。"""
        old = await self._existing(run_id)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], input=old["input"],
                         memory=old.get("memory") or {})
        return await self._relaunch(req, old, RunTrigger(type="rerun", caller=caller.name), caller)

    async def correct(self, run_id: str, correction: str, caller: Caller) -> Accepted:
        """纠正：在同一会话里开新一轮，带上纠正内容；成功后取代上一轮沉淀的记忆。"""
        old = await self._existing(run_id)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], session_id=old["session_id"],
                         input={**old["input"], "question": f"[纠正] {correction}"}, memory=old.get("memory") or {})
        return await self._relaunch(req, old, RunTrigger(type="correction", caller=caller.name), caller)

    async def _relaunch(self, req: RunRequest, old: dict, trigger: RunTrigger, caller: Caller) -> Accepted:
        entry = await self._reg.task(old["task"])
        if entry is None:
            raise Rejected("unknown_task", f"任务 {old['task']} 已不存在")
        if (why := caller.may_run(old["service"], old["env"])) is not None:
            raise Rejected("forbidden", why, 403)
        await gates.check_switches(self._reg, task_name=old["task"], task=entry.spec, service=old["service"], env=old["env"])
        run_id = uuid.uuid4().hex[:16]
        session_id = req.session_id or run_id
        await runs.create(run_id=run_id, session_id=session_id, task=old["task"], role=entry.spec.role,
                          service=old["service"], env=old["env"], trigger_type=trigger.type, trigger_id=None,
                          trigger_source=None, caller=trigger.caller, summary=_summary(req.input, old["summary"]),
                          input_data=req.input, memory=req.memory.model_dump(exclude_none=True))
        await self._start(await self.build_spec(run_id))
        return Accepted(run_id, session_id, "queued")

    async def resume(self, run_id: str, caller: Caller) -> Accepted:
        """失败的运行从断点接着跑（同一个 run_id、同一个会话 thread）。"""
        run = await self._existing(run_id)
        if run["status"] != "failed":
            raise Rejected("conflict", f"只有失败的运行能续跑（当前 {run['status']}）", 409)
        entry = await self._reg.task(run["task"])
        if entry is None or entry.spec.form != "agent":
            raise Rejected("conflict", "只有单角色任务支持续跑；任务图请用重跑（未变的节点会复用产物）", 409)
        await gates.check_switches(self._reg, task_name=run["task"], task=entry.spec, service=run["service"], env=run["env"])
        await runs.log_event(run_id, "stage", {"stage": "resume", "title": f"续跑（{caller.name}）"})
        await runs.set_status(run_id, "queued")
        await self._start(await self.build_spec(run_id, resume=True))
        return Accepted(run_id, run["session_id"], "queued")

    async def cancel(self, run_id: str, caller: Caller) -> dict:
        run = await self._existing(run_id)
        if run["status"] in TERMINAL:
            raise Rejected("already_finished", f"运行已结束（{run['status']}）", 409)
        await runs.set_status(run_id, "cancelled", output={"error": f"被 {caller.name} 取消"}, error_code="cancelled")
        await runs.log_event(run_id, "error", {"title": "cancelled", "content": f"被 {caller.name} 取消"})
        await approvals_store.reject_pending_of_run(run_id, caller.name)
        try:
            await self._temporal.get_workflow_handle(run_id).cancel()
        except Exception:  # noqa: BLE001 —— 还没启动（等审批）或已结束：台账已是 cancelled
            pass
        return await runs.get(run_id)

    async def wait(self, run_id: str, timeout_s: float) -> dict:
        """等到终态或超时，返回当前台账行。"""
        deadline = asyncio.get_running_loop().time() + timeout_s
        delay = 0.3
        while True:
            run = await runs.get(run_id)
            if run["status"] in TERMINAL or asyncio.get_running_loop().time() >= deadline:
                return run
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 2.0)

    async def _existing(self, run_id: str) -> dict:
        run = await runs.get(run_id)
        if run is None:
            raise Rejected.not_found(f"运行 {run_id}")
        return run


def _pick(*values: bool | None) -> bool:
    """第一个不是 None 的开关（请求 > 任务 > 平台默认）。"""
    return next(v for v in values if v is not None)


def _summary(input_data: dict, fallback: str) -> str:
    """列表里那一行显示什么：问题优先，其次第一个字段的值。"""
    value = input_data.get("question") or next((v for v in input_data.values() if isinstance(v, str) and v), None)
    return str(value or fallback)[:300]
