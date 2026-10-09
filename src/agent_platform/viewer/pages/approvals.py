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
from .base import esc, page


def _head(eyebrow: str, title: str, meta: str = "") -> str:
    return f"""<div class="page-head">
  <div class="eyebrow">{eyebrow}</div><h2>{title}</h2>
  {f'<div class="meta">{meta}</div>' if meta else ''}
</div>"""


def make_router(submitter=None) -> APIRouter:
    router = APIRouter()

    @router.get("/approvals", response_class=HTMLResponse)
    async def inbox():
        rows = await approvals.list_pending()
        trs = []
        for r in rows:
            cmd = esc(r["command"])
            if len(cmd) > 160:
                cmd = cmd[:160] + "…"
            trs.append(
                "<tr>"
                f"<td><code>#{r['id']}</code></td>"
                f'<td><a class="run-link" href="/approvals/{r["run_id"]}">'
                f'{r["run_id"][:8]}</a></td>'
                f"<td><pre>{cmd}</pre></td>"
                f"<td>{esc(r['task_type']) or '—'}</td>"
                f"<td>{esc(r['trigger_source']) or '—'}</td>"
                f"<td>{esc(r['created_at'][:19])}</td>"
                "</tr>")
        if rows:
            listing = ('<table class="grid"><thead><tr>'
                       "<th>编号</th><th>RUN</th><th>待执行命令</th>"
                       "<th>任务</th><th>来源</th><th>发起时间</th>"
                       "</tr></thead><tbody>" + "".join(trs) + "</tbody></table>")
        else:
            listing = """<div class="card">
  <h3 style="border:none;padding:0;margin-bottom:8px">没有待审批项</h3>
  <div class="meta">钉钉卡片的「去审批」会直达处理页；本列表是兜底入口。</div>
</div>"""
        body = (_head("INBOX", "审批待办",
                      f"待办 {len(rows)} 条 · 点 RUN 进入处理页")
                + listing)
        return page("审批待办", body, active="/approvals")

    @router.get("/approvals/pending.json")
    async def pending_json():
        return {"count": await approvals.pending_count()}

    @router.get("/approvals/{run_id}", response_class=HTMLResponse)
    async def approval_page(run_id: str):
        pending = await approvals.find_pending(run_id)
        if pending is None:
            return page("审批", '<div class="card"><b>没有待审批项</b>'
                                '<p class="meta">可能已被处理。</p>'
                                '<p><a class="btn sm" href="/approvals">'
                                '← 待办列表</a></p></div>',
                        active="/approvals")
        body = (_head("APPROVAL", "危险操作审批",
                      f"run <code>{run_id}</code> · 发起 {esc(pending['created_at'][:19])}")
                + f"""<p style="margin-bottom:14px">
  <a class="btn sm" href="/approvals">← 待办列表</a></p>
<div class="alert"><b>待执行命令</b><pre>{esc(pending['command'])}</pre></div>
<form method="post" action="/approvals/{run_id}/decide" class="card">
  <input type="hidden" name="approval_id" value="{pending['id']}">
  <div class="meta">批准后任务继续执行；拒绝则终止。操作以 viewer 身份落账。</div>
  <div class="actions">
    <button name="decision" value="approved" class="ok">放行执行</button>
    <button name="decision" value="rejected" class="danger">拒绝</button>
  </div>
</form>""")
        return page("审批", body, active="/approvals")

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
        body = (_head("APPROVAL", f"已{verb}",
                      f"run <code>{run_id}</code>")
                + f"""<div class="card">
  <b>已{verb}</b><p class="meta">{extra}</p>
  <div class="actions">
    <a class="btn sm" href="/approvals">← 待办列表</a>
    <a class="btn sm" href="/runs/{run_id}">查看执行轨迹</a>
  </div>
</div>""")
        return page("审批", body, active="/approvals")

    return router
