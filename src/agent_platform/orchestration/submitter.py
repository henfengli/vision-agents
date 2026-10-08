"""Temporal 提交端：api/triggers 的统一入口。

- submit：建台账行 + start_workflow（id=run_id，重复 id 拒绝）
- run_sync：start + 等待结果（超时转异步轮询）
- resume_run：同 id 重新 start，ID 复用策略只允许顶替已失败/已终止的执行
- correct：纠正式反馈——从 session 最近 run 继承 task_type/role/domain，
  不调用方传、不写死任务类型

概念唯一：只有 session_id。run 无会话归属时 session_id=run_id（自会话）。
"""

from __future__ import annotations

import asyncio
import uuid

from temporalio.client import Client
from temporalio.common import WorkflowIDReusePolicy

from ..store import runs
from .spec import RunSpec
from .tasks import TaskDef, TaskRegistry
from .workflows import AgentRunWorkflow


class TaskRejected(ValueError):
    pass


class OverloadedError(RuntimeError):
    """同步入口超载：调用方收到 429 后重试。"""


class Submitter:
    def __init__(self, client: Client, tasks: TaskRegistry, task_queue: str,
                 env: str, max_inflight_sync: int = 50):
        self._client = client
        self._tasks = tasks
        self._tq = task_queue
        self._env = env
        self._max_inflight = max_inflight_sync
        self._inflight = 0

    # —— 内部 ——

    async def _resolve_task(self, task_name: str, role: str | None) -> TaskDef:
        task = await self._tasks.get(task_name)
        if task is None:
            raise TaskRejected(f"未知任务类型：{task_name}")
        if not task.enabled_in(self._env):
            raise TaskRejected(f"任务 {task_name} 未在当前环境（{self._env}）启用")
        if role:
            task = task.model_copy(update={"role": role})
        return task

    async def _start(self, task: TaskDef, input_data: dict, trigger_source: str,
                     caller: str | None, session_id: str | None,
                     correction: bool, run_id: str | None = None,
                     resume: bool = False, domain: str | None = None) -> dict:
        run_id = run_id or uuid.uuid4().hex[:16]
        session_id = session_id or run_id
        if not resume:
            dedup_key = task.compute_dedup_key(input_data)
            if dedup_key:
                existing = await runs.find_by_dedup(dedup_key, task.dedup_window_s)
                if existing:
                    return {"run_id": existing["run_id"], "status": "dedup_hit",
                            "dedup_hit": True}
            await runs.create(
                run_id, task.name, task.role,
                domain=domain or str(input_data.get("server")
                                     or input_data.get("domain") or "") or None,
                trigger_source=trigger_source, caller=caller or "",
                input_data=input_data, dedup_key=dedup_key,
                session_id=session_id)
        spec = RunSpec(run_id=run_id, task_type=task.name, role=task.role,
                       question=_to_question(task, input_data),
                       input=input_data, error_text=input_data.get("error"),
                       session_id=session_id, timeout_s=task.timeout_s,
                       trigger=trigger_source, correction=correction,
                       resume=resume).to_dict()
        kw = {}
        if resume:
            kw["id_reuse_policy"] = (
                WorkflowIDReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY)
        await self._client.start_workflow(
            AgentRunWorkflow.run, spec, id=run_id, task_queue=self._tq, **kw)
        return {"run_id": run_id, "session_id": session_id,
                "status": "queued", "dedup_hit": False}

    # —— 对外 ——

    async def submit(self, task_name: str, input_data: dict,
                     trigger_source: str, caller: str | None = None,
                     session_id: str | None = None, role: str | None = None,
                     correction: bool = False) -> dict:
        task = await self._resolve_task(task_name, role)
        return await self._start(task, input_data, trigger_source, caller,
                                 session_id, correction)

    async def correct(self, session_id: str, correction_text: str,
                      by: str = "") -> dict:
        """纠正式反馈：从 session 最近一次 run 继承任务上下文重判。"""
        last = await runs.latest_of_session(session_id)
        if last is None:
            raise TaskRejected(f"session {session_id} 不存在或无历史 run")
        task = await self._resolve_task(last["task_type"], last["role"])
        input_data = dict(last.get("input") or {})
        input_data["correction"] = correction_text
        input_data["corrected_by"] = by
        return await self._start(task, input_data, "feedback", by,
                                 session_id, correction=True,
                                 domain=last["domain"])

    async def run_sync(self, task_name: str, input_data: dict,
                       trigger_source: str, session_id: str | None = None,
                       role: str | None = None) -> dict:
        """同步路径：提交后等结果，超时转异步。"""
        if self._inflight >= self._max_inflight:
            raise OverloadedError("服务繁忙，请稍后重试")
        self._inflight += 1
        try:
            submitted = await self.submit(task_name, input_data,
                                          trigger_source,
                                          session_id=session_id, role=role)
            if submitted["dedup_hit"]:
                run = await runs.get(submitted["run_id"])
                return {"run_id": submitted["run_id"],
                        "output": (run or {}).get("output")}
            run_id = submitted["run_id"]
            task = await self._tasks.get(task_name)
            timeout = min(task.timeout_s if task else 300, 300)
            try:
                handle = self._client.get_workflow_handle(run_id)
                output = await asyncio.wait_for(handle.result(), timeout)
                return {"run_id": run_id, "output": output}
            except asyncio.TimeoutError:
                return {"run_id": run_id, "output": None,
                        "note": f"超过 {timeout}s 未完成，可轮询 /v1/tasks/{run_id}"}
        finally:
            self._inflight -= 1

    async def resume_run(self, run_id: str) -> dict:
        """续跑失败/中断的 run：同 id 重新 start（只允许顶替终态执行）。"""
        run = await runs.get(run_id)
        if run is None:
            raise TaskRejected(f"run {run_id} 不存在")
        if run["status"] == "success":
            raise TaskRejected("run 已完成，无需续跑")
        task = await self._resolve_task(run["task_type"], run["role"])
        return await self._start(task, run.get("input") or {}, "resume",
                                 run.get("caller"), run.get("session_id"),
                                 correction=False, run_id=run_id, resume=True,
                                 domain=run.get("domain"))


def _to_question(task: TaskDef, input_data: dict) -> str:
    lines = [f"任务类型：{task.name}"]
    lines += [f"{k}: {v}" for k, v in input_data.items()]
    return "\n".join(lines)
