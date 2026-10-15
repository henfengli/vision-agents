"""记忆管理页：知识的「写入-召回-演化」三段生命周期可视。

布局参照管理页：左栏域分组（带生效/失效角标），主区检索试用 + 条目卡，
点开进右侧抽屉（完整内容编辑 / 来源 run / code_ref 新鲜度 / 反馈留痕 /
superseded_by 演化链）。案例库与疑似矛盾对是同页的另两个 tab。
（任务资产是独立概念，在顶级「资产」页。）

本页只剩 HTML 渲染；所有数据/写操作走 /v1/knowledge/*（页内 JS 同源
cookie 直接调，与外部调用方共用一套 API）。
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from ...store import cases as cases_store
from ...store import knowledge as knowledge_store
from .base import render

log = logging.getLogger(__name__)


def make_router(env: str, target_envs: list[str] | None = None,
                domain_cfgs: dict | None = None) -> APIRouter:
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
                          include_inactive: bool = True,
                          filter: str = ""):
        # 记忆按目标环境分区：?env=xxx 切换查看；缺省看实例默认环境
        view_env = request.query_params.get("env") or env
        stats = await knowledge_store.domain_stats(view_env)
        if not domain and stats:
            domain = next(iter(stats))  # 缺省落第一个有数据的域
        items = await knowledge_store.list_all(
            view_env, domain or None, include_inactive=include_inactive)
        usage = await knowledge_store.usage_map(view_env)
        fresh = await _fresh_flags(items)
        active = lambda it: not it["expired"] and not it["superseded"]
        for it in items:
            it["fresh"] = fresh[it["id"]]
            u = usage.get(it["id"])
            it["usage"] = u  # None = 近 30 天零召回
            it.pop("content", None)  # 内容走抽屉按需加载，列表页不扛全文
        # 健康度汇总（当前域视角）：一眼判断这个域要不要管
        health = {
            "active": sum(1 for i in items if active(i)),
            "zero_recall": sum(1 for i in items
                               if active(i) and i["usage"] is None),
            "negative": sum(1 for i in items
                            if active(i) and (i["feedback_score"] or 0) < 0),
            "drift": sum(1 for i in items if active(i) and not i["fresh"]),
        }
        if filter == "zero_recall":
            items = [i for i in items if active(i) and i["usage"] is None]
        cases = await cases_store.list_all(view_env, domain or None)
        conflicts = await knowledge_store.similar_pairs(view_env, domain or None)
        health["conflicts"] = len(conflicts)
        return render("memory.html", "记忆管理", active="/memory",
                      items=items, domain=domain, stats=stats,
                      include_inactive=include_inactive, filter=filter,
                      health=health, usage_days=30,
                      cases=cases, conflicts=conflicts,
                      domains=list(stats) or list(code_paths),
                      view_env=view_env, target_envs=target_envs or [],
                      items_json=json.dumps(items, ensure_ascii=False)
                      .replace("</", "<\\/"))

    return router
