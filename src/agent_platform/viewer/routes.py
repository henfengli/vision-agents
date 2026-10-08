"""Viewer 站点装配：按页面模块挂载子路由。

页面实现见 pages/ 包（一页一文件）；本文件只做组合。
钉钉只做"通知 + 链接"，交互闭环全在这里。
"""

from __future__ import annotations

from fastapi import APIRouter

from .pages import admin, approvals, base, chat, memory, runs


def make_viewer_router(submitter, defs_store, env: str, engine=None,
                       langfuse=None) -> APIRouter:
    router = APIRouter()
    router.include_router(base.make_static_router())
    router.include_router(runs.make_router(env, engine=engine, langfuse=langfuse))
    router.include_router(approvals.make_router())
    router.include_router(chat.make_router())
    router.include_router(admin.make_router(defs_store, env, langfuse=langfuse))
    router.include_router(memory.make_router(env))
    return router
