"""Web 对话页：SSE 流式 + 会话管理（列表/历史回放）。

会话数据全来自 PG 台账：session_id 即会话，web_chat 触发的 run 是正序消息。
/chat/sessions.json 与 /chat/sessions/{id}/history.json 是页面内 JSON 端点
（cookie 鉴权随 viewer 页面链路），不进 /v1 API。
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from ...store import runs
from .base import render
from .runs import _event_summary


def make_router(domains: list[str] | None = None,
                target_envs: list[str] | None = None,
                defs_store=None, env: str = "") -> APIRouter:
    """domains/target_envs/角色来自配置与定义库，不在页面里硬编码。

    单部署多目标环境：配置了 target_envs 时给出环境选择器（留空 = 默认环境），
    选择随请求体 env 字段上送；未配置则页面不出现选择器（单环境部署无感知）。
    """
    router = APIRouter()

    @router.get("/chat", response_class=HTMLResponse)
    async def chat_page():
        roles = ([r["name"] for r in await defs_store.list_active("role", env)]
                 if defs_store is not None else [])
        return render("chat.html", "对话", active="/chat",
                      domains=domains or [], roles=roles,
                      target_envs=target_envs or [])

    @router.get("/chat/sessions.json")
    async def sessions_json():
        return {"sessions": await runs.list_sessions()}

    @router.get("/chat/sessions/{session_id}/history.json")
    async def history_json(session_id: str):
        items = await runs.of_session(session_id)
        # 事件批量取（ANY 一次查询），逐 run 取是 N+1
        by_run = await runs.events_of_runs([r["run_id"] for r in items])
        out = []
        for r in items:
            out.append({
                "run_id": r["run_id"], "status": r["status"],
                "question": (r["input"] or {}).get("question", ""),
                "output": r["output"], "created_at": r["created_at"],
                "events": [_event_summary(e)
                           for e in by_run.get(r["run_id"], [])
                           if e["kind"] != "graph"],
            })
        # 最新 run 的配置回填选择器（续聊自动继承域/角色/环境）
        latest = items[-1] if items else {}
        return {"session_id": session_id, "runs": out,
                "config": {"server": latest.get("domain") or "",
                           "role": latest.get("role") or "",
                           "env": latest.get("target_env") or ""}}

    return router
