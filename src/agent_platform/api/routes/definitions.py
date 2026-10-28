"""服务 / 角色 / 任务：同一套增删改与版本历史。

    GET    /v1/{kind}                       列表
    POST   /v1/{kind}                       新建（请求体含 name）
    GET    /v1/{kind}/{name}                单个
    PATCH  /v1/{kind}/{name}                局部更新：出现的顶层字段整体替换
    DELETE /v1/{kind}/{name}                删除（被引用时 409 in_use；删父任务连带子任务）
    GET    /v1/{kind}/{name}/versions       版本历史（新的在前）
    POST   /v1/{kind}/{name}/versions/{v}/restore
    GET    /v1/{kind}/{name}/version-stats  每个版本的运行效果（仅 roles / tasks）

kind ∈ services / roles / tasks。服务与任务的列表与单个带统计（views.py）。
定义改了即时生效（定义缓存最多 5 秒），定时触发每轮读最新定义，不需要额外同步。
"""

from __future__ import annotations

from fastapi import APIRouter, Body

from ... import credentials
from ...domain import Rejected
from ...store import runs
from .. import views
from ..deps import RT, WHO, Caller, Runtime

router = APIRouter(prefix="/v1")

KINDS = {"services": "service", "roles": "role", "tasks": "task"}


# ———————— 服务 ————————

async def _service_summaries(rt: Runtime, names: set[str] | None = None) -> list[dict]:
    """task_count = 本服务专属的任务；generic_task_count = 通用任务（service="*"，每个服务都能调用）。都不含子任务。"""
    envs = (await rt.registry.envs()).items
    health = await runs.service_health()
    tasks = [t for t in await rt.registry.tasks() if not t.spec.extends]
    generic = sum(1 for t in tasks if t.spec.service == "*")
    return [views.service_summary(s, envs, health, sum(1 for t in tasks if t.spec.service == s.name), generic)
            for s in await rt.registry.services() if names is None or s.name in names]


@router.get("/services")
async def list_services(rt: Runtime = RT, _: Caller = WHO):
    return await _service_summaries(rt)


@router.get("/services/{name}")
async def get_service(name: str, rt: Runtime = RT, _: Caller = WHO):
    found = await _service_summaries(rt, {name})
    if not found:
        raise Rejected.not_found(f"服务 {name}")
    return found[0]


# ———————— 角色 ————————

@router.get("/roles")
async def list_roles(rt: Runtime = RT, _: Caller = WHO):
    return [r.dump() for r in await rt.registry.roles()]


@router.get("/roles/{name}")
async def get_role(name: str, rt: Runtime = RT, _: Caller = WHO):
    r = await rt.registry.role(name)
    if r is None:
        raise Rejected.not_found(f"角色 {name}")
    return r.dump()


@router.get("/roles/{name}/resolved")
async def resolved_role(name: str, rt: Runtime = RT, _: Caller = WHO):
    """继承合并后的生效提示词与工具。"""
    role, _versions = await rt.registry.resolved_role(name)
    return role.model_dump()


# ———————— 任务 ————————

async def task_summaries(rt: Runtime, names: set[str] | None = None) -> list[dict]:
    raw = {t.name: t for t in await rt.registry.tasks()}
    stats = await runs.task_stats()
    fires: dict[str, dict] = {}
    for f in await rt.scheduler.upcoming():
        fires.setdefault(f["task"], {"env": f["env"], "at": f["at"]})
    out = []
    for name, own in raw.items():
        if names is not None and name not in names:
            continue
        effective = await rt.registry.task(name)
        children = sum(1 for t in raw.values() if t.spec.extends == name)
        out.append(views.task_summary(effective, own, stats, fires.get(name), children))
    return out


@router.get("/tasks")
async def list_tasks(service: str | None = None, rt: Runtime = RT, _: Caller = WHO):
    """全部任务（含子任务，子任务带 extends）。service=x：x 的专属任务 + 通用任务。"""
    items = await task_summaries(rt)
    if service:
        items = [t for t in items if t["service"] in (service, "*")]
    return items


