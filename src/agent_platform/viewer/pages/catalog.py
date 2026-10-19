"""资产目录页：业务对象（dagster asset/表/报表）的档案列表 + 编辑抽屉。

定位区别于「资产」页：资产页管 run 沉淀的产出物（方法/脚本/查询/基线），
本页管被操作的业务对象本身——负责人、上下游、代码位置、runbook。
run 输入带 asset_key 时档案整段注入 prompt（确定性归因）；每个条目
聚合展示该资产的 run 统计与最近失败，一键跳转台账/会话。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ...store import catalog as catalog_store
from ...store import runs as runs_store
from .base import render

_TIERS = {"": "未分级", "core": "核心", "important": "重要", "normal": "普通"}


def make_router(env: str, target_envs: list[str] | None = None) -> APIRouter:
    router = APIRouter()

    @router.get("/catalog", response_class=HTMLResponse)
    async def catalog_page(request: Request):
        p = request.query_params
        t_env = p.get("env") or (target_envs or [env])[0]
        domain = p.get("domain") or ""
        q = p.get("q") or ""
        entries = await catalog_store.list_entries(t_env, domain or None,
                                                   q or None)
        # 每条目的 run 统计（近 30 天）：input->>'asset_key' 精确匹配
        stats = await runs_store.stats_by_asset_key(t_env, days=30)
        domains = sorted({e["domain"] for e in entries})
        return render("catalog.html", "资产目录", active="/catalog",
                      entries=entries, stats=stats, tiers=_TIERS,
                      f_env=t_env, f_domain=domain, f_q=q,
                      target_envs=target_envs or [], domains=domains)

    @router.get("/catalog/{entry_id}.json")
    async def catalog_detail(entry_id: int):
        entry = await catalog_store.get_by_id(entry_id)
        if entry is None:
            raise HTTPException(404, "目录条目不存在")
        recent = await runs_store.recent_by_asset_key(
            entry["env"], entry["asset_key"], limit=10)
        return {"entry": entry, "recent_runs": recent}

    @router.post("/catalog/save")
    async def catalog_save(request: Request):
        form = await request.form()

        def list_field(key: str) -> list[str]:
            raw = str(form.get(key) or "")
            return [s.strip() for s in raw.replace("，", ",").split(",")
                    if s.strip()]

        tier = str(form.get("tier") or "")
        if tier not in _TIERS:
            raise HTTPException(422, "tier 不合法")
        await catalog_store.upsert(
            str(form.get("env") or env), str(form.get("domain") or ""),
            str(form.get("asset_key") or "").strip(),
            name=str(form.get("name") or "").strip(),
            owner=str(form.get("owner") or "").strip(), tier=tier,
            upstream=list_field("upstream"),
            downstream=list_field("downstream"),
            code_refs=list_field("code_refs"), tags=list_field("tags"),
            runbook=str(form.get("runbook") or ""),
            by=str(form.get("by") or "web"))
        return RedirectResponse("/catalog", status_code=303)

    @router.post("/catalog/{entry_id}/delete")
    async def catalog_delete(entry_id: int):
        await catalog_store.delete(entry_id)
        return RedirectResponse("/catalog", status_code=303)

    return router
