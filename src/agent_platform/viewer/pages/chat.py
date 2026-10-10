"""Web 对话页：SSE 流式。"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from .base import render


def make_router(domains: list[str] | None = None,
                target_envs: list[str] | None = None) -> APIRouter:
    """domains/target_envs 来自配置，业务域与目标环境不在页面里硬编码。

    单部署多目标环境：配置了 target_envs 时给出环境选择器（留空 = 默认环境），
    选择随请求体 env 字段上送；未配置则页面不出现选择器（单环境部署无感知）。
    """
    router = APIRouter()

    @router.get("/chat", response_class=HTMLResponse)
    async def chat_page():
        return render("chat.html", "对话", active="/chat",
                      domains=domains or [], target_envs=target_envs or [])

    return router
