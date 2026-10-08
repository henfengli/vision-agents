"""Temporal Worker：activity 注册与依赖注入。"""

from __future__ import annotations

from temporalio.client import Client
from temporalio.worker import Worker

from . import activities
from .workflows import AgentRunWorkflow


async def create_worker(client: Client, deps: activities.Deps,
                        task_queue: str) -> Worker:
    activities.configure(deps)
    return Worker(
        client, task_queue=task_queue,
        workflows=[AgentRunWorkflow],
        activities=[activities.prepare_run, activities.run_agent,
                    activities.finalize_run, activities.mark_failed],
    )
