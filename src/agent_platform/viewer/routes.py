"""Viewer 站点装配：按页面模块挂载子路由。

页面实现见 pages/ 包（一页一文件）；本文件只做组合。
钉钉只做"通知 + 链接"，交互闭环全在这里。

鉴权：给了 token 就启用 cookie 登录——/login、/logout、静态文件公开，
其余页面统一 307 跳 /login；没给 token（测试/纯内网）则全部公开。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..api.auth import make_viewer_auth_dependency
from .pages import admin, approvals, base, chat, memory, overview, runs


def make_viewer_router(submitter, defs_store, env: str, engine=None,
                       langfuse=None, token: str | None = None,
                       domains: list[str] | None = None,
                       target_envs: list[str] | None = None) -> APIRouter:
    router = APIRouter()
    router.include_router(base.make_static_router())
    # 顶栏"退出"入口仅登录开启时出现
    base.set_auth_enabled(token is not None)

    pages = APIRouter(
        dependencies=[Depends(make_viewer_auth_dependency(token))] if token else [])
    pages.include_router(overview.make_router())
    pages.include_router(runs.make_router(env, engine=engine, langfuse=langfuse,
                                          target_envs=target_envs))
    pages.include_router(approvals.make_router(submitter))
    pages.include_router(chat.make_router(domains or [], target_envs=target_envs))
    pages.include_router(admin.make_router(defs_store, env, langfuse=langfuse))
    pages.include_router(memory.make_router(env, target_envs=target_envs))
    router.include_router(pages)

    if token:
        router.include_router(base.make_login_router(token))
    return router
