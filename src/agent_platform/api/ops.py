"""运维操作面 /v1：记忆 / 资产 / 统计。

Viewer 的记忆页、资产页与外部调用方（含 AI 运维）共用这套端点——
Viewer 不再养私有 JSON 接口（auth 支持同源 cookie，页内 JS 直接调 /v1）。
记忆与资产都按目标环境分区：?env= 缺省 = 实例默认环境。
检索试用与线上召回同一条 knowledge.search（trgm+向量 RRF），
看到的就是角色实际会命中的。
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse

from ..agent import approvals
from ..store import assets as assets_store
from ..store import cases as cases_store
from ..store import feedback as feedback_store
from ..store import knowledge as knowledge_store
from ..store import runs
from .auth import make_auth_dependency
from .schemas import (AssetCreateRequest, AssetUpdateRequest,
                      KnowledgeCreateRequest, KnowledgeUpdateRequest)

ASSET_KINDS = ("procedure", "script", "query", "baseline")


def make_ops_router(settings, embedder=None, domain_cfgs=None) -> APIRouter:
    auth = make_auth_dependency(settings.bearer_token)
    router = APIRouter(dependencies=[Depends(auth)])
    # 域 → code_paths（code_ref 新鲜度校验用；git subprocess，全部 to_thread）
    code_paths = {name: list(getattr(cfg, "code_paths", []) or [])
                  for name, cfg in (domain_cfgs or {}).items()}

    # ---- 统计 ----

    @router.get("/v1/stats")
    async def stats(hours: int = 24):
        """总览聚合：近 N 小时状态计数 + 任务分布 + 最近失败 + 待审批数。"""
        hours = min(max(hours, 1), 720)
        pending = await approvals.list_pending(limit=200)
        return {**await runs.overview(hours), "pending_approvals": len(pending)}

    # ---- 记忆（知识条目） ----

    @router.get("/v1/knowledge")
    async def knowledge_list(env: str | None = None, domain: str | None = None,
                             include_inactive: bool = False,
                             include_content: bool = False):
        """条目清单（盘点用）；正文默认不扛，逐条走 GET /v1/knowledge/{id}。"""
        items = await knowledge_store.list_all(
            env or settings.env, domain or None,
            include_inactive=include_inactive)
        if not include_content:
            for it in items:
                it.pop("content", None)
        return {"items": items, "total": len(items)}

    @router.get("/v1/knowledge/search")
    async def knowledge_search(q: str = "", domain: str = "",
                               env: str | None = None):
        """检索试用：角色实际注入的 prompt 块（recall 全文）+ 命中序。"""
        from ..memory.recall import recall_block
        view_env = env or settings.env
        dom = domain or next(iter(code_paths), "")
        if not q.strip():
            raise HTTPException(422, "q 不能为空")
        if not dom:
            raise HTTPException(422, "没有可用域")
        block = await recall_block(view_env, dom, q,
                                   domain_code_paths=code_paths.get(dom, []),
                                   embedder=embedder, source="playground")
        hits = await knowledge_store.search(view_env, dom, q, limit=8,
                                            embedder=embedder)
        for h in hits:
            h["fresh"] = await asyncio.to_thread(
                knowledge_store.is_entry_fresh, h.get("code_ref"),
                code_paths.get(dom, []))
            h["domain"] = dom
        return {"domain": dom, "block": block, "hits": hits}

    @router.post("/v1/knowledge", status_code=201)
    async def knowledge_create(req: KnowledgeCreateRequest,
                               env: str | None = None):
        """写入条目：upsert 幂等（同 key 整替换），立即参与召回。"""
        if not req.domain.strip() or not req.key.strip() \
                or not req.content.strip():
            raise HTTPException(422, "域/key/内容均不能为空")
        await knowledge_store.upsert(env or settings.env, req.domain.strip(),
                                     req.key.strip(), req.content,
                                     source_run="manual", embedder=embedder)
        return {"status": "ok"}

    @router.get("/v1/knowledge/conflicts")
    async def knowledge_conflicts(env: str | None = None,
                                  domain: str | None = None):
        """疑似矛盾/重复对（向量余弦 > 0.85）：AI 仲裁的读侧——
        仲裁动作 = 对其中一条 POST /v1/knowledge/{id}/expire。
        无 pgvector 或无向量时返回空（不造数据）。"""
        pairs = await knowledge_store.similar_pairs(
            env or settings.env, domain or None)
        return {"conflicts": pairs, "total": len(pairs)}

    @router.get("/v1/knowledge/{entry_id}")
    async def knowledge_detail(entry_id: int):
        """条目明细：整行 + 新鲜度 + 演化链 + 来源 run 反馈 + 使用统计。"""
        entry = await knowledge_store.get_entry(entry_id)
        if entry is None:
            raise HTTPException(404, "条目不存在")
        fresh = await asyncio.to_thread(
            knowledge_store.is_entry_fresh, entry.get("code_ref"),
            code_paths.get(entry["domain"], []))
        chain = await knowledge_store.evolution_chain(
            entry["env"], entry["domain"], entry["key"])
        fb = (await feedback_store.for_run(entry["source_run"])
              if entry.get("source_run") else [])
        usage = await knowledge_store.usage_map(entry["env"])
        hits = await knowledge_store.recent_hits(entry_id)
        return {**entry, "fresh": fresh, "chain": chain, "feedback": fb,
                "usage": usage.get(entry_id), "recent_hits": hits}

    @router.post("/v1/knowledge/{entry_id}")
    async def knowledge_update(entry_id: int, req: KnowledgeUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.update_content(entry_id, req.content,
                                             embedder=embedder)
        return {"status": "ok"}

    @router.get("/v1/knowledge/{entry_id}/history")
    async def knowledge_history(entry_id: int):
        """内容历史（覆盖自动留档，新版本在前）。"""
        entry = await knowledge_store.get_entry(entry_id)
        if entry is None:
            raise HTTPException(404, "条目不存在")
        return {"history": await knowledge_store.list_content_history(
            entry["env"], entry["domain"], entry["key"])}

    @router.post("/v1/knowledge/{entry_id}/history/{version}/restore")
    async def knowledge_history_restore(entry_id: int, version: int):
        """回滚内容到历史版本（当前内容先留档，回滚可逆）。"""
        entry = await knowledge_store.get_entry(entry_id)
        if entry is None:
            raise HTTPException(404, "条目不存在")
        try:
            await knowledge_store.restore_content(
                entry["env"], entry["domain"], entry["key"], version,
                embedder=embedder)
        except KeyError as e:
            raise HTTPException(404, e.args[0])
        return {"ok": True, "restored": version}

    @router.post("/v1/knowledge/{entry_id}/expire")
    async def knowledge_expire(entry_id: int):
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.mark_expired(entry_id)
        return {"status": "ok"}

    @router.post("/v1/knowledge/{entry_id}/restore")
    async def knowledge_restore(entry_id: int):
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.restore(entry_id)
        return {"status": "ok"}

    # ---- 案例库（失败 run 归因沉淀；只读——写入只有 distill 一条路径） ----

    @router.get("/v1/cases")
    async def cases_list(env: str | None = None, domain: str | None = None,
                         limit: int = 200):
        """案例清单（含失效，superseded/superseded_by 标状态）。"""
        items = await cases_store.list_all(env or settings.env,
                                           domain or None,
                                           limit=min(limit, 500))
        return {"cases": items, "total": len(items)}

    # ---- 资产 ----

    @router.get("/v1/assets")
    async def assets_list(env: str | None = None, domain: str | None = None,
                          q: str | None = None, kind: str | None = None,
                          state: str | None = None, offset: int = 0,
                          limit: int = 50):
        """资产列表：域/关键词/类型/生效状态过滤 + offset 分页。"""
        active = {"on": True, "off": False}.get(state or "")
        rows, total, _ = await assets_store.list_filtered(
            env or settings.env, domain=domain or None, q=q or None,
            kind=kind or None, active=active, offset=offset,
            limit=min(limit, 200))
        return {"assets": rows, "total": total}

    @router.post("/v1/assets", status_code=201)
    async def asset_create(req: AssetCreateRequest, env: str | None = None):
        """登记文本类资产：upsert 幂等（同 env+domain+task+kind+name 整替换）。"""
        if req.kind not in ASSET_KINDS:
            raise HTTPException(422, f"kind 必须是 {'/'.join(ASSET_KINDS)}")
        if not req.domain.strip() or not req.name.strip() \
                or not req.content.strip():
            raise HTTPException(422, "域/名称/内容均不能为空")
        await assets_store.upsert(env or settings.env, req.domain.strip(),
                                  req.task.strip(), req.kind,
                                  req.name.strip(), req.summary.strip(),
                                  req.content, source_run="manual")
        return {"status": "ok"}

    @router.get("/v1/assets/{asset_id}")
    async def asset_detail(asset_id: int):
        """资产明细：整行 + 文件清单（文件类）+ 历史版本留档（整替换的旧版）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None:
            raise HTTPException(404, "资产不存在")
        entry["files"] = (await asyncio.to_thread(
            assets_store.list_files, entry["path"])
            if entry.get("path") else [])
        entry["revisions"] = await asyncio.to_thread(
            assets_store.list_revisions, entry.get("path"))
        return entry

    @router.post("/v1/assets/{asset_id}/rollback/{ts}")
    async def asset_rollback(asset_id: int, ts: str):
        """文件类资产回滚到指定留档版本（当前版自动留档，回滚可逆）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None or not entry.get("path"):
            raise HTTPException(404, "资产不存在或无文件载体")
        try:
            await asyncio.to_thread(assets_store.restore_revision,
                                    entry["path"], ts)
        except FileNotFoundError:
            raise HTTPException(404, f"留档版本不存在：{ts}")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True, "restored": ts,
                "revisions": await asyncio.to_thread(
                    assets_store.list_revisions, entry["path"])}

    @router.get("/v1/assets/{asset_id}/history")
    async def asset_content_history(asset_id: int):
        """内容历史（summary/content 覆盖自动留档，新版本在前）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None:
            raise HTTPException(404, "资产不存在")
        return {"history": await assets_store.list_content_history(
            entry["env"], entry["domain"], entry["task"], entry["kind"],
            entry["name"])}

    @router.post("/v1/assets/{asset_id}/history/{version}/restore")
    async def asset_content_restore(asset_id: int, version: int):
        """回滚文本内容到历史版本（当前内容先留档，回滚可逆；
        文件载体不动——文件版本走 /rollback/{ts}）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None:
            raise HTTPException(404, "资产不存在")
        try:
            await assets_store.restore_content(
                entry["env"], entry["domain"], entry["task"], entry["kind"],
                entry["name"], version)
        except KeyError as e:
            raise HTTPException(404, e.args[0])
        return {"ok": True, "restored": version}

    @router.get("/v1/assets/{asset_id}/file")
    async def asset_file(asset_id: int, path: str):
        """读文件类资产目录里的单个文件（限 100KB 文本回显）。"""
        entry = await assets_store.get_entry(asset_id)
        if entry is None or not entry.get("path"):
            raise HTTPException(404, "资产或文件不存在")
        try:
            text = await asyncio.to_thread(
                assets_store.read_asset_file, entry["path"], path)
        except FileNotFoundError:
            raise HTTPException(404, "文件不存在")
        return PlainTextResponse(text)

    @router.post("/v1/assets/{asset_id}")
    async def asset_update(asset_id: int, req: AssetUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "说明/内容不能为空")
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.update(asset_id, req.summary.strip(), req.content)
        return {"status": "ok"}

    @router.post("/v1/assets/{asset_id}/expire")
    async def asset_expire(asset_id: int):
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.mark_expired(asset_id)
        return {"status": "ok"}

    @router.post("/v1/assets/{asset_id}/restore")
    async def asset_restore(asset_id: int):
        if await assets_store.get_entry(asset_id) is None:
            raise HTTPException(404, "资产不存在")
        await assets_store.restore(asset_id)
        return {"status": "ok"}

    return router
