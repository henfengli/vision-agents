"""记忆：知识、方法、案例。全部按 服务 × 环境 分区；task 过滤含其子任务。

    GET    /v1/knowledge              service env task status(active|expired|superseded|all) q
    POST   /v1/knowledge              人工录入 {service, env, key, content, task}
    GET    /v1/knowledge/{id}
    PATCH  /v1/knowledge/{id}         {content?, status?: active|expired}
    DELETE /v1/knowledge/{id}         作废（= status expired，可恢复）
    GET    /v1/knowledge/{id}/history 内容历史
    GET    /v1/knowledge/health       service env
    POST   /v1/knowledge/search       试检索：这条问题运行时会召回什么 {query, service, env, task}

    GET    /v1/assets                 service env task kind status
    POST   /v1/assets                 人工录入方法 {service, env, task, kind, name, summary, content}
    PATCH  /v1/assets/{id}            {summary?, content?, status?: active|superseded}
    DELETE /v1/assets/{id}            作废

    GET    /v1/cases                  service env
    DELETE /v1/cases/{id}             作废
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected
from ...memory import recall
from ...store import assets as assets_store
from ...store import cases as cases_store
from ...store import knowledge as knowledge_store
from ..deps import ADMIN, RT, WHO, Caller, Runtime
from ..schemas import AssetCreate, AssetPatch, KnowledgeCreate, KnowledgePatch, KnowledgeSearch

router = APIRouter(prefix="/v1")


async def _scope(rt: Runtime, service: str, env: str) -> list[str]:
    """确认服务与环境存在，返回该环境的代码目录（新录入知识的 code_ref 校验用）。"""
    s = await rt.registry.service(service)
    if s is None:
        raise Rejected.not_found(f"服务 {service}")
    await rt.registry.env(env)
    return s.spec.view(service, env).code_paths


# ———————— 知识 ————————

@router.get("/knowledge")
async def list_knowledge(service: str | None = None, env: str | None = None, task: str | None = None,
                         status: str | None = None, q: str | None = None, _: Caller = WHO):
    return await knowledge_store.list_entries(env=env, service=service, task=task, status=status, q=q)


@router.get("/knowledge/health")
async def knowledge_health(service: str | None = None, env: str | None = None, _: Caller = WHO):
    return await knowledge_store.health(env, service)


@router.post("/knowledge/search")
async def search_knowledge(body: KnowledgeSearch, rt: Runtime = RT, _: Caller = WHO):
    code_paths = await _scope(rt, body.service, body.env)
    memory = await rt.registry.config("memory")
    found = await recall(env=body.env, service=body.service, task=body.task, query=body.query, code_paths=code_paths,
                         session_id=None, run_id=None, limit=memory.knowledge_limit,
                         embedder=rt.model_pool.embed, source="playground")
    ranks = {h["id"]: h["rank"] for h in found.knowledge}
    hits = [{**e, "rank": ranks[e["id"]]} for e in
            [await knowledge_store.entry(i) for i in ranks] if e is not None]
    return {"hits": sorted(hits, key=lambda h: h["rank"]), "block": found.text}


@router.post("/knowledge", status_code=201)
async def create_knowledge(body: KnowledgeCreate, rt: Runtime = RT, _: Caller = ADMIN):
    await _scope(rt, body.service, body.env)
    if await knowledge_store.find(body.env, body.service, body.key):
        raise Rejected.conflict(f"{body.service}@{body.env} 已有知识 {body.key}，请直接编辑")
    await knowledge_store.upsert(body.env, body.service, body.key, body.content, source_run=None,
                                 task=body.task, embedder=rt.model_pool.embed)
    return await knowledge_store.find(body.env, body.service, body.key)


@router.get("/knowledge/{entry_id}")
async def get_knowledge(entry_id: int, _: Caller = WHO):
    return await _knowledge(entry_id)


@router.patch("/knowledge/{entry_id}")
async def patch_knowledge(entry_id: int, body: KnowledgePatch, rt: Runtime = RT, _: Caller = ADMIN):
    await _knowledge(entry_id)
    if body.content is not None:
        await knowledge_store.update_content(entry_id, body.content, embedder=rt.model_pool.embed)
    if body.status == "expired":
        await knowledge_store.mark_expired(entry_id)
    elif body.status == "active":
        await knowledge_store.restore(entry_id)
    return await _knowledge(entry_id)


@router.delete("/knowledge/{entry_id}")
async def delete_knowledge(entry_id: int, _: Caller = ADMIN):
    await _knowledge(entry_id)
    await knowledge_store.mark_expired(entry_id)
    return await _knowledge(entry_id)


@router.get("/knowledge/{entry_id}/history")
async def knowledge_history(entry_id: int, _: Caller = WHO):
    e = await _knowledge(entry_id)
    return await knowledge_store.list_content_history(e["env"], e["service"], e["key"])


async def _knowledge(entry_id: int) -> dict:
    e = await knowledge_store.entry(entry_id)
    if e is None:
        raise Rejected.not_found(f"知识 {entry_id}")
    return e


# ———————— 方法 ————————

@router.get("/assets")
async def list_assets(service: str | None = None, env: str | None = None, task: str | None = None,
                      kind: str | None = None, status: str | None = None, _: Caller = WHO):
    return await assets_store.list_entries(env=env, service=service, task=task, kind=kind, status=status)


@router.post("/assets", status_code=201)
async def create_asset(body: AssetCreate, rt: Runtime = RT, _: Caller = ADMIN):
    await _scope(rt, body.service, body.env)
    await assets_store.upsert(body.env, body.service, body.task, body.kind, body.name, body.summary, body.content,
                              source_run=None)
    found = await assets_store.list_entries(env=body.env, service=body.service, kind=body.kind, status="all")
    return next(a for a in found if a["name"] == body.name and a["task"] == body.task)


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: int, body: AssetPatch, _: Caller = ADMIN):
    a = await _asset(asset_id)
    if body.summary is not None or body.content is not None:
        await assets_store.update(asset_id, body.summary if body.summary is not None else a["summary"],
                                  body.content if body.content is not None else a["content"])
    if body.status == "superseded":
        await assets_store.mark_expired(asset_id)
    elif body.status == "active":
        await assets_store.restore(asset_id)
    return await _asset(asset_id)


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: int, _: Caller = ADMIN):
    await _asset(asset_id)
    await assets_store.mark_expired(asset_id)
    return await _asset(asset_id)


async def _asset(asset_id: int) -> dict:
    found = await assets_store.list_entries(entry_id=asset_id, status="all", limit=1)
    if not found:
        raise Rejected.not_found(f"方法 {asset_id}")
    return found[0]


# ———————— 案例 ————————

@router.get("/cases")
async def list_cases(service: str | None = None, env: str | None = None, _: Caller = WHO):
    return await cases_store.list_entries(env, service)


@router.delete("/cases/{case_id}")
async def delete_case(case_id: int, _: Caller = ADMIN):
    if not await cases_store.expire(case_id):
        raise Rejected.not_found(f"案例 {case_id}")
    return {"ok": True}
