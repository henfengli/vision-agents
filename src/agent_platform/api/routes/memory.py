"""记忆与方法。档案（人写的）在服务 / 任务定义的 profile 里，不在这里。

记忆 = agent 记下的事，一张表三种 kind：fact 事实 / lesson 报错教训 / handoff 交接摘要（列表默认不含）。
按服务分区；env 为空的条目对所有环境成立，env 过滤 = 该环境的 + 通用的（env=* 只看通用的）。

    GET    /v1/knowledge                service env task kind(fact|lesson|handoff)
                                        status(active|negative|expired|superseded|all) q
    POST   /v1/knowledge                人工录入 {service, env?, kind, key, content, task, error?, category?}
    GET    /v1/knowledge/promotable     service env：近 30 天被 ≥5 次运行召回、没挨过 👎 的事实（值得升格进档案）
    GET    /v1/knowledge/{id}
    PATCH  /v1/knowledge/{id}           {content?, status?: active|expired}
    DELETE /v1/knowledge/{id}           作废（= status expired，可恢复）
    GET    /v1/knowledge/{id}/history   内容历史
    POST   /v1/knowledge/{id}/promote   升格进档案 {target: service|task, key, task?, content?}

    GET    /v1/assets                   service env task kind status(active|superseded|all) q
    POST   /v1/assets                   人工录入方法 {service, env, task, kind, name, summary, content}
    PATCH  /v1/assets/{id}              {summary?, content?, status?: active|superseded}
    DELETE /v1/assets/{id}              作废
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected
from ...store import assets as assets_store
from ...store import knowledge as knowledge_store
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import AssetCreate, AssetPatch, KnowledgeCreate, KnowledgePatch, KnowledgePromote

router = APIRouter(prefix="/v1")


async def _scope(rt: Runtime, service: str, env: str) -> None:
    """确认服务与环境存在。env 空 = 所有环境通用。"""
    if await rt.registry.service(service) is None:
        raise Rejected.not_found(f"服务 {service}")
    if env:
        await rt.registry.env(env)


# ———————— 记忆 ————————

@router.get("/knowledge")
async def list_knowledge(service: str | None = None, env: str | None = None, task: str | None = None,
                         kind: str | None = None, status: str | None = None, q: str | None = None, _: Caller = WHO):
    return await knowledge_store.list_entries(env=env, service=service, task=task, kind=kind, status=status, q=q)


@router.get("/knowledge/promotable")
async def knowledge_promotable(service: str | None = None, env: str | None = None, _: Caller = WHO):
    return await knowledge_store.promotable(service, env)


@router.post("/knowledge", status_code=201)
async def create_knowledge(body: KnowledgeCreate, rt: Runtime = RT, _: Caller = WHO):
    await _scope(rt, body.service, body.env)
    if body.kind == "lesson":
        if not body.error.strip():
            raise Rejected("invalid_input", "教训要给报错原文（error），按它算指纹，同类报错才能命中")
        await knowledge_store.lessons.add(body.env, body.service, body.error, body.category, body.content, None,
                                          task=body.task, embedder=rt.model_pool.embed)
        key = f"lesson:{knowledge_store.lessons.fingerprint(body.error)}"
        return await knowledge_store.find(body.env, body.service, key)
    if not body.key.strip():
        raise Rejected("invalid_input", "事实要给 key（如 metric:gmv）")
    if await knowledge_store.find(body.env, body.service, body.key):
        where = body.env or "所有环境"
        raise Rejected.conflict(f"{body.service}（{where}）已有记忆 {body.key}，请直接编辑")
    await knowledge_store.upsert(body.env, body.service, body.key, body.content, source_run=None,
                                 task=body.task, embedder=rt.model_pool.embed)
    return await knowledge_store.find(body.env, body.service, body.key)


@router.get("/knowledge/{entry_id}")
async def get_knowledge(entry_id: int, _: Caller = WHO):
    return await _knowledge(entry_id)


@router.patch("/knowledge/{entry_id}")
async def patch_knowledge(entry_id: int, body: KnowledgePatch, rt: Runtime = RT, _: Caller = WHO):
    await _knowledge(entry_id)
    if body.content is not None:
        await knowledge_store.update_content(entry_id, body.content, embedder=rt.model_pool.embed)
    if body.status == "expired":
        await knowledge_store.mark_expired(entry_id)
    elif body.status == "active":
        await knowledge_store.restore(entry_id)
    return await _knowledge(entry_id)


@router.delete("/knowledge/{entry_id}")
async def delete_knowledge(entry_id: int, _: Caller = WHO):
    await _knowledge(entry_id)
    await knowledge_store.mark_expired(entry_id)
    return await _knowledge(entry_id)


@router.get("/knowledge/{entry_id}/history")
async def knowledge_history(entry_id: int, _: Caller = WHO):
    e = await _knowledge(entry_id)
    return await knowledge_store.list_content_history(e["env"], e["service"], e["key"])


@router.post("/knowledge/{entry_id}/promote")
async def promote_knowledge(entry_id: int, body: KnowledgePromote, rt: Runtime = RT, who: Caller = WHO):
    """记忆升格为档案：档案逐字置顶注入、不会过期，适合被反复用到、确认无误的口径与约定。"""
    e = await _knowledge(entry_id)
    if e["status"] != "active":
        raise Rejected("conflict", "只有生效中的记忆能升格", 409)
    text = (body.content or e["content"]).strip()
    if body.target == "service":
        row = await rt.registry.store.get("service", e["service"])
        if row is None:
            raise Rejected.not_found(f"服务 {e['service']}")
        definition = row["definition"]
        if e["env"]:          # 只在某环境成立：写进该环境的档案覆盖
            envs = dict(definition.get("envs") or {})
            override = dict(envs.get(e["env"]) or {})
            override["profile"] = _merged(override.get("profile") or {}, body.key, text)
            envs[e["env"]] = override
            patch = {"envs": envs}
        else:
            patch = {"profile": _merged(definition.get("profile") or {}, body.key, text)}
        await rt.registry.update("service", e["service"], patch, who.name)
        where = f"service:{e['service']}" + (f"@{e['env']}" if e["env"] else "")
    else:
        task = body.task or e["task"]
        if not task:
            raise Rejected("invalid_input", "这条记忆没有来源任务，请指定写进哪个任务（task）")
        row = await rt.registry.store.get("task", task)
        if row is None:
            raise Rejected.not_found(f"任务 {task}")
        await rt.registry.update("task", task, {"profile": _merged(row["definition"].get("profile") or {}, body.key,
                                                                   text)}, who.name)
        where = f"task:{task}"
    await knowledge_store.supersede_entry(entry_id, f"profile:{where}:{body.key}")
    return {"entry": await _knowledge(entry_id), "profile": {"target": where, "key": body.key}}


def _merged(profile: dict, key: str, text: str) -> dict:
    """同一个键已有内容就接在后面（已经包含就不重复）。"""
    old = str(profile.get(key) or "").strip()
    return {**profile, key: text if not old else old if text in old else f"{old}；{text}"}


async def _knowledge(entry_id: int) -> dict:
    e = await knowledge_store.entry(entry_id)
    if e is None:
        raise Rejected.not_found(f"记忆 {entry_id}")
    return e


# ———————— 方法 ————————

@router.get("/assets")
async def list_assets(service: str | None = None, env: str | None = None, task: str | None = None,
                      kind: str | None = None, status: str | None = None, q: str | None = None, _: Caller = WHO):
    return await assets_store.list_entries(env=env, service=service, task=task, kind=kind, status=status, q=q)


@router.post("/assets", status_code=201)
async def create_asset(body: AssetCreate, rt: Runtime = RT, _: Caller = WHO):
    await _scope(rt, body.service, body.env)
    await assets_store.upsert(body.env, body.service, body.task, body.kind, body.name, body.summary, body.content,
                              source_run=None)
    found = await assets_store.list_entries(env=body.env, service=body.service, kind=body.kind, status="all")
    hit = next((a for a in found if a["name"] == body.name and a["task"] == body.task), None)
    if hit is None:
        raise Rejected("internal", "方法已保存，但没能读回", 500)
    return hit


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: int, body: AssetPatch, _: Caller = WHO):
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
async def delete_asset(asset_id: int, _: Caller = WHO):
    await _asset(asset_id)
    await assets_store.mark_expired(asset_id)
    return await _asset(asset_id)


async def _asset(asset_id: int) -> dict:
    found = await assets_store.list_entries(entry_id=asset_id, status="all", limit=1)
    if not found:
        raise Rejected.not_found(f"方法 {asset_id}")
    return found[0]
