"""Temporal Worker：注册 workflow 与 activity。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from temporalio.worker import Worker

from . import activities as act
from .workflows import RunWorkflow, ScheduleWorkflow

ACTIVITIES = [act.prepare, act.run_agent, act.run_builtin, act.finalize, act.fail, act.deliver, act.fire_schedule,
              act.art_materialize, act.art_gate, act.art_mark]


def create_worker(client, deps: act.Deps, task_queue: str, max_concurrent: int = 20) -> Worker:
    act.configure(deps)
    return Worker(client, task_queue=task_queue, workflows=[RunWorkflow, ScheduleWorkflow], activities=ACTIVITIES,
                  max_concurrent_activities=max_concurrent, activity_executor=ThreadPoolExecutor(4))
