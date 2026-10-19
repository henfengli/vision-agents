"""服务页：业务域（dagster/board/config-center…）的顶层模块视图。

/services          全部服务一览：规则/任务/知识/资产/24h run 计数卡片
/services/{name}   单服务聚合页——规则库（可编辑，热生效）、任务（子任务
                   嵌套）、知识、资产、近期 run，全部按该域过滤。
                   规则库读写走 /v1/admin/rules 既有 API（保存即新版本，
                   5s 缓存热生效）；知识与资产明细仍由记忆/资产页承载，
                   这里只做聚合与跳转。
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse

from ...store import assets as assets_store
from ...store import definitions as definitions_store
from ...store import knowledge as knowledge_store
from ...store import runs as runs_store
from .base import render

_K_LIMIT = 20     # 聚合页知识条数上限（全量去记忆页）
_A_LIMIT = 10     # 资产条数上限（全量去资产页）
_R_LIMIT = 20     # 近期 run 条数上限（全量去 Runs 页）


def make_router(env: str, defs_store, domain_cfgs: dict) -> APIRouter:
    router = APIRouter()

    def _own_tasks(cfg, task_rows: list[dict]) -> tuple[list, list]:
        """域拥有的任务 = 域包种子任务 + 挂在它们下面的子任务（命名即绑定）。"""
        seeds = {t.get("name") for t in (getattr(cfg, "seed_tasks", None) or [])
                 if t.get("name")}
        owned = [r for r in task_rows
                 if r["name"] in seeds or r.get("extends") in seeds]
        parents = sorted((t for t in owned if not t.get("extends")),
                         key=lambda t: t["name"])
        subs = sorted((t for t in owned if t.get("extends")),
                      key=lambda t: t["name"])
        return parents, subs

    async def _rules_state(name: str) -> tuple[list | None, int | None]:
        definition = await defs_store.get_active("rules", env, name)
        if definition is None:
            return None, None
        version = await definitions_store.active_version("rules", env, name)
        return definition.get("rules") or [], version

    @router.get("/services", response_class=HTMLResponse)
    async def services_page():
        task_rows = await defs_store.list_active("task", env)
        kstats = await knowledge_store.domain_stats(env)
        astats = await assets_store.domain_counts(env)
        cards = []
        for name in sorted(domain_cfgs):
            cfg = domain_cfgs[name]
            parents, subs = _own_tasks(cfg, task_rows)
            rules, rules_ver = await _rules_state(name)
            _, runs_24h, _, _ = await runs_store.list_filtered(
                domain=name, hours=24, limit=1)
            cards.append({
                "name": name,
                "hosts": len(getattr(cfg, "hosts", None) or []),
                "envs": sorted((getattr(cfg, "envs", None) or {}).keys()),
                "rules_version": rules_ver,
                "has_rules": rules is not None,
                "tasks": len(parents), "sub_tasks": len(subs),
                "knowledge": kstats.get(name, {}).get("active", 0),
                "assets": astats.get(name, {}).get("active", 0),
                "runs_24h": runs_24h,
            })
        return render("services.html", "服务", active="/services", cards=cards)

    @router.get("/services/{name}", response_class=HTMLResponse)
    async def service_detail(name: str):
        cfg = domain_cfgs.get(name)
        if cfg is None:
            raise HTTPException(404, f"服务 {name} 不存在（conf/domains/ 未配置）")
        task_rows = await defs_store.list_active("task", env)
        parents, subs = _own_tasks(cfg, task_rows)
        rules, rules_ver = await _rules_state(name)
        knowledge = await knowledge_store.list_all(env, name)
        assets, assets_total, _ = await assets_store.list_filtered(
            env, domain=name, limit=_A_LIMIT)
        runs_rows, runs_total, _, _ = await runs_store.list_filtered(
            domain=name, limit=_R_LIMIT)
        return render(
            "service_detail.html", f"服务 · {name}", active="/services",
            name=name, cfg=cfg,
            env_overlays=sorted((getattr(cfg, "envs", None) or {}).keys()),
            parents=parents, subs=subs,
            rules=rules, rules_version=rules_ver,
            rules_json=(json.dumps(rules, ensure_ascii=False, indent=2)
                        if rules is not None else ""),
            knowledge=[{**k, "content": (k["content"] or "")[:160]}
                       for k in knowledge[:_K_LIMIT]],
            knowledge_total=len(knowledge),
            assets=assets, assets_total=assets_total,
            runs=runs_rows, runs_total=runs_total)

    return router
