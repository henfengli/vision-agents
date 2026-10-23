"""提交端：一切"发起一次运行"的唯一入口（API、对话、控制台、定时、事件、重跑、续跑、纠正、回归重放）。

submit 的顺序就是它的全部逻辑：

    幂等键命中？→ 解析任务 → 解析服务 → 解析环境 → 校验输入 → 闸门链 → 任务去重
    → （点名的子任务不存在就按父任务建）→ 建台账行（queued，叫醒 worker）

建行之后的事都由 worker 从台账行出发（pipeline.build_spec）：新提交、续跑、重跑、重放走的是同一段代码。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass

import psycopg

from ..domain import SYSTEM, TERMINAL, Caller, Rejected, RunRequest, RunTrigger, TaskDef
from ..domain.tasks import check_task_name
from ..registry import Registry
from ..store import db, runs
from . import gates

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

    def dump(self) -> dict:
        return asdict(self)

    @classmethod
    def of(cls, run: dict, dedup: bool = False) -> "Accepted":
        return cls(run["run_id"], run["session_id"], run["status"], run.get("output"), dedup=dedup)


class Submitter:
    def __init__(self, registry: Registry):
        self._reg = registry

    # ———————— 新提交 ————————

    async def submit(self, req: RunRequest, *, trigger: RunTrigger, caller: Caller = SYSTEM,
                     idempotency_key: str | None = None, rule: dict | None = None) -> Accepted:
        """rule：事件触发时规则先行命中的结论——照样过闸门、留台账，只是不调模型。"""
        if idempotency_key and (hit := await runs.find_idempotent(idempotency_key)):
            return Accepted.of(hit, dedup=True)

        # 点名的子任务还不存在时，先按父任务的生效定义过闸门，受理之后才落库（被拒的请求不留子任务）
        task_name, base, to_create = await self._resolve_task(req)
        task = (await self._reg.task(base if to_create else task_name)).spec
        service = await self._resolve_service(task_name, task, req.service)
        env = (await self._reg.env(req.env)).name
        input_data = task.with_defaults(req.input)
        if errors := task.validate_input(input_data):
            raise Rejected("invalid_input", "输入不合法：" + "；".join(f"{k} {v}" for k, v in errors.items()),
                           detail={"fields": errors})

        await gates.admit(self._reg, task_name=task_name, task=task, service=service, env=env,
                          trigger_type=trigger.declared_type())

        dedup_key = None
        if task.dedup and (key := task.dedup.key_of(input_data)):
            dedup_key = f"{task_name}|{service or ''}|{env}|{key}"
            if hit := await runs.find_dedup(dedup_key, task.dedup.window_s):
                return Accepted.of(hit, dedup=True)

        created = await self._create_subtask(task_name, base, caller) if to_create else None

        run_id = uuid.uuid4().hex[:16]
        try:
            await runs.create(
                run_id=run_id, session_id=req.session_id or run_id, task=task_name, role=task.role, service=service,
                env=env, trigger_type=trigger.type, trigger_id=trigger.id, trigger_source=trigger.source,
                caller=trigger.caller or caller.name, summary=_summary(input_data, task.title or task_name),
                input_data=input_data, memory=req.memory.model_dump(exclude_none=True),
                dedup_key=dedup_key, idempotency_key=idempotency_key,
                output={"answer": rule["conclusion"], **rule} if rule else None, resolution="rule" if rule else None)
        except psycopg.errors.UniqueViolation:
            # 同一个幂等键的并发提交（多个 worker 同时触发同一次定时、调用方重试）：返回先到的那条
            if idempotency_key and (hit := await runs.find_idempotent(idempotency_key)):
                return Accepted.of(hit, dedup=True)
            raise
        return Accepted(run_id, req.session_id or run_id, "queued", subtask_created=created)

    async def _resolve_task(self, req: RunRequest) -> tuple[str, str, bool]:
        """→ (生效任务名, 父任务名, 是否需要新建子任务)。子任务可以写成 task="父:对象"，也可以 task + subtask。"""
        base, _, obj = req.task.partition(":")
        obj = req.subtask or obj
        parent = await self._reg.task_raw(base)
        if parent is None:
            raise Rejected("unknown_task", f"任务 {base} 不存在", 404)
        if not obj:
            return base, base, False
        if parent.spec.extends:
            raise Rejected("invalid_subtask", f"{base} 本身是子任务，不能再派生", 400)
        name = f"{base}:{obj}"
        try:
            check_task_name(name)
        except ValueError as e:
            raise Rejected("invalid_subtask", str(e)) from e
        return name, base, await self._reg.task_raw(name) is None

    async def _create_subtask(self, name: str, base: str, caller: Caller) -> str | None:
        """新建的子任务只有 extends，生效定义与父任务相同，所以闸门用父任务判断即可。"""
        try:
            await self._reg.create("task", name, {"extends": base, "auto_created": True}, f"auto:{caller.name}")
        except Rejected as e:
            if e.code == "conflict":          # 并发请求已经建好了
                return None
            raise
        log.info("按父任务 %s 自动建子任务 %s（%s）", base, name, caller.name)
        return name

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

    # ———————— 已有运行上的动作 ————————

    async def rerun(self, run_id: str, caller: Caller) -> Accepted:
        """同样的任务、服务、环境、输入，开一个新运行（新会话）。过开关，不再过触发声明。"""
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

    async def replay(self, run_id: str, caller: Caller) -> Accepted:
        """回归重放：同样的输入用当前定义重跑一次（新会话、不沉淀、不投递），供并排对比。"""
        old = await self._existing(run_id)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], input=old["input"])
        return await self._relaunch(req, old, RunTrigger(type="replay", id=run_id, caller=caller.name), caller)

    async def _relaunch(self, req: RunRequest, old: dict, trigger: RunTrigger, caller: Caller) -> Accepted:
        entry = await self._reg.task(old["task"])
        if entry is None:
            raise Rejected("unknown_task", f"任务 {old['task']} 已不存在")
        await gates.check_switches(self._reg, task_name=old["task"], task=entry.spec, service=old["service"], env=old["env"])
        run_id = uuid.uuid4().hex[:16]
        session_id = req.session_id or run_id
        await runs.create(run_id=run_id, session_id=session_id, task=old["task"], role=entry.spec.role,
                          service=old["service"], env=old["env"], trigger_type=trigger.type, trigger_id=trigger.id,
                          trigger_source=None, caller=trigger.caller, summary=_summary(req.input, old["summary"]),
                          input_data=req.input, memory=req.memory.model_dump(exclude_none=True))
        return Accepted(run_id, session_id, "queued")

    async def resume(self, run_id: str, caller: Caller) -> Accepted:
        """失败的运行从断点接着跑（同一个 run_id、同一个会话 thread）。"""
        run = await self._existing(run_id)
        if run["status"] != "failed":
            raise Rejected("conflict", f"只有失败的运行能续跑（当前 {run['status']}）", 409)
        entry = await self._reg.task(run["task"])
        if entry is None or entry.spec.form != "agent":
            raise Rejected("conflict", "只有单角色任务支持续跑；内建任务请用重跑", 409)
        await gates.check_switches(self._reg, task_name=run["task"], task=entry.spec, service=run["service"], env=run["env"])
        await runs.log_event(run_id, "stage", {"stage": "resume", "title": f"续跑（{caller.name}）"})
        await runs.enqueue(run_id, resume=True)
        return Accepted(run_id, run["session_id"], "queued")

    async def cancel(self, run_id: str, caller: Caller) -> dict:
        """先把台账标成 cancelled（事实源），再通知持有它的 worker 停下。"""
        run = await self._existing(run_id)
        if run["status"] in TERMINAL:
            raise Rejected("already_finished", f"运行已结束（{run['status']}）", 409)
        await runs.set_status(run_id, "cancelled", output={"error": f"被 {caller.name} 取消"}, error_code="cancelled")
        await runs.log_event(run_id, "error", {"title": "cancelled", "content": f"被 {caller.name} 取消"})
        await db.notify("run_cancel", run_id)
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


def _summary(input_data: dict, fallback: str) -> str:
    """列表里那一行显示什么：问题优先，其次第一个字段的值。"""
    value = input_data.get("question") or next((v for v in input_data.values() if isinstance(v, str) and v), None)
    return str(value or fallback)[:300]
