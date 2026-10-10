"""总览页（/）：全平台状态聚合面板——近 24h run 指标、待审批、任务分布、
最近失败。引擎静态拓扑在 /graph 子页（本页入口链接）。

数据全部来自 PG 台账（runs/approvals），不经 Temporal/引擎，打开即得。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ...agent import approvals
from ...store import runs
from .base import render


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

        cards = [
            {"label": "24H RUNS", "value": total},
            {"label": "成功率", "value": rate,
             "tone": "err" if bs.get("failed") else "ok"},
            {"label": "失败", "value": bs.get("failed", 0),
             "tone": "err" if bs.get("failed") else ""},
            {"label": "运行中", "value": bs.get("running", 0) + bs.get("queued", 0),
             "tone": "warn" if bs.get("running") else ""},
            {"label": "待审批", "value": len(pending),
             "tone": "err" if pending else "", "href": "/approvals"},
        ]

        tasks = []
        for t in stats["tasks"]:
            done = t["success"] + t["failed"]
            r = round(t["success"] / done * 100) if done else None
            tasks.append({**t, "pct": r or 0,
                          "rate_text": f"{r}%" if r is not None else "—",
                          "color": "var(--ok)" if (r or 0) >= 90 else (
                              "var(--warn)" if (r or 0) >= 70 else "var(--err)")})

        return render("overview.html", "总览", active="/",
                      stats=stats, cards=cards, recent=recent,
                      pending=pending, tasks=tasks)

    return router
