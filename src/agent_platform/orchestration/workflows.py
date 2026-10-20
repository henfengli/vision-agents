"""Temporal workflows。

RunWorkflow：一次运行的完整生命周期，所有任务形态共用一个 workflow：

    prepare → 执行（agent / graph / builtin / rule）→ finalize → deliver
               └──────── 任一步失败 ────────→ fail → deliver

workflow id = run_id。续跑用同一个 id 重新启动（只允许顶替已失败的执行）。
取消由提交端先把台账标成 cancelled 再取消 workflow，这里不再写状态。

ScheduleWorkflow：定时触发的落点，只做一件事——走提交端发起一次运行。
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, TimeoutError

with workflow.unsafe.imports_passed_through():
    from . import activities as act
    from .artgraph import run_graph

QUICK = dict(start_to_close_timeout=timedelta(seconds=120), retry_policy=RetryPolicy(maximum_attempts=3))
ONCE = RetryPolicy(maximum_attempts=1)          # 执行步骤不自动重试：模型/工具错误交给人判断（续跑/重跑）


@workflow.defn
class RunWorkflow:
    @workflow.run
    async def run(self, spec: dict) -> dict:
        timeout = timedelta(seconds=min(int(spec.get("timeout_s") or 300), 7200))
        long = dict(start_to_close_timeout=timeout, heartbeat_timeout=timedelta(seconds=120), retry_policy=ONCE)

        async def call(fn, *args):
            return await workflow.execute_activity(fn, args=list(args), **long)

        output: dict = {}
        try:
            spec = await workflow.execute_activity(act.prepare, spec, **QUICK)
            if spec["form"] == "agent":
                output, resolution = await call(act.run_agent, spec), "agent"
            elif spec["form"] == "graph":
                output, resolution = await run_graph(spec, call), "graph"
            elif spec["form"] == "rule":
                output, resolution = spec["rule_output"], "rule"
            else:
                output, resolution = await call(act.run_builtin, spec), "builtin"
            await workflow.execute_activity(act.finalize, args=[spec, output, resolution], **QUICK)
        except CancelledError:
            raise
        except ActivityError as e:
            message, code = _describe(e)
            if code == "cancelled":
                return {}
            await workflow.execute_activity(act.fail, args=[spec, message, code], **QUICK)
            await workflow.execute_activity(act.deliver, spec, **QUICK)
            raise ApplicationError(message, type=code) from None
        await workflow.execute_activity(act.deliver, spec, **QUICK)
        return output


def _describe(e: ActivityError) -> tuple[str, str]:
    """activity 失败 → (给人看的原因, 原因码)。"""
    cause = e.cause
    if isinstance(cause, TimeoutError):
        return "执行超时（任务的 timeout_s）", "timeout"
    if isinstance(cause, ApplicationError):
        if cause.type == "Cancelled":
            return cause.message, "cancelled"
        if cause.type == "Rejected":
            return cause.message, (cause.details[0] if cause.details else "rejected")
        return f"{cause.type}: {cause.message}" if cause.type else cause.message, "error"
    return str(cause or e), "error"


@workflow.defn
class ScheduleWorkflow:
    @workflow.run
    async def run(self, task: str, trigger_id: str, env: str) -> str | None:
        return await workflow.execute_activity(act.fire_schedule, args=[task, trigger_id, env], **QUICK)
