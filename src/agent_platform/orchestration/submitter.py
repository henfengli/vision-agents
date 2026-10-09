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

from ..config import resolve_target_env
from ..store import runs
from ..store.definitions import DefinitionStore
from . import policies
from .spec import RunSpec
from .tasks import TaskDef, TaskRegistry, question_text
from .workflows import (AgentRunWorkflow, ArtifactRunWorkflow,
                        BuiltinTaskWorkflow)


class TaskRejected(ValueError):
    pass


class OverloadedError(RuntimeError):
    """同步入口超载：调用方收到 429 后重试。"""


class Submitter:
    def __init__(self, client: Client, tasks: TaskRegistry, task_queue: str,
                 env: str, max_inflight_sync: int = 50,
                 defs: DefinitionStore | None = None,
                 approval_notifier=None,
                 target_envs: list[str] | None = None,
                 default_target_env: str | None = None):
        self._client = client
        self._tasks = tasks
        self._tq = task_queue
        self._env = env                          # 实例标签（定义按它存取）
        self._max_inflight = max_inflight_sync
        self._inflight = 0
        self._defs = defs                       # 策略链（policies.py）的定义源
        self._approval_notifier = approval_notifier  # 任务级闸门钉钉通知
        self._target_envs = target_envs or []    # 可操作的业务环境（空=单环境）
        self._default_target = default_target_env

    # —— 内部 ——

    def _resolve_target_env(self, env: str | None) -> str:
        """目标业务环境解析；实现在 config.resolve_target_env（唯一出处）。

        这里只做异常翻译：config 层抛 ValueError，提交入口统一对外
        TaskRejected（Submitter 从构造参数取值，不依赖 Settings）。
        """
        try:
            return resolve_target_env(env, self._target_envs,
                                      self._default_target, self._env)
        except ValueError as e:
            raise TaskRejected(str(e)) from e

    async def _resolve_task(self, task_name: str, role: str | None,
                            target_env: str) -> TaskDef:
        task = await self._tasks.get(task_name)
        if task is None:
            raise TaskRejected(f"未知任务类型：{task_name}")
        if not task.enabled_in(target_env):
            raise TaskRejected(
                f"任务 {task_name} 未在目标环境（{target_env}）启用")
        if role:
            task = task.model_copy(update={"role": role})
        return task

    async def _start(self, task: TaskDef, input_data: dict, trigger_source: str,
                     caller: str | None, session_id: str | None,
                     correction: bool, run_id: str | None = None,
                     resume: bool = False, row_exists: bool = False,
                     domain: str | None = None, target_env: str = "") -> dict:
        run_id = run_id or uuid.uuid4().hex[:16]
        session_id = session_id or run_id
        if not resume and not row_exists:
            dedup_key = task.compute_dedup_key(input_data)
            if dedup_key:
                existing = await runs.find_by_dedup(dedup_key, task.dedup_window_s)
                if existing:
                    return {"run_id": existing["run_id"], "status": "dedup_hit",
                            "dedup_hit": True}
            await self._create_row(run_id, task, input_data, trigger_source,
                                   caller, session_id, domain, dedup_key,
                                   target_env)
        spec = RunSpec(run_id=run_id, task_type=task.name, role=task.role,
                       question=_to_question(task, input_data),
                       input=input_data, error_text=input_data.get("error"),
                       session_id=session_id, timeout_s=task.timeout_s,
                       target_env=target_env,
                       trigger=trigger_source, correction=correction,
                       resume=resume,
                       artifacts=({k: v.model_dump() for k, v in
                                   task.artifacts.items()}
                                  if task.artifacts else None),
                       handler=task.handler).to_dict()
        # 任务形态分发：资产图 / 内建处理器 / 单 agent（默认）
        wf = (BuiltinTaskWorkflow.run if task.handler else
              ArtifactRunWorkflow.run if task.artifacts else
              AgentRunWorkflow.run)
        kw = {}
        if resume:
            kw["id_reuse_policy"] = (
                WorkflowIDReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY)
        await self._client.start_workflow(
            wf, spec, id=run_id, task_queue=self._tq, **kw)
        return {"run_id": run_id, "session_id": session_id,
                "status": "queued", "dedup_hit": False,
                "target_env": target_env}

    @staticmethod
    async def _create_row(run_id: str, task: TaskDef, input_data: dict,
                          trigger_source: str, caller: str | None,
                          session_id: str, domain: str | None,
                          dedup_key: str, target_env: str = "") -> None:
        await runs.create(
            run_id, task.name, task.role,
            domain=domain or str(input_data.get("server")
                                 or input_data.get("domain") or "") or None,
            trigger_source=trigger_source, caller=caller or "",
            input_data=input_data, dedup_key=dedup_key,
            session_id=session_id, target_env=target_env)

    async def _gate(self, task: TaskDef, input_data: dict, trigger_source: str,
                    caller: str | None, session_id: str | None,
                    verdict: policies.Verdict, target_env: str = "") -> dict:
        """任务级闸门：建行 + 审批单 + 钉钉通知，workflow 等放行后才启动。"""
        from ..agent import approvals as approval_store

        dedup_key = task.compute_dedup_key(input_data)
        if dedup_key:
            existing = await runs.find_by_dedup(dedup_key, task.dedup_window_s)
            if existing:
                return {"run_id": existing["run_id"], "status": "dedup_hit",
                        "dedup_hit": True}
        run_id = uuid.uuid4().hex[:16]
        session_id = session_id or run_id
        await self._create_row(run_id, task, input_data, trigger_source,
                               caller, session_id, None, dedup_key, target_env)
        summary = policies.gate_summary(task.name, verdict)
        if target_env:
            summary = f"[{target_env}] {summary}"
        approval_id = await approval_store.request_approval(run_id, summary)
        await runs.log_event(run_id, "note",
                             {"stage": "submit_gate", "policy": verdict.policy,
                              "approval_id": approval_id})
        if self._approval_notifier is not None:
            await self._approval_notifier(run_id, summary)
        return {"run_id": run_id, "session_id": session_id,
                "status": "awaiting_approval", "approval_id": approval_id,
                "dedup_hit": False, "target_env": target_env}

    async def approve_start(self, run_id: str) -> dict:
        """提交闸门放行后的启动：workflow 此刻才第一次 start。"""
        run = await runs.get(run_id)
        if run is None:
            raise TaskRejected(f"run {run_id} 不存在")
        task = await self._resolve_task(run["task_type"], run["role"] or None,
                                        run.get("target_env") or self._env)
        # 闸门挂起的 run 从未启动过 workflow：不是 resume（没有可续的
        # LangGraph thread），而是首次启动——只跳过建行/去重
        return await self._start(task, run.get("input") or {},
                                 run["trigger_source"], run.get("caller"),
                                 run.get("session_id"), correction=False,
                                 run_id=run_id, row_exists=True,
                                 domain=run.get("domain"),
                                 target_env=run.get("target_env") or "")

    # —— 对外 ——

    async def submit(self, task_name: str, input_data: dict,
                     trigger_source: str, caller: str | None = None,
                     session_id: str | None = None, role: str | None = None,
                     correction: bool = False,
                     target_env: str | None = None) -> dict:
        target_env = self._resolve_target_env(target_env)
        task = await self._resolve_task(task_name, role, target_env)
        # 提交闸门链（policies.py）：env_gate 之外的 DB 声明策略都在这里过
        if self._defs is not None and not correction:
            verdict = await policies.evaluate_submit(
                task, target_env, self._env, input_data,
                _to_question(task, input_data), self._defs)
            if verdict.action == "deny":
                raise TaskRejected(verdict.message)
            if verdict.action == "require_approval":
                return await self._gate(task, input_data, trigger_source,
                                        caller, session_id, verdict,
                                        target_env)
        return await self._start(task, input_data, trigger_source, caller,
                                 session_id, correction, target_env=target_env)

    async def correct(self, session_id: str, correction_text: str,
                      by: str = "") -> dict:
        """纠正式反馈：从 session 最近一次 run 继承任务上下文重判。"""
        last = await runs.latest_of_session(session_id)
        if last is None:
            raise TaskRejected(f"session {session_id} 不存在或无历史 run")
        target_env = self._resolve_target_env(last.get("target_env") or None)
        task = await self._resolve_task(last["task_type"], last["role"],
                                        target_env)
        input_data = dict(last.get("input") or {})
        input_data["correction"] = correction_text
        input_data["corrected_by"] = by
        return await self._start(task, input_data, "feedback", by,
                                 session_id, correction=True,
                                 domain=last["domain"], target_env=target_env)

    async def run_sync(self, task_name: str, input_data: dict,
                       trigger_source: str, session_id: str | None = None,
                       role: str | None = None,
                       target_env: str | None = None) -> dict:
        """同步路径：提交后等结果，超时转异步。"""
        if self._inflight >= self._max_inflight:
            raise OverloadedError("服务繁忙，请稍后重试")
        self._inflight += 1
        try:
            submitted = await self.submit(task_name, input_data,
                                          trigger_source,
                                          session_id=session_id, role=role,
                                          target_env=target_env)
            if submitted["dedup_hit"]:
                run = await runs.get(submitted["run_id"])
                return {"run_id": submitted["run_id"],
                        "output": (run or {}).get("output")}
            if submitted.get("status") == "awaiting_approval":
                # 提交闸门挂起：workflow 尚未启动，没有可等的 handle
                return {"run_id": submitted["run_id"], "output": None,
                        "note": "任务待提交审批，批准后自动开始执行",
                        "approval_id": submitted.get("approval_id")}
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
        task = await self._resolve_task(run["task_type"], run["role"],
                                        run.get("target_env") or self._env)
        return await self._start(task, run.get("input") or {}, "resume",
                                 run.get("caller"), run.get("session_id"),
                                 correction=False, run_id=run_id, resume=True,
                                 domain=run.get("domain"),
                                 target_env=run.get("target_env") or "")


def _to_question(task: TaskDef, input_data: dict) -> str:
    return question_text(task, input_data)  # 实现唯一出处：tasks.question_text
