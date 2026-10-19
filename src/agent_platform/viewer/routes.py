"""Viewer 站点装配：按页面模块挂载子路由。

页面实现见 pages/ 包（一页一文件）；本文件只做组合。
钉钉只做"通知 + 链接"，交互闭环全在这里。

鉴权：给了 token 就启用 cookie 登录——/login、/logout、静态文件公开，
其余页面统一 307 跳 /login；没给 token（测试/纯内网）则全部公开。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..api.auth import make_viewer_auth_dependency
from .pages import (admin, approvals, assets, base, chat, memory, overview,
                    runs, services)


def make_viewer_router(submitter, defs_store, env: str,
                       langfuse=None, token: str | None = None,
                       domains: list[str] | None = None,
                       target_envs: list[str] | None = None,
                       tool_names: list[str] | None = None,
                       domain_cfgs: dict | None = None,
                       domain_provider=None, env_gate=None) -> APIRouter:
    router = APIRouter()
    router.include_router(base.make_static_router())
    # 顶栏"退出"入口仅登录开启时出现
    base.set_auth_enabled(token is not None)

    pages = APIRouter(
        dependencies=[Depends(make_viewer_auth_dependency(token))] if token else [])
    pages.include_router(overview.make_router())
    pages.include_router(runs.make_router(env, langfuse=langfuse,
                                          target_envs=target_envs,
                                          submitter=submitter,
                                          defs_store=defs_store,
                                          domains=domains))
    pages.include_router(approvals.make_router(submitter))
    pages.include_router(chat.make_router(domains or [], target_envs=target_envs,
                                          defs_store=defs_store, env=env))
    pages.include_router(services.make_router(
        env, defs_store, domain_provider or _FileBackedDomains(domain_cfgs),
        env_gate=env_gate, target_envs=target_envs))
    pages.include_router(admin.make_router(defs_store, env, langfuse=langfuse,
                                           tool_names=tool_names,
                                           domains=domains,
                                           target_envs=target_envs))
    pages.include_router(memory.make_router(env, target_envs=target_envs,
                                            domain_cfgs=domain_cfgs))
    pages.include_router(assets.make_router(env, target_envs=target_envs,
                                            domain_cfgs=domain_cfgs))
    router.include_router(pages)

    if token:
        router.include_router(base.make_login_router(token))
    return router


class _FileBackedDomains:
    """domain_provider 缺省（测试/纯文件场景）时的兜底适配：只读文件配置。"""

    def __init__(self, cfgs: dict | None):
        self._cfgs = cfgs or {}

    def all(self):
        return self._cfgs

    def get(self, name):
        return self._cfgs.get(name)

    def names(self, enabled_only: bool = False):
        return sorted(n for n, c in self._cfgs.items()
                      if getattr(c, "enabled", True) or not enabled_only)

    def enabled(self, name) -> bool:
        cfg = self._cfgs.get(name)
        return getattr(cfg, "enabled", True) if cfg is not None else True

    async def refresh(self):
        return self._cfgs
