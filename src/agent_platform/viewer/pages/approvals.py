"""审批页：危险操作的人工放行/拒绝。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from .base import esc, page


def make_router() -> APIRouter:
    router = APIRouter()

    @router.get("/approvals/{run_id}", response_class=HTMLResponse)
    async def approval_page(run_id: str):
        from ...runtime import approvals
        pending = await approvals.find_pending(run_id)
        if pending is None:
            return page("审批", "<p>没有待审批项（可能已被处理）。</p>")
        body = f"""
        <h2>危险操作审批</h2>
        <div class="card"><div class="meta">run {run_id}</div>
          <b>待执行命令：</b><pre>{esc(pending['command'])}</pre></div>
        <form method="post" action="/approvals/{run_id}/decide">
          <input type="hidden" name="approval_id" value="{pending['id']}">
          <button name="decision" value="approved">放行执行</button>
          <button name="decision" value="rejected">拒绝</button>
        </form>"""
        return page("审批", body)

    @router.post("/approvals/{run_id}/decide")
    async def approval_decide(run_id: str, request: Request):
        from ...runtime import approvals
        form = await request.form()
        await approvals.decide(int(form["approval_id"]),
                               form["decision"] == "approved",
                               decided_by="viewer")
        verb = "放行" if form["decision"] == "approved" else "拒绝"
        return page("审批", f"<p>已{verb}。</p>")

    return router