@router.get("/tasks/_graph")
async def task_graph(rt: Runtime = RT, _: Caller = WHO):
    """任务图：节点是父任务（子任务归到父任务上），边是上游联动（上游结束 → 下游）。
    节点带入口触发（定时 / 事件 / API / 对话）和近 24 小时统计，控制台画图用；_graph 不是合法任务名，不会和任务撞。"""
    summaries = {t["name"]: t for t in await task_summaries(rt)}
    nodes, edges = [], []
    for name, t in summaries.items():
        if not t.get("extends"):
            nodes.append({k: t.get(k) for k in ("name", "title", "service", "form", "enabled", "subtask_count",
                                                 "stats_24h", "last_run", "next_fire")}
                         | {"entry": _entries(t["triggers"])})
    for name, t in summaries.items():
        if t.get("extends") and "triggers" not in t.get("overrides", []):
            continue
        down = name.split(":")[0]
        for tr in t["triggers"]:
            if tr["type"] != "after":
                continue
            for up in tr["tasks"]:
                edges.append({"from": up.split(":")[0], "to": down, "trigger_id": tr["id"], "mode": tr["mode"],
                              "on": tr["on"], "enabled": tr.get("enabled", True) and t.get("enabled", True),
                              "from_object": up.split(":", 1)[1] if ":" in up else None,
                              "to_object": name.split(":", 1)[1] if ":" in name else None,
                              "upstreams": len(tr["tasks"])})
    return {"nodes": nodes, "edges": edges}


def _entries(triggers: list[dict]) -> list[dict]:
    """入口触发（不含上游联动）：图上画在节点里。"""
    out = []
    for tr in triggers:
        if tr["type"] == "after" or tr.get("enabled") is False:
            continue
        out.append({"type": tr["type"], "id": tr["id"], **({"cron": tr["cron"]} if tr["type"] == "schedule" else {}),
                    **({"source": tr["source"], "event": tr["event"]} if tr["type"] == "event" else {})})
    return out


@router.get("/tasks/{name}")
async def get_task(name: str, rt: Runtime = RT, _: Caller = WHO):
    found = await task_summaries(rt, {name})
    if not found:
        raise Rejected.not_found(f"任务 {name}")
    return found[0]


# ———————— 通用写入与版本 ————————

async def _shaped(rt: Runtime, kind: str, name: str) -> dict:
    if kind == "service":
        return (await _service_summaries(rt, {name}))[0]
    if kind == "task":
        return (await task_summaries(rt, {name}))[0]
    return (await rt.registry.entry(kind, name)).dump()


def _writes(plural: str, kind: str) -> None:
    """为一种定义注册写入与版本路由（三种定义的写法完全一样）。"""

    async def unmasked(rt: Runtime, name: str, body: dict) -> dict:
        """服务的只读库口令回显是 ***：原样传回表示不改，换回库里的值。"""
        if kind != "service":
            return body
        current = await rt.registry.store.get(kind, name)
        body = credentials.restore_service(body, current["definition"] if current else {})
        if why := credentials.unresolved_mask(body):
            raise Rejected("invalid_definition", why, 422)
        return body

    async def create(body: dict = Body(...), rt: Runtime = RT, who: Caller = WHO):
        name = str(body.get("name") or "").strip()
        if not name:
            raise Rejected("invalid_definition", "缺少 name", 422)
        await rt.registry.create(kind, name, await unmasked(rt, name, body), who.name)
        return await _shaped(rt, kind, name)

    async def update(name: str, body: dict = Body(...), rt: Runtime = RT, who: Caller = WHO):
        await rt.registry.update(kind, name, await unmasked(rt, name, body), who.name)
        return await _shaped(rt, kind, name)

    async def delete(name: str, rt: Runtime = RT, who: Caller = WHO):
        removed = await rt.registry.delete(kind, name, who.name)
        return {"deleted": removed}

    async def versions(name: str, rt: Runtime = RT, _: Caller = WHO):
        history = await rt.registry.store.history(kind, name)
        if not history:
            raise Rejected.not_found(f"{plural}/{name}")
        if kind == "service":
            history = [{**h, "definition": credentials.redact_service(h["definition"])} for h in history]
        return history

    async def restore(name: str, version: int, rt: Runtime = RT, who: Caller = WHO):
        await rt.registry.restore(kind, name, version, who.name)
        return await _shaped(rt, kind, name)

    async def version_stats(name: str, _: Caller = WHO):
        """每个版本跑出来的效果：次数、成功 / 失败、被 👎 的运行数、平均 token 与耗时（回归重放不算）。"""
        return await runs.version_stats(kind, name)

    router.add_api_route(f"/{plural}", create, methods=["POST"], status_code=201)
    router.add_api_route(f"/{plural}/{{name}}", update, methods=["PATCH"])
    router.add_api_route(f"/{plural}/{{name}}", delete, methods=["DELETE"])
    router.add_api_route(f"/{plural}/{{name}}/versions", versions, methods=["GET"])
    router.add_api_route(f"/{plural}/{{name}}/versions/{{version}}/restore", restore, methods=["POST"])
    if kind in ("task", "role"):
        router.add_api_route(f"/{plural}/{{name}}/version-stats", version_stats, methods=["GET"])


for _plural, _kind_name in KINDS.items():
    _writes(_plural, _kind_name)
