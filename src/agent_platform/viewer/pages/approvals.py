"""审批页：危险操作的人工放行/拒绝，待办收件箱 + 已处理历史（审计）。

入口有两条：钉钉 actionCard 的「去审批」deep-link 直达 /approvals/{run_id}；
Viewer 顶栏「审批」进 /approvals 收件箱列表（兜底，脱离钉钉也能找到待办）。
/approvals/pending.json 给顶栏角标供数，必须先于 /{run_id} 注册，
否则 "pending.json" 会被路由变量吞掉。

待办按发起时间升序（SLA：等待最久排最前）；已处理按决定时间倒序 +
结果过滤 + offset 分页——「上周谁批了那条 rm -rf」必须答得上来。
"""

from __future__ import annotations

from functools import partial

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...orchestration import policies
from .base import page_url, render

_PAGE = 30
_RESULT_CHIPS = [("", "全部"), ("approved", "已放行"), ("rejected", "已拒绝")]


def make_router(submitter=None) -> APIRouter:
    router = APIRouter()

    @router.get("/approvals", response_class=HTMLResponse)
    async def inbox(request: Request):
        tab = request.query_params.get("tab") or "pending"
        u = partial(page_url, request)
        pending = await approvals.list_pending()
        done, total, pager = [], 0, None
        status = ""
        if tab == "done":
            status = request.query_params.get("status") or ""
            page = max(1, int(request.query_params.get("p") or 1))
            done, total = await approvals.list_decided(
                status=status or None, offset=(page - 1) * _PAGE, limit=_PAGE)
            if total:
                pager = {"total": total, "count": len(done),
                         "prev_url": u(p=page - 1) if page > 1 else None,
                         "next_url": (u(p=page + 1)
                                      if page * _PAGE < total else None)}
        return render("approvals.html", "审批", active="/approvals",
                      tab=tab, rows=pending, done=done, pager=pager, u=u,
                      f_status=status, result_chips=_RESULT_CHIPS)

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
