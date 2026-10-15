"""资产库页：任务资产（save_asset 沉淀的可复用产出）的可视与管理。

资产是和记忆平级的一等概念：方法（procedure）/脚本/查询/基线。
PG 管元数据（本页卡片/抽屉数据源），文件系统管内容载体（path 非空的
文件类资产，抽屉里逐个点开看内容）。手动登记只支持文本类——
文件类由 run 里 save_asset 的 files 收编产生。

本页只剩 HTML 渲染；所有数据/写操作走 /v1/assets/*（页内 JS 同源
cookie 直接调，与外部调用方共用一套 API）。
"""

from __future__ import annotations

import asyncio
import logging
from functools import partial

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from ...store import assets as assets_store
from .base import page_url, qint, render

log = logging.getLogger(__name__)

_PAGE = 50
_KIND_CHIPS = [("", "全部类型"), ("procedure", "方法"), ("script", "脚本"),
               ("query", "查询"), ("baseline", "基线")]
_STATE_CHIPS = [("", "全部状态"), ("on", "生效中"), ("off", "已过期")]


def make_router(env: str, target_envs: list[str] | None = None,
                domain_cfgs: dict | None = None) -> APIRouter:
    router = APIRouter()
    domains = list(domain_cfgs or {})

    @router.get("/assets", response_class=HTMLResponse)
    async def assets_page(request: Request, domain: str = ""):
        # 资产按目标环境分区：?env=xxx 切换查看；缺省看实例默认环境
        view_env = request.query_params.get("env") or env
        p = request.query_params
        q = p.get("q") or ""
        kind = p.get("kind") or ""
        active = {"on": True, "off": False}.get(p.get("state") or "")
        page = max(1, qint(p.get("p"), 1, "p"))
        # 侧栏域计数与列表过滤解耦：侧栏永远显示全域分布
        side = await assets_store.domain_counts(view_env)
        if not domain and side:
            domain = next(iter(side))
        assets, total, offset = await assets_store.list_filtered(
            view_env, domain=domain or None, q=q or None, kind=kind or None,
            active=active, offset=(page - 1) * _PAGE, limit=_PAGE)
        for a in assets:  # 文件类补文件清单（本地目录，微秒级）
            a["files"] = (await asyncio.to_thread(
                assets_store.list_files, a["path"]) if a.get("path") else [])
        stats = await assets_store.kind_stats(view_env)
        u = partial(page_url, request)
        pager = None
        if total:
            pager = {"total": total, "count": len(assets),
                     "prev_url": u(p=page - 1) if page > 1 else None,
                     "next_url": (u(p=page + 1)
                                  if offset + _PAGE < total else None)}
        return render("assets.html", "资产库", active="/assets",
                      assets=assets, domain=domain, side=side, stats=stats,
                      domains=domains, view_env=view_env, pager=pager, u=u,
                      f_q=q, f_kind=kind, f_state=p.get("state") or "",
                      kind_chips=_KIND_CHIPS, state_chips=_STATE_CHIPS,
                      target_envs=target_envs or [])

    return router
