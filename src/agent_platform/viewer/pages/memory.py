"""记忆管理页：知识的「写入-召回-演化」三段生命周期可视。

布局参照管理页：左栏域分组（带生效/失效角标），主区检索试用 + 条目卡，
点开进右侧抽屉（完整内容编辑 / 来源 run / code_ref 新鲜度 / 反馈留痕 /
superseded_by 演化链）。案例库与疑似矛盾对是同页的另两个 tab。
检索试用直接调线上 recall 同款 knowledge.search（trgm+向量 RRF），
看到的就是角色实际会命中的。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ...store import cases as cases_store
from ...store import feedback as feedback_store
from ...store import knowledge as knowledge_store
from .base import render

log = logging.getLogger(__name__)


class MemoryUpdateRequest(BaseModel):
    content: str


def make_router(env: str, target_envs: list[str] | None = None,
                domain_cfgs: dict | None = None, embedder=None) -> APIRouter:
    router = APIRouter()
    # 域 → code_paths（code_ref 新鲜度校验用；git subprocess，全部 to_thread）
    code_paths = {name: list(getattr(cfg, "code_paths", []) or [])
                  for name, cfg in (domain_cfgs or {}).items()}

    async def _fresh_flags(items: list[dict]) -> dict[int, bool]:
        async def one(it):
            fresh = await asyncio.to_thread(
                knowledge_store.is_entry_fresh, it.get("code_ref"),
                code_paths.get(it["domain"], []))
            return it["id"], fresh
        return dict(await asyncio.gather(*(one(i) for i in items)))

    @router.get("/memory", response_class=HTMLResponse)
    async def memory_page(request: Request, domain: str = "",
                          include_inactive: bool = True):
        # 记忆按目标环境分区：?env=xxx 切换查看；缺省看实例默认环境
        view_env = request.query_params.get("env") or env
        stats = await knowledge_store.domain_stats(view_env)
        if not domain and stats:
            domain = next(iter(stats))  # 缺省落第一个有数据的域
        items = await knowledge_store.list_all(
            view_env, domain or None, include_inactive=include_inactive)
        fresh = await _fresh_flags(items)
        for it in items:
            it["fresh"] = fresh[it["id"]]
            it.pop("content", None)  # 内容走抽屉按需加载，列表页不扛全文
        cases = await cases_store.list_all(view_env, domain or None)
        conflicts = await knowledge_store.similar_pairs(view_env, domain or None)
        return render("memory.html", "记忆管理", active="/memory",
                      items=items, domain=domain, stats=stats,
                      include_inactive=include_inactive,
                      cases=cases, conflicts=conflicts,
                      domains=list(stats) or list(code_paths),
                      view_env=view_env, target_envs=target_envs or [],
                      items_json=json.dumps(items, ensure_ascii=False)
                      .replace("</", "<\\/"))

    @router.get("/memory/search.json")
    async def memory_search(request: Request, q: str = "", domain: str = ""):
        """检索试用：返回角色实际注入的 prompt 块（recall_block 同款，
        含资产档案/知识/案例分层与 freshness 过滤）+ 历史知识命中序。"""
        from ...memory.recall import recall_block
        view_env = request.query_params.get("env") or env
        dom = domain or next(iter(code_paths), "")
        if not q.strip():
            raise HTTPException(422, "请输入检索问题")
        if not dom:
            raise HTTPException(422, "没有可用域")
        block = await recall_block(view_env, dom, q,
                                   domain_code_paths=code_paths.get(dom, []),
                                   embedder=embedder)
        # recall_block 已把漂移条目标过期并过滤，这里重新查命中序
        # （过滤后的），保证列表与 prompt 块一致
        hits = await knowledge_store.search(view_env, dom, q, limit=8,
                                            embedder=embedder)
        fresh = await _fresh_flags(
            [{"id": h["id"], "domain": dom, "code_ref": h.get("code_ref")}
             for h in hits])
        for h in hits:
            h["fresh"] = fresh[h["id"]]
            h["domain"] = dom
        return {"domain": dom, "block": block, "hits": hits}

    @router.get("/memory/{entry_id}/detail.json")
    async def memory_detail(entry_id: int):
        """抽屉明细：整行 + 来源 run 的反馈留痕 + 演化链 + 新鲜度。"""
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
        return {**entry, "fresh": fresh, "chain": chain, "feedback": fb}

    @router.post("/memory/{entry_id}")
    async def memory_update(entry_id: int, req: MemoryUpdateRequest):
        if not req.content.strip():
            raise HTTPException(422, "内容不能为空")
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.update_content(entry_id, req.content,
                                             embedder=embedder)
        return {"status": "ok"}

    @router.post("/memory/{entry_id}/expire")
    async def memory_expire(entry_id: int):
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.mark_expired(entry_id)
        return {"status": "ok"}

    @router.post("/memory/{entry_id}/restore")
    async def memory_restore(entry_id: int):
        if await knowledge_store.get_entry(entry_id) is None:
            raise HTTPException(404, "条目不存在")
        await knowledge_store.restore(entry_id)
        return {"status": "ok"}

    return router
