"""FastAPI 应用与业务路由。

create_app：裸应用（health + 通用异常），可在无外部连接时同步构建；
make_api_router：全部 /v1 业务端点——在 lifespan 内、依赖（Submitter 等）
就绪后构建并挂载，装配顺序由 main 保证，不存在占位/延迟绑定。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from ..agent import approvals
from ..agent.roles import RoleDef
from ..orchestration import policies
from ..orchestration.policies import PolicyDef
from ..orchestration.submitter import OverloadedError, Submitter, TaskRejected
from ..orchestration.tasks import DEFAULT_CHAT_TASK, TaskDef, TaskRegistry
from ..store import definitions as definitions_store
from ..store import feedback as feedback_store
from ..store import runs
from ..store.definitions import DefinitionStore
from .auth import make_auth_dependency
from .schemas import (ApprovalRequest, AskRequest, DefinitionPutRequest,
                      FeedbackRequest, SessionFeedbackRequest,
                      TaskSubmitRequest)


def create_app(settings, lifespan=None) -> FastAPI:
    app = FastAPI(title="agent-platform", version="4.1.0", lifespan=lifespan)

    @app.exception_handler(OverloadedError)
    async def _overloaded(_req, exc):
        return JSONResponse({"detail": str(exc)}, status_code=429)

    @app.get("/health")
    async def health():
        return {"status": "ok", "env": settings.env}

    return app


def make_api_router(settings, submitter: Submitter, tasks: TaskRegistry,
                    defs: DefinitionStore, langfuse=None) -> APIRouter:
    auth = make_auth_dependency(settings.bearer_token)
    router = APIRouter(dependencies=[Depends(auth)])

    @router.post("/v1/ask")
    async def ask(req: AskRequest):
        return await submitter.run_sync(
            DEFAULT_CHAT_TASK,
            {"server": req.server, "question": req.question},
            trigger_source="sdk", session_id=req.session_id, role=req.role)

    @router.post("/v1/tasks")
    async def submit_task(req: TaskSubmitRequest):
        return await submitter.submit(req.task_type, req.input,
                                      trigger_source="sdk", caller=req.caller)

    @router.get("/v1/tasks/{run_id}")
    async def get_task(run_id: str):
        run = await runs.get(run_id)
        if run is None:
            raise HTTPException(404, "run 不存在")
        return run

    @router.post("/v1/runs/{run_id}/resume")
    async def resume_run(run_id: str):
        """续跑失败/中断的 run（Temporal 只允许顶替终态执行）。"""
        try:
            return await submitter.resume_run(run_id)
        except TaskRejected as e:
            raise HTTPException(409, str(e))

    @router.post("/v1/approvals/{run_id}")
    async def approve(run_id: str, req: ApprovalRequest):
        pending = await approvals.find_pending(run_id)
        if pending is None:
            raise HTTPException(404, "该 run 没有待审批项")
        await approvals.decide(pending["id"], req.approved, req.decided_by)
        # 任务级提交闸门：放行即启动 workflow；拒绝则 run 置失败
        await policies.settle_submit_gate(run_id, req.approved, submitter)
        return {"status": "approved" if req.approved else "rejected"}

    @router.post("/v1/feedback/{run_id}")
    async def feedback(run_id: str, req: FeedbackRequest):
        """打分反馈：回写知识/案例评分 + Langfuse score。"""
        await feedback_store.add(run_id, req.score, req.comment)
        await feedback_store.propagate_to_memory(settings.env, run_id, req.score)
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
            TaskDef.model_validate({"name": req.name, **req.definition})
        except Exception as e:
            raise HTTPException(422, f"任务定义不合法：{e}")
        await defs.put("task", settings.env, req.name,
                       req.definition, req.updated_by)
        return {"name": req.name, **(await usage_hint("task", req.name) or {})}

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

    return router
