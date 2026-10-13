"""资产库页：任务资产（save_asset 沉淀的可复用产出）的可视与管理。

资产是和记忆平级的一等概念：方法（procedure）/脚本/查询/基线。
PG 管元数据（本页卡片/抽屉数据源），文件系统管内容载体（path 非空的
文件类资产，抽屉里逐个点开看内容）。手动登记只支持文本类——
文件类由 run 里 save_asset 的 files 收编产生。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from pydantic import BaseModel

from ...store import assets as assets_store
from .base import render

log = logging.getLogger(__name__)

ASSET_KINDS = ("procedure", "script", "query", "baseline")


class AssetCreateRequest(BaseModel):
    domain: str
    task: str = ""
    kind: str
    name: str
    summary: str = ""
    content: str


class AssetUpdateRequest(BaseModel):
    summary: str
    content: str


def make_router(env: str, target_envs: list[str] | None = None,
                domain_cfgs: dict | None = None) -> APIRouter:
    router = APIRouter()
    domains = list(domain_cfgs or {})

    @router.get("/assets", response_class=HTMLResponse)
    async def assets_page(request: Request, domain: str = ""):
        # 资产按目标环境分区：?env=xxx 切换查看；缺省看实例默认环境
        view_env = request.query_params.get("env") or env
        all_assets = await assets_store.list_all(view_env)
        # 侧栏域计数（生效/失效角标），与域筛选解耦
        side: dict[str, dict] = {}
        for a in all_assets:
            s = side.setdefault(a["domain"], {"active": 0, "inactive": 0})
            s["inactive" if a["expired"] else "active"] += 1
        if not domain and all_assets:
            domain = all_assets[0]["domain"]
        assets = [a for a in all_assets if not domain or a["domain"] == domain]
        for a in assets:  # 文件类补文件清单（本地目录，微秒级）
            a["files"] = (await asyncio.to_thread(
                assets_store.list_files, a["path"]) if a.get("path") else [])
        stats = await assets_store.kind_stats(view_env)
        return render("assets.html", "资产库", active="/assets",
                      assets=assets, domain=domain, side=side, stats=stats,
                      domains=domains, view_env=view_env,
                      target_envs=target_envs or [])

    @router.post("/assets")
    async def asset_create(request: Request, req: AssetCreateRequest):
        """手动登记文本类资产：运营直接补方法/基线，不必等 agent 沉淀。"""
        view_env = request.query_params.get("env") or env
        if req.kind not in ASSET_KINDS:
            raise HTTPException(422, f"kind 必须是 {'/'.join(ASSET_KINDS)}")
        if not req.domain.strip() or not req.name.strip() \
                or not req.content.strip():
            raise HTTPException(422, "域/名称/内容均不能为空")
        await assets_store.upsert(view_env, req.domain.strip(),
                                  req.task.strip(), req.kind,
                                  req.name.strip(), req.summary.strip(),
                                  req.content, source_run="manual")
        return {"status": "ok"}

    @router.get("/assets/{asset_id}/detail.json")
    async def asset_detail(asset_id: int):
        entry = await assets_store.get_entry(asset_id)
        if entry is None:
            raise HTTPException(404, "资产不存在")
        entry["files"] = (await asyncio.to_thread(
            assets_store.list_files, entry["path"])
            if entry.get("path") else [])
        return entry

    @router.get("/assets/{asset_id}/file")
    async def asset_file(asset_id: int, path: str):
        """查看文件类资产目录里的单个文件（二进制给结构化回显）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None or not entry.get("path"):
            raise HTTPException(404, "资产或文件不存在")
        try:
            text = await asyncio.to_thread(
                assets_store.read_asset_file, entry["path"], path)
        except FileNotFoundError:
            raise HTTPException(404, "文件不存在")
        return PlainTextResponse(text)

    @router.post("/assets/{asset_id}")
    async def asset_update(asset_id: int, req: AssetUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "说明/内容不能为空")
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.update(asset_id, req.summary.strip(), req.content)
        return {"status": "ok"}

    @router.post("/assets/{asset_id}/expire")
    async def asset_expire(asset_id: int):
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.mark_expired(asset_id)
        return {"status": "ok"}

    @router.post("/assets/{asset_id}/restore")
    async def asset_restore(asset_id: int):
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.restore(asset_id)
        return {"status": "ok"}

    return router
