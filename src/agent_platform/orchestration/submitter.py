"""提交端：一切"发起一次运行"的唯一入口（API、对话、控制台、定时、事件、重跑、续跑、纠正、回归重放）。

submit 的顺序就是它的全部逻辑：

    幂等键命中？→ 解析任务 → 解析服务 → 解析环境 → 校验输入 → 闸门链 → 任务去重
    → （点名的子任务不存在就按父任务建）→ 建台账行（queued，叫醒 worker）

建行之后的事都由 worker 从台账行出发（pipeline.build_spec）：新提交、续跑、重跑、重放走的是同一段代码。
哪台主机执行看台账行的环境（和服务）：管这个环境的 agent 服务认领；它没在跑时运行就排着，起来后接着执行。
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass
from typing import Awaitable, Callable

import psycopg

from ..domain import PRIORITY, SYSTEM, TERMINAL, Caller, Rejected, RunRequest, RunTrigger, TaskDef, object_value
from ..domain.tasks import check_task_name, split_subtask_name
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
        # 运行最终失败（不再自动重试）之后要做的事：通知、投递、「失败后」的联动。由 runtime 接上 Pipeline.settle_failed
        self.on_failed_final: Callable[[str], Awaitable[None]] | None = None

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
        _, obj = split_subtask_name(task_name)
        if obj and task.object_input and not input_data.get(task.object_input):
            input_data[task.object_input] = obj            # 选了对象：对象字段不用再填一遍
        if req.session_id and trigger.type in ("chat", "correction") and (live := await runs.live_in_session(req.session_id)):
            # 同一会话（同一个 LangGraph thread）同时只能有一轮在跑，否则两轮的消息会交错写进同一段上下文
            raise Rejected("conflict", f"这个会话还有一轮在执行（{live['run_id'][:8]}），等它结束或先停止", 409)
        if errors := task.validate_input(input_data):
            raise Rejected("invalid_input", "输入不合法：" + "；".join(f"{k} {v}" for k, v in errors.items()),
                           detail={"fields": errors})

        await gates.admit(self._reg, task_name=task_name, task=task, service=service, env=env,
                          trigger_type=trigger.declared_type())
        depends_on = await self._check_upstream(req.after)

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
                output={"answer": rule["conclusion"], **rule} if rule else None, resolution="rule" if rule else None,
                depends_on=depends_on, **_queue_fields(task_name, task, env, trigger.type))
        except psycopg.errors.UniqueViolation:
            # 同一个幂等键的并发提交（多个 worker 同时触发同一次定时、调用方重试）：返回先到的那条
            if idempotency_key and (hit := await runs.find_idempotent(idempotency_key)):
                return Accepted.of(hit, dedup=True)
            raise
        return Accepted(run_id, req.session_id or run_id, "queued", subtask_created=created)

    async def _check_upstream(self, after: list[str]) -> list[str]:
        """提交时点名的上游运行：都要存在；已经失败 / 取消（且没在等自动重试）的直接拒，免得建一条注定不执行的运行。"""
        wanted = list(dict.fromkeys(a.strip() for a in after if a and a.strip()))
        if not wanted:
            return []
        found = await runs.statuses(wanted)
        if missing := [a for a in wanted if a not in found]:
            raise Rejected("unknown_run", f"点名等的运行不存在：{'、'.join(missing)}", 404)
        if dead := [a for a in wanted if found[a]["status"] in ("failed", "cancelled") and not found[a]["retry_at"]]:
            raise Rejected("upstream_failed", f"点名等的运行已经失败或取消：{'、'.join(dead)}", 409)
        return wanted

    async def _resolve_task(self, req: RunRequest) -> tuple[str, str, bool]:
        """→ (生效任务名, 父任务名, 是否需要新建子任务)。子任务可以写成 task="父:对象"，也可以 task + subtask。"""
        base, _, obj = req.task.partition(":")
        obj = req.subtask or obj
        parent = await self._reg.task_raw(base)
        if parent is None:
            raise Rejected("unknown_task", f"任务 {base} 不存在", 404)
        if not obj and not parent.spec.extends:
            obj = object_value(parent.spec, req.input)     # 任务声明了对象字段：按它的值落到对应子任务
        if not obj:
            return base, base, False
        if parent.spec.extends:
            raise Rejected("invalid_subtask", f"{base} 本身是子任务，不能再派生", 400)
        if parent.spec.form == "builtin":
            raise Rejected("invalid_subtask", f"{base} 是内建任务，没有子任务", 400)
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
        """同样的任务、服务、环境、输入，开一个新运行（新会话）。过开关，不再过触发声明。
        原运行失败后还等着自动重试的：重试取消掉（不然到点它也会续跑，同一份输入跑两遍），原运行就此算失败。"""
        old = await self._existing(run_id)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], input=old["input"],
                         memory=old.get("memory") or {})
        accepted = await self._relaunch(req, old, RunTrigger(type="rerun", caller=caller.name), caller)
        if old["status"] == "failed" and old.get("retry_at") and await runs.clear_retry(run_id):
            await runs.log_event(run_id, "stage", {"stage": "retry", "title": f"自动重试已取消（{caller.name} 改为重跑 {accepted.run_id[:8]}）"})
            if self.on_failed_final is not None:
                await self.on_failed_final(run_id)
        return accepted

    async def correct(self, run_id: str, correction: str, caller: Caller) -> Accepted:
        """纠正：在同一会话里开新一轮，带上纠正内容；成功后取代被纠正的那一轮（trigger.id）沉淀的记忆。"""
        old = await self._existing(run_id)
        if old["status"] not in TERMINAL:
            raise Rejected("conflict", "运行还没结束，结束后再纠正", 409)
        if live := await runs.live_in_session(old["session_id"]):
            raise Rejected("conflict", f"这个会话还有一轮在执行（{live['run_id'][:8]}），等它结束或先停止", 409)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], session_id=old["session_id"],
                         input={**old["input"], "question": f"[纠正] {correction}"}, memory=old.get("memory") or {})
        return await self._relaunch(req, old, RunTrigger(type="correction", id=run_id, caller=caller.name), caller)

    async def replay(self, run_id: str, caller: Caller) -> Accepted:
        """回归重放：同样的输入用当前定义重跑一次（新会话、不沉淀、不投递），供并排对比。"""
        old = await self._existing(run_id)
        if old["trigger"]["type"] == "replay":
            raise Rejected("conflict", "这是重放出来的运行，请重放它的原运行", 409)
        entry = await self._reg.task(old["task"])
        # 失败的 agent 运行没有 resolution（只有成功才落），所以看"不是规则 / 内建"+ 任务现在是 agent 形态
        if old["resolution"] not in (None, "agent") or old["status"] not in TERMINAL or (
                entry is not None and entry.spec.form != "agent"):
            raise Rejected("conflict", "只能重放已经结束的 agent 运行（内建任务、规则命中、还在跑的不行）", 409)
        req = RunRequest(task=old["task"], service=old["service"], env=old["env"], input=old["input"])
        return await self._relaunch(req, old, RunTrigger(type="replay", id=run_id, caller=caller.name), caller)

    async def _relaunch(self, req: RunRequest, old: dict, trigger: RunTrigger, caller: Caller) -> Accepted:
        entry = await self._reg.task(old["task"])
        if entry is None:
            raise Rejected("unknown_task", f"任务 {old['task']} 已不存在", 404)
        await gates.check_switches(self._reg, task_name=old["task"], task=entry.spec, service=old["service"], env=old["env"])
        run_id = uuid.uuid4().hex[:16]
        session_id = req.session_id or run_id
        await runs.create(run_id=run_id, session_id=session_id, task=old["task"], role=entry.spec.role,
                          service=old["service"], env=old["env"], trigger_type=trigger.type, trigger_id=trigger.id,
                          trigger_source=None, caller=trigger.caller, summary=_summary(req.input, old["summary"]),
                          input_data=req.input, memory=req.memory.model_dump(exclude_none=True),
                          **_queue_fields(old["task"], entry.spec, old["env"], trigger.type))
        return Accepted(run_id, session_id, "queued")

    async def resume(self, run_id: str, caller: Caller, *, auto: bool = False) -> Accepted:
        """失败的运行从断点接着跑（同一个 run_id、同一个会话 thread）。
        auto：任务配置的自动重试发起的（时间线上写「自动重试（第 N 次）」）；人点续跑时顺手取消还在等的自动重试。"""
        run = await self._existing(run_id)
        if run["status"] != "failed":
            raise Rejected("conflict", f"只有失败的运行能续跑（当前 {run['status']}）", 409)
        if run.get("error_code") == "upstream_failed":
            raise Rejected("conflict", "这次运行还没执行过（它等的上游失败了）：等上游成功后用重跑", 409)
        entry = await self._reg.task(run["task"])
        if entry is None or entry.spec.form != "agent":
            raise Rejected("conflict", "只有单角色任务支持续跑；内建任务请用重跑", 409)
        if run["resolution"] == "rule":
            raise Rejected("conflict", "规则命中的运行没有可续的步骤，请用重跑", 409)
        if live := await runs.live_in_session(run["session_id"], exclude=run_id):
            # 续跑接着写同一个会话 thread：会话里另有一轮在跑时两轮会交错
            raise Rejected("conflict", f"这个会话还有一轮在执行（{live['run_id'][:8]}），等它结束或先停止", 409)
        await gates.check_switches(self._reg, task_name=run["task"], task=entry.spec, service=run["service"], env=run["env"])
        # 上次没走到 agent（准备阶段就失败了：配置没填、服务停用…）：checkpoint 里什么都没有，从头执行
        started = await runs.reached_agent(run_id)
        nth = run.get("attempt", 1) + 1
        how = f"自动重试（第 {nth} 次执行）" if auto else f"续跑（{caller.name}）"
        # 先记事件再入队：worker 一认领就会往后写，时间线上「续跑」要排在它前面
        await runs.log_event(run_id, "stage", {"stage": "resume", "title": how if started
                                               else f"{how}；上次没走到 agent，从头开始"})
        # 只改还是 failed 的：两个人同时点续跑只算一次；自动重试还要求重试没在这之间被取消
        if not await runs.enqueue(run_id, resume=started, auto=auto):
            raise Rejected("conflict", "运行刚刚变了（已经续跑，或自动重试被取消了），刷新后再看", 409)
        return Accepted(run_id, run["session_id"], "queued")

    async def cancel(self, run_id: str, caller: Caller) -> dict:
        """先把台账标成 cancelled（事实源），再通知持有它的 worker 停下。点名等它的排队运行跟着不执行。
        失败后正等着自动重试的：取消的是这次重试，运行就此失败（照常通知、触发「失败后」的联动）。"""
        run = await self._existing(run_id)
        if run["status"] == "failed" and run.get("retry_at"):
            if await runs.clear_retry(run_id):
                await runs.log_event(run_id, "stage", {"stage": "retry", "title": f"自动重试已取消（{caller.name}）"})
                if self.on_failed_final is not None:
                    await self.on_failed_final(run_id)
            return await runs.get(run_id)
        if run["status"] in TERMINAL:
            raise Rejected("already_finished", f"运行已结束（{run['status']}）", 409)
        await runs.log_event(run_id, "error", {"title": "cancelled", "content": f"被 {caller.name} 取消"})
        if not await runs.set_status(run_id, "cancelled", output={"error": f"被 {caller.name} 取消"},
                                     error_code="cancelled"):
            run = await runs.get(run_id)       # 刚好在这之间结束了
            raise Rejected("already_finished", f"运行已结束（{run['status'] if run else '—'}）", 409)
        await db.notify("run_cancel", run_id)
        await _fail_dependents(run_id, f"上游运行 {run_id[:8]} 被取消，没有执行")
        return await runs.get(run_id)

    async def wait(self, run_id: str, timeout_s: float) -> dict:
        """等到最终结束或超时，返回当前台账行。失败了、还等着自动重试的不算结束，接着等。"""
        deadline = asyncio.get_running_loop().time() + timeout_s
        delay = 0.3
        while True:
            run = await runs.get(run_id)
            done = run["status"] in TERMINAL and not (run["status"] == "failed" and run.get("retry_at"))
            if done or asyncio.get_running_loop().time() >= deadline:
                return run
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 2.0)

    async def _existing(self, run_id: str) -> dict:
        run = await runs.get(run_id)
        if run is None:
            raise Rejected.not_found(f"运行 {run_id}")
        return run


async def _fail_dependents(run_id: str, reason: str) -> None:
    for rid in await runs.fail_dependents(run_id, reason):
        await runs.log_event(rid, "error", {"title": "upstream_failed", "content": reason})


def _queue_fields(task_name: str, task: TaskDef, env: str, trigger_type: str) -> dict:
    """排队用的几列：优先级按触发类型；任务声明了同时执行上限的，按「父任务@环境」计数（子任务和父任务算一份）。"""
    base = task_name.partition(":")[0]
    return {"priority": PRIORITY.get(trigger_type, 1),
            "concurrency_key": f"{base}@{env}" if task.concurrency else None, "concurrency_limit": task.concurrency}


def _summary(input_data: dict, fallback: str) -> str:
    """列表里那一行显示什么：问题优先，其次第一个字段的值。"""
    value = input_data.get("question") or next((v for v in input_data.values() if isinstance(v, str) and v), None)
    return str(value or fallback)[:300]
