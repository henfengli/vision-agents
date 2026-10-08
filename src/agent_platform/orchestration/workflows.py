"""Temporal Workflow 与调度。

AgentRunWorkflow：prepare → run_agent → finalize，每步一个 activity，
事件历史即执行记录。崩溃恢复、重试、超时、跨机执行全部由 Temporal 接管。

审批等待在 run_agent 内（DB+NOTIFY+heartbeat）；续跑 = 同 workflow id
重新 start（ID 复用策略只允许失败/终止的执行被顶替）。
"""

from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

from .spec import RunSpec

with workflow.unsafe.imports_passed_through():
    from .activities import finalize_run, mark_failed, prepare_run, run_agent

# agent 步骤不自动重试：模型/工具错误由人工或恢复路径处理；
# prepare/finalize 是轻量 DB 操作，允许自动重试
_RETRY_LIGHT = RetryPolicy(maximum_attempts=3)
_RETRY_NONE = RetryPolicy(maximum_attempts=1)


@workflow.defn
class AgentRunWorkflow:
    """一个 run 的完整生命周期。workflow id = run_id（调度触发时 = sched-<task>）。"""

    @workflow.run
    async def run(self, spec: dict) -> dict:
        timeout_s = min(int(spec.get("timeout_s") or 1800), 7200)
        try:
            # prepare 返回真实 run_id（调度触发时现场生成）+ 召回后的 prompt
            prepared = await workflow.execute_activity(
                prepare_run, spec,
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=_RETRY_LIGHT)
            spec = {**spec, **prepared}
            output = await workflow.execute_activity(
                run_agent, spec,
                start_to_close_timeout=timedelta(seconds=timeout_s),
                heartbeat_timeout=timedelta(seconds=120),
                retry_policy=_RETRY_NONE)
            return await workflow.execute_activity(
                finalize_run, args=[spec, output],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=_RETRY_LIGHT)
        except Exception as e:
            if spec.get("run_id"):
                await workflow.execute_activity(
                    mark_failed, args=[spec, str(e)],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=_RETRY_LIGHT)
            raise


# ==================== 调度（Temporal Schedules） ====================


async def sync_schedules(client, tasks: list, task_queue: str) -> int:
    """把带 schedule 的任务定义同步为 Temporal Schedules。幂等。

    任务定义变更/删除时：平台前缀下多余的 schedule 删除，同名的更新。
    """
    from temporalio.client import (Schedule, ScheduleActionStartWorkflow,
                                   ScheduleOverlapPolicy, ScheduleSpec)
    from temporalio.common import WorkflowIDReusePolicy

    prefix = "task:"
    wanted = {t.name: t for t in tasks if getattr(t, "schedule", None)}

    existing = set()
    async for s in await client.list_schedules():
        if s.id.startswith(prefix):
            existing.add(s.id)

    for sid in existing - {prefix + n for n in wanted}:  # 删多余的
        try:
            await client.get_schedule_handle(sid).delete()
        except Exception:  # noqa: BLE001
            pass

    count = 0
    for name, task in wanted.items():
        spec = RunSpec(  # run_id 空 = 触发时由 prepare_run 生成
            task_type=task.name, role=task.role,
            question=_schedule_question(task),
            input=dict(task.schedule_input or {}),
            timeout_s=task.timeout_s, trigger="schedule").to_dict()
        action = ScheduleActionStartWorkflow(
            AgentRunWorkflow.run, spec,
            id=f"sched-{name}",
            task_queue=task_queue,
            id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE)
        schedule = Schedule(
            action=action,
            spec=ScheduleSpec(cron_expressions=[task.schedule]),
            overlap=ScheduleOverlapPolicy.SKIP)
        sid = prefix + name
        try:
            if sid in existing:
                await client.get_schedule_handle(sid).update(lambda _cur: schedule)
            else:
                await client.create_schedule(sid, schedule)
            count += 1
        except Exception:  # noqa: BLE001
            pass
    return count


def _schedule_question(task) -> str:
    lines = [f"任务类型：{task.name}"]
    lines += [f"{k}: {v}" for k, v in (task.schedule_input or {}).items()]
    return "\n".join(lines)
