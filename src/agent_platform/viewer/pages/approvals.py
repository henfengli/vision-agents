"""审批页：危险操作的人工放行/拒绝，外加待办收件箱。

入口有两条：钉钉 actionCard 的「去审批」deep-link 直达 /approvals/{run_id}；
Viewer 顶栏「审批」进 /approvals 收件箱列表（兜底，脱离钉钉也能找到待办）。
/approvals/pending.json 给顶栏角标供数，必须先于 /{run_id} 注册，
否则 "pending.json" 会被路由变量吞掉。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...orchestration import policies
from .base import render


def make_router(submitter=None) -> APIRouter:
    router = APIRouter()

    @router.get("/approvals", response_class=HTMLResponse)
    async def inbox():
        rows = await approvals.list_pending()
        return render("approvals.html", "审批待办", active="/approvals",
                      rows=rows)

    @router.get("/approvals/pending.json")
    async def pending_json():
        return {"count": await approvals.pending_count()}

    @router.get("/approvals/{run_id}", response_class=HTMLResponse)
    async def approval_page(run_id: str):
        pending = await approvals.find_pending(run_id)
        if pending is None:
            return render("msg.html", "审批", active="/approvals",
                          heading="没有待审批项", message="可能已被处理。",
                          back_href="/approvals")
        return render("approval_detail.html", "审批", active="/approvals",
                      run_id=run_id, pending=pending)

    @router.post("/approvals/{run_id}/decide")
    async def approval_decide(run_id: str, request: Request):
        form = await request.form()
        approved = form["decision"] == "approved"
        await approvals.decide(int(form["approval_id"]), approved,
                               decided_by="viewer")
        verb = "放行" if approved else "拒绝"
        extra = ""
        if submitter is not None:
            # 任务级提交闸门：放行即启动 workflow；拒绝则 run 置失败
            if await policies.settle_submit_gate(run_id, approved, submitter):
                extra = "任务已开始执行。" if approved else "任务已终止。"
        return render("approval_done.html", "审批", active="/approvals",
                      run_id=run_id, heading=f"已{verb}", extra=extra)

    return router
