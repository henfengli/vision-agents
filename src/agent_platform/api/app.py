"""FastAPI 应用与业务路由。

create_app：裸应用（health + 通用异常），可在无外部连接时同步构建；
make_api_router：全部 /v1 业务端点——在 lifespan 内、依赖（Submitter 等）
就绪后构建并挂载，装配顺序由 main 保证，不存在占位/延迟绑定。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from ..agent import approvals
from ..agent.roles import RoleDef
from ..orchestration import policies
from ..orchestration.policies import PolicyDef
from ..orchestration.submitter import OverloadedError, Submitter, TaskRejected
from ..orchestration.tasks import TaskDef, TaskRegistry
from ..store import definitions as definitions_store
from ..store import feedback as feedback_store
from ..store import runs
from ..store.definitions import DefinitionStore
from .auth import make_auth_dependency
from .schemas import (ApprovalRequest, CancelRequest, DefinitionPutRequest,
                      FeedbackRequest, SessionFeedbackRequest,
                      StepFeedbackRequest, TaskSubmitRequest)

# 对外暴露的 run 字段白名单：DB 行结构是内部实现，API 契约以这里为准
# （加列/改列不再波及调用方）
_RUN_VIEW = ("run_id", "session_id", "task_type", "task_version", "role",
             "role_version", "domain", "target_env", "trigger_source",
             "caller", "input", "output", "status", "tokens", "duration_ms",
             "created_at")


def run_view(row: dict) -> dict:
    """run 台账行 → 对外视图（字段显式枚举，created_at 归一为字符串）。"""
    view = {k: row.get(k) for k in _RUN_VIEW}
    if view.get("created_at") is not None:
        view["created_at"] = str(view["created_at"])
    return view


def create_app(settings, lifespan=None) -> FastAPI:
    from .. import __version__
    app = FastAPI(title="agent-platform", version=__version__, lifespan=lifespan)

    @app.exception_handler(OverloadedError)
    async def _overloaded(_req, exc):
        return JSONResponse({"detail": str(exc), "error_code": "overloaded"},
                            status_code=429)

    @app.exception_handler(TaskRejected)
    async def _rejected(_req, exc):
        # 客户端错误不冒泡成 500：未知任务/闸门拒绝/终态冲突统一 400
        return JSONResponse({"detail": str(exc), "error_code": "task_rejected"},
                            status_code=400)

    @app.get("/health")
    async def health():
        return {"status": "ok", "env": settings.env, "version": __version__,
                "target_envs": settings.target_envs or [settings.env]}

    return app


def make_api_router(settings, submitter: Submitter, tasks: TaskRegistry,
                    defs: DefinitionStore, langfuse=None,
                    schedule_sync=None) -> APIRouter:
    auth = make_auth_dependency(settings.bearer_token)
    router = APIRouter(dependencies=[Depends(auth)])

    @router.post("/v1/tasks")
    async def submit_task(req: TaskSubmitRequest,
                          idempotency_key: str | None = Header(None)):
        """异步提交任务。Idempotency-Key 头：24h 内同键重提返回首个 run
        （排队/运行中/成功均命中；失败允许同键重提）。"""
        return await submitter.submit(req.task_type, req.input,
                                      trigger_source="sdk", caller=req.caller,
                                      role=req.role, target_env=req.env,
                                      idempotency_key=idempotency_key)

    @router.get("/v1/tasks/{run_id}")
    async def get_task(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        return run_view(run)

    @router.get("/v1/runs")
    async def list_runs(env: str | None = None, status: str | None = None,
                        task: str | None = None, source: str | None = None,
                        domain: str | None = None, q: str | None = None,
                        hours: int | None = None, after: str | None = None,
                        limit: int = 100):
        """run 列表：平面过滤 + keyset 游标（与 Viewer 同一查询实现）。

        after = 上一页响应里的 next_cursor；hours = 最近 N 小时。
        """
        rows, total, next_cursor, _ = await runs.list_filtered(
            target_env=env, status=status, task=task, source=source,
            domain=domain, q=q, hours=hours, after=after,
            limit=min(limit, 500))
        return {"runs": rows, "total": total, "next_cursor": next_cursor}

    @router.get("/v1/runs/{run_id}/events")
    async def run_events(run_id: str, after_seq: int = -1):
        """run 事件流：after_seq 增量拉取（调用方观测执行进度的通道）。"""
        if await runs.get(run_id) is None:
            raise HTTPException(404, "run 不存在")
        return {"run_id": run_id,
                "events": await runs.get_events(run_id, after_seq=after_seq)}

    @router.post("/v1/runs/{run_id}/cancel")
    async def cancel_run(run_id: str, req: CancelRequest):
        """取消 run：terminate workflow + 落 cancelled 终态（终态重复取消 409）。"""
        try:
            return await submitter.cancel_run(run_id, by=req.by)
        except TaskRejected as e:
            raise HTTPException(404 if "不存在" in str(e) else 409,
                                str(e)) from None

    @router.get("/v1/approvals")
    async def list_approvals(status: str = "pending", limit: int = 50):
        """审批查询：pending=待办收件箱；approved/rejected/空=已处理历史。"""
        if status == "pending":
            return {"approvals": await approvals.list_pending(
                limit=min(limit, 200))}
        items, total = await approvals.list_decided(
            status or None, limit=min(limit, 200))
        return {"approvals": items, "total": total}

    @router.post("/v1/runs/{run_id}/resume")
    async def resume_run(run_id: str):
        """续跑失败/中断的 run（Temporal 只允许顶替终态执行）。"""
        try:
            return await submitter.resume_run(run_id)
        except TaskRejected as e:
            raise HTTPException(409, str(e))

    @router.post("/v1/runs/{run_id}/rerun")
    async def rerun_run(run_id: str):
        """重跑：失败/终止 → 断点续跑（同 id）；成功 → 同输入新开 run。"""
        return await submitter.rerun(run_id)  # TaskRejected 走全局 400

    @router.post("/v1/runs/{run_id}/steps/{seq}/feedback")
    async def step_feedback(run_id: str, seq: int, req: StepFeedbackRequest):
        """单步反馈：Langfuse 优先挂对应 span（等价 Annotate），映射不上
        降级为 trace 级 score（名字带 step#seq 定位）。"""
        if req.score not in (1, -1):
            raise HTTPException(422, "score 只能是 +1 或 -1")
        if await runs.get(run_id) is None:
            raise HTTPException(404, "run 不存在")
        await feedback_store.add_step(run_id, seq, req.score, req.comment)
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            if tid:
                from ..langfuse import match_observation
                obs = await langfuse.observations(tid)
                oid = match_observation(
                    await runs.get_events(run_id), seq, obs)
                await langfuse.score(tid, f"step#{seq}", float(req.score),
                                     req.comment, observation_id=oid)
        return {"status": "ok"}

    @router.post("/v1/approvals/{run_id}")
    async def approve(run_id: str, req: ApprovalRequest):
        pending = await approvals.find_pending(run_id)
        if pending is None:
            raise HTTPException(404, "该 run 没有待审批项")
        if not await approvals.decide(pending["id"], req.approved,
                                      req.decided_by):
            # 并发审批：已被他人抢先处理，回执不能说谎
            raise HTTPException(409, "该审批项已被处理")
        # 任务级提交闸门：放行即启动 workflow；拒绝则 run 置失败
        await policies.settle_submit_gate(run_id, req.approved, submitter)
        return {"status": "approved" if req.approved else "rejected"}

    @router.post("/v1/feedback/{run_id}")
    async def feedback(run_id: str, req: FeedbackRequest):
        """打分反馈：回写知识/案例评分 + Langfuse score。"""
        try:
            await feedback_store.add(run_id, req.score, req.comment)
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        # 记忆按目标环境分区：传播到该 run 实际操作的环境（与 Viewer 同源）
        run = await runs.get(run_id)
        await feedback_store.propagate_to_memory(
            (run or {}).get("target_env") or settings.env, run_id, req.score)
        if langfuse is not None and langfuse.enabled:
            tid = await runs.trace_id_of(run_id)
            await langfuse.score(tid, "user_feedback",
                                 1.0 if req.score > 0 else 0.0,
                                 comment=req.comment or "")
        return {"status": "ok"}

    @router.post("/v1/sessions/{session_id}/feedback")
    async def session_feedback(session_id: str, req: SessionFeedbackRequest):
        """纠正式反馈：从 session 最近一次 run 继承任务/角色/域重判。

        新 run 在同一 session（共享上下文）里带着纠正重新判断；finalize 时
        把上一次 run 沉淀的知识/案例置 valid_to（不误伤更早的正确历史），
        再沉淀新结论。任务上下文不写死——纠正谁就用谁的配置。
        """
        await feedback_store.add_correction(session_id, req.correction, req.by)
        try:
            result = await submitter.correct(session_id, req.correction, req.by)
        except TaskRejected as e:
            raise HTTPException(404 if "不存在" in str(e) else 409, str(e))
        return {"status": "correction_submitted", "run_id": result["run_id"]}

    # —— Admin：角色/任务 CRUD ——

    async def usage_hint(kind: str, name: str) -> dict | None:
        """保存后的影响面提示：上一版本在近 24h 被多少 run 使用。"""
        version = await definitions_store.active_version(kind, settings.env, name)
        if not version or version < 2:
            return {"version": version} if version else None
        prev = version - 1
        count = await runs.count_recent_with_version(kind, name, prev)
        return {"version": version, "previous_version": prev,
                "recent_runs_on_previous": count}

    @router.post("/v1/admin/roles")
    async def put_role(req: DefinitionPutRequest):
        """角色定义：Langfuse 启用时写 Langfuse（新版本+label），同步写穿 PG 缓存；
        未启用时只写 PG（降级模式）。幂等：内容不变的 PG 写不产生新版本。"""
        try:
            RoleDef.model_validate({"name": req.name, **req.definition})
        except Exception as e:
            raise HTTPException(422, f"角色定义不合法：{e}")
        if langfuse is not None and langfuse.enabled:
            try:
                await langfuse.put_role(req.name, req.definition,
                                        updated_by=req.updated_by)
            except Exception as e:
                raise HTTPException(502, f"Langfuse 写入失败：{e}")
        await defs.cache_put("role", settings.env, req.name, req.definition)
        return {"name": req.name, **(await usage_hint("role", req.name) or {})}

    @router.get("/v1/admin/roles")
    async def list_roles():
        return await defs.list_active("role", settings.env)

    @router.get("/v1/admin/roles/{name}/history")
    async def role_history(name: str):
        return await defs.history("role", settings.env, name)

    @router.post("/v1/admin/roles/{name}/rollback/{version}")
    async def rollback_role(name: str, version: int):
        """回滚到历史版本（Langfuse 启用时同步推回一个新版本接管 label）。"""
        history = await defs.history("role", settings.env, name)
        target = next((h for h in history if h["version"] == version), None)
        if target is None:
            raise HTTPException(404, f"角色 {name} 不存在版本 {version}")
        definition = target["definition"]
        if langfuse is not None and langfuse.enabled:
            await langfuse.put_role(name, definition,
                                    updated_by=f"rollback-to-v{version}")
        new_version = await defs.put("role", settings.env, name, definition,
                                     updated_by=f"rollback-to-v{version}")
        return {"name": name, "version": new_version}

    @router.post("/v1/admin/tasks")
    async def put_task(req: DefinitionPutRequest):
        try:
            task = TaskDef.model_validate({"name": req.name, **req.definition})
        except Exception as e:
            raise HTTPException(422, f"任务定义不合法：{e}")
        if task.extends == req.name:
            raise HTTPException(422, "任务不能继承自己")
        if task.extends and await tasks.get(task.extends) is None:
            raise HTTPException(422, f"父任务 {task.extends} 不存在")
        # 命名即绑定：子任务名必须是 "父任务:对象名"，否则命名与继承
        # 关系脱节（选择器按名字后缀匹配输入值，见 tasks.find_child）
        if task.extends and not req.name.startswith(task.extends + ":"):
            raise HTTPException(
                422, f"子任务名须以父任务名为前缀：{task.extends}:<对象名>")
        await defs.put("task", settings.env, req.name,
                       req.definition, req.updated_by)
        # 定时任务热生效：保存后立即重同步 Temporal Schedules（不必等重启；
        # 失败只留痕，由周期对账兜底）
        synced = await schedule_sync() if schedule_sync is not None else None
        return {"name": req.name,
                **({"schedule_resynced": True} if synced is not None else {}),
                **(await usage_hint("task", req.name) or {})}

    @router.get("/v1/admin/tasks")
    async def list_tasks():
        return await tasks.list()

    # —— Admin：提交策略（闸门链，policies.py） ——

    @router.post("/v1/admin/policies")
    async def put_policy(req: DefinitionPutRequest):
        try:
            PolicyDef.model_validate({"name": req.name, **req.definition})
        except Exception as e:
            raise HTTPException(422, f"策略定义不合法：{e}")
        version = await defs.put("policy", settings.env, req.name,
                                 req.definition, req.updated_by)
        return {"name": req.name, "version": version}

    @router.get("/v1/admin/policies")
    async def list_policies():
        return await defs.list_active("policy", settings.env)

    # —— Admin：报错规则库（rules 服务模块；按域存，name=域名） ——

    @router.post("/v1/admin/rules")
    async def put_rules(req: DefinitionPutRequest):
        """保存某域的规则库（新版本，热生效）。definition={"rules": [...]}。"""
        from .. import rules as rules_svc
        try:
            rules = rules_svc.validate(req.definition.get("rules"))
        except ValueError as e:
            raise HTTPException(422, f"规则库定义不合法：{e}")
        version = await defs.put("rules", settings.env, req.name,
                                 {"rules": rules}, req.updated_by)
        return {"name": req.name, "version": version}

    @router.get("/v1/admin/rules")
    async def list_rules():
        return await defs.list_active("rules", settings.env)

    @router.get("/v1/admin/rules/{name}")
    async def get_rules(name: str):
        return await _get_def("rules", name)

    @router.get("/v1/admin/rules/{name}/history")
    async def rules_history(name: str):
        return await defs.history("rules", settings.env, name)

    @router.post("/v1/admin/rules/{name}/rollback/{version}")
    async def rollback_rules(name: str, version: int):
        history = await defs.history("rules", settings.env, name)
        target = next((h for h in history if h["version"] == version), None)
        if target is None:
            raise HTTPException(404, f"规则库 {name} 不存在版本 {version}")
        new_version = await defs.put("rules", settings.env, name,
                                     target["definition"],
                                     updated_by=f"rollback-to-v{version}")
        return {"name": name, "version": new_version}

    # —— Admin：单条读取 / 历史 / 回滚（三类补齐，AI 的 read-modify-write 闭环） ——

    async def _get_def(kind: str, name: str) -> dict:
        definition = await defs.get_active(kind, settings.env, name)
        if definition is None:
            raise HTTPException(404, f"{kind}:{name} 不存在")
        version = await definitions_store.active_version(
            kind, settings.env, name)
        return {**definition, "name": name, "version": version}

    @router.get("/v1/admin/roles/{name}")
    async def get_role(name: str):
        return await _get_def("role", name)

    @router.get("/v1/admin/tasks/{name}")
    async def get_task_def(name: str):
        return await _get_def("task", name)

    @router.get("/v1/admin/policies/{name}")
    async def get_policy(name: str):
        return await _get_def("policy", name)

    @router.get("/v1/admin/tasks/{name}/history")
    async def task_history(name: str):
        return await defs.history("task", settings.env, name)

    @router.get("/v1/admin/policies/{name}/history")
    async def policy_history(name: str):
        return await defs.history("policy", settings.env, name)

    @router.post("/v1/admin/tasks/{name}/rollback/{version}")
    async def rollback_task(name: str, version: int):
        """回滚 = 旧版本内容重新 put 为新版本；定时任务随即重同步 Schedule。"""
        try:
            await defs.rollback("task", settings.env, name, version)
        except KeyError as e:
            raise HTTPException(404, str(e)) from None
        synced = await schedule_sync() if schedule_sync is not None else None
        return {"name": name,
                **({"schedule_resynced": True} if synced is not None else {})}

    @router.post("/v1/admin/policies/{name}/rollback/{version}")
    async def rollback_policy(name: str, version: int):
        try:
            await defs.rollback("policy", settings.env, name, version)
        except KeyError as e:
            raise HTTPException(404, str(e)) from None
        return {"name": name}

    return router
