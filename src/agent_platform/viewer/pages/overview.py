"""总览页（/）：全平台状态聚合面板——近 24h run 指标、待审批、任务分布、
最近失败。引擎静态拓扑在 /graph 子页（本页入口链接）。

数据全部来自 PG 台账（runs/approvals），不经 Temporal/引擎，打开即得。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...store import runs
from .base import esc, page, status_pill


def _stat(label: str, value, tone: str = "", href: str = "") -> str:
    inner = (f'<div class="stat-num {tone}">{value}</div>'
             f'<div class="stat-label">{label}</div>')
    return (f'<a class="stat-card" href="{href}">{inner}</a>' if href
            else f'<div class="stat-card">{inner}</div>')


def _recent_rows(rows: list[dict]) -> str:
    return "".join(
        f'<tr><td><a class="run-link" href="/runs/{r["run_id"]}">'
        f'{r["run_id"][:8]}</a></td>'
        f"<td>{esc(r['task_type'])}</td>"
        f"<td>{status_pill(r['status'])}</td>"
        f"<td>{esc(r['target_env'] or '-')}</td>"
        f'<td class="meta">{r["created_at"][5:19].replace("T", " ")}</td></tr>'
        for r in rows)


def _task_rows(tasks: list[dict]) -> str:
    out = []
    for t in tasks:
        done = t["success"] + t["failed"]
        rate = round(t["success"] / done * 100) if done else None
        pct = rate if rate is not None else 0
        color = "var(--ok)" if (rate or 0) >= 90 else (
            "var(--warn)" if (rate or 0) >= 70 else "var(--err)")
        out.append(
            f"<tr><td>{esc(t['task_type'])}</td><td>{t['total']}</td>"
            f"<td>{t['failed'] or '—'}</td>"
            f'<td><div class="bar-track"><div class="bar-fill" '
            f'style="width:{pct}%;background:{color}"></div></div></td>'
            f"<td>{f'{rate}%' if rate is not None else '—'}</td></tr>")
    return "".join(out)


def make_router() -> APIRouter:
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse)
    async def overview():
        stats = await runs.overview(24)
        recent = await runs.list_recent(limit=8)
        pending = await approvals.list_pending(limit=5)
        bs = stats["by_status"]
        total = sum(bs.values())
        finished = bs.get("success", 0) + bs.get("failed", 0)
        rate = (f"{round(bs.get('success', 0) / finished * 100)}%"
                if finished else "—")

        stat_row = '<div class="stat-grid">' + "".join([
            _stat("24H RUNS", total),
            _stat("成功率", rate,
                  "err" if bs.get("failed") else "ok"),
            _stat("失败", bs.get("failed", 0),
                  "err" if bs.get("failed") else ""),
            _stat("运行中", bs.get("running", 0) + bs.get("queued", 0),
                  "warn" if bs.get("running") else ""),
            _stat("待审批", len(pending), "err" if pending else "",
                  "/approvals"),
        ]) + "</div>"

        pending_html = ("".join(
            f'<div class="pend-row"><a class="run-link" '
            f'href="/approvals/{p["run_id"]}">{p["run_id"][:8]}</a>'
            f"<pre>{esc(p['command'][:80])}</pre>"
            f'<span class="meta">{esc(p["task_type"]) or "—"} · '
            f'{p["created_at"][5:19].replace("T", " ")}</span></div>'
            for p in pending)
            if pending else
            '<div class="meta" style="padding:14px 0">没有待办审批 ✓</div>')

        failed_html = ("".join(
            f'<div class="pend-row"><a class="run-link" '
            f'href="/runs/{f["run_id"]}">{f["run_id"][:8]}</a>'
            f'<span>{esc(f["task_type"])}'
            f'<span class="meta"> · {esc(f["role"])}'
            f' · {esc(f["target_env"] or "-")}</span></span>'
            f'<span class="meta">{f["created_at"][5:19].replace("T", " ")}'
            "</span></div>" for f in stats["failed"])
            if stats["failed"] else
            '<div class="meta" style="padding:14px 0">近期无失败 ✓</div>')

        body = f"""
<div class="page-head">
  <div class="eyebrow">OVERVIEW</div>
  <h2>总览</h2>
  <div class="meta">近 {stats['hours']}h 平台运行状况 · 数据来自执行台账</div>
</div>
{stat_row}
<div class="dash-grid">
  <div class="card"><h3>最近 Runs <a class="more" href="/runs">全部 →</a></h3>
    <table class="grid"><tbody>{_recent_rows(recent) or
        '<tr><td class="meta">暂无</td></tr>'}</tbody></table></div>
  <div class="card"><h3>待审批 <a class="more" href="/approvals">收件箱 →</a></h3>
    {pending_html}
    <h3 style="margin-top:18px">最近失败</h3>{failed_html}</div>
</div>
<div class="dash-grid">
  <div class="card"><h3>任务分布（24h）</h3>
    <table class="grid"><thead><tr><th>任务</th><th>次数</th><th>失败</th>
      <th style="width:40%">成功率</th><th></th></tr></thead>
      <tbody>{_task_rows(stats['tasks']) or
          '<tr><td colspan="5" class="meta">暂无</td></tr>'}</tbody></table></div>
  <div class="card"><h3>引擎</h3>
    <div class="meta" style="margin-bottom:10px">
      Agent 静态拓扑（LangGraph 骨架），装配变更后的结构回归看这里。</div>
    <a class="btn" href="/graph">引擎拓扑 →</a></div>
</div>"""
        return page("总览", body, active="/")

    return router
