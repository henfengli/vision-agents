"""审批页：危险操作的人工放行/拒绝。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...orchestration import policies
from .base import esc, page


def make_router(submitter=None) -> APIRouter:
    router = APIRouter()

    @router.get("/approvals/{run_id}", response_class=HTMLResponse)
    async def approval_page(run_id: str):
        pending = await approvals.find_pending(run_id)
        if pending is None:
            return page("审批", '<div class="card"><b>没有待审批项</b>'
                                '<p class="meta">可能已被处理。</p></div>')
        body = f"""
        <div class="page-head">
          <div class="eyebrow">APPROVAL</div>
          <h2>危险操作审批</h2>
          <div class="meta">run <code>{run_id}</code></div>
        </div>
        <div class="alert"><b>待执行命令</b><pre>{esc(pending['command'])}</pre></div>
        <form method="post" action="/approvals/{run_id}/decide">
          <input type="hidden" name="approval_id" value="{pending['id']}">
          <button name="decision" value="approved" class="ok">放行执行</button>
          <button name="decision" value="rejected" class="danger">拒绝</button>
        </form>"""
        return page("审批", body)

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
        return page("审批", f'<div class="card"><b>已{verb}</b>'
                            f'<p class="meta">{extra}</p></div>')

    return router
