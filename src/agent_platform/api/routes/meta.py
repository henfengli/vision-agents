"""元信息、统计、搜索、事件入口、登录。

    GET    /v1/meta                 版本、环境、工具目录、事件来源、通知渠道、反馈问题类型、功能开关、当前身份
    GET    /v1/stats                hours service env
    GET    /v1/search?q=            全局搜索（服务 / 任务 / 角色 / 运行 / 记忆 / 方法）
    POST   /v1/events/{source}      事件入口（dagster / gitlab / webhook）
    POST   /auth/session            控制台登录 {token, name}
    GET    /auth/session            当前登录身份
    DELETE /auth/session            退出
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request, Response

from ... import __version__
from ...domain import BUILTIN_HANDLERS, FEEDBACK_REASONS, Rejected
from ...store import assets as assets_store
from ...store import db, runs
from ...store import knowledge as knowledge_store
from ...triggers.sources import SOURCES
from ..auth import COOKIE, COOKIE_MAX_AGE, caller_for_token, make_session
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import LoginBody

router = APIRouter()


@router.get("/v1/meta")
async def meta(rt: Runtime = RT, who: Caller = WHO):
    envs = await rt.registry.envs()
    return {
        "version": __version__,
        "envs": [e.model_dump() for e in envs.items], "default_env": envs.default,
        "tools": rt.toolbox.info(),
        "event_sources": [s.info() for s in SOURCES.values()],
        "channels": await rt.notifier.channel_names(),
        "feedback_reasons": [{"value": k, "label": v} for k, v in FEEDBACK_REASONS.items()],
        "builtin_handlers": list(BUILTIN_HANDLERS),       # 内建任务可选的处理器
        "features": {"vector_search": await db.has_vector()},
        "me": who.model_dump(),
    }


UPCOMING_LIMIT = 8


@router.get("/v1/stats")
async def stats(hours: int = Query(24, ge=1, le=24 * 90), service: str | None = None, env: str | None = None, rt: Runtime = RT,
                _: Caller = WHO):
    """upcoming：接下来的定时触发，不含内建任务（记忆园丁这类夜间维护每个服务×环境各一条，会把业务定时挤掉；
    它们在任务页按「定时」筛选能看到）。upcoming_total 是去掉内建任务后的总次数，task_title 是任务的显示名。"""
    data = await runs.stats(hours=hours, env=env, service=service)
    fires = [f for f in await rt.scheduler.upcoming()
             if (not env or f["env"] == env) and (not service or f["service"] == service)]
    tasks: dict = {}                                    # 任务名 → 生效定义（None = 已删除）
    for f in fires:
        if f["task"] not in tasks:
            tasks[f["task"]] = await rt.registry.task(f["task"])
    upcoming = [{**f, "task_title": tasks[f["task"]].spec.title or f["task"]} for f in fires
                if tasks[f["task"]] is not None and tasks[f["task"]].spec.form != "builtin"]
    return {**data, "upcoming": upcoming[:UPCOMING_LIMIT], "upcoming_total": len(upcoming)}


def _first_line(text: str, limit: int = 60) -> str:
    line = next((x.strip() for x in (text or "").splitlines() if x.strip()), "")
    return line if len(line) <= limit else line[:limit] + "…"


@router.get("/v1/search")
async def search(q: str, rt: Runtime = RT, _: Caller = WHO):
    term = q.strip().lower()
    if not term:
        return []
    hits = []
    for s in await rt.registry.services():
        if term in (s.name + s.spec.title + s.spec.description).lower():
            hits.append({"type": "service", "id": s.name, "title": s.spec.title or s.name,
                         "subtitle": f"{s.name} · {_first_line(s.spec.description, 40)}" if s.spec.description else s.name,
                         "href": f"/services/{s.name}"})
    for t in await rt.registry.tasks():
        if term in (t.name + t.spec.title).lower():
            hits.append({"type": "task", "id": t.name, "title": t.spec.title or t.name, "subtitle": t.name,
                         "href": f"/tasks/{t.name}"})
    for r in await rt.registry.roles():
        if term in (r.name + r.spec.title).lower():
            hits.append({"type": "role", "id": r.name, "title": r.spec.title or r.name, "subtitle": r.name,
                         "href": f"/settings/roles/{r.name}"})
    for r in await runs.search(q.strip(), limit=8):
        hits.append({"type": "run", "id": r["run_id"], "title": r["summary"],
                     "subtitle": f"{r['task']} · {r['env']} · {r['run_id'][:8]}", "href": f"/runs/{r['run_id']}"})
    for k in (await knowledge_store.list_entries(q=q.strip(), limit=6)):
        # 教训的键是 lesson:<指纹>，人看不懂：标题用结论的第一行
        lesson = k["kind"] == "lesson"
        hits.append({"type": "knowledge", "id": str(k["id"]),
                     "title": f"教训：{_first_line(k['content'])}" if lesson else k["key"],
                     "subtitle": f"{k['service']}@{k['env'] or '所有环境'}"
                                 + ("" if lesson else f" · {_first_line(k['content'], 40)}"),
                     "href": f"/memory?knowledge={k['id']}"})
    for a in (await assets_store.list_entries(q=q.strip(), status="active", limit=6)):
        hits.append({"type": "asset", "id": str(a["id"]), "title": a["name"],
                     "subtitle": f"{a['service']}@{a['env']} · {_first_line(a['summary'], 40)}",
                     "href": f"/memory?tab=assets&id={a['id']}"})
    return hits[:30]


@router.post("/v1/events/{source}")
async def receive_event(source: str, request: Request, rt: Runtime = RT, who: Caller = WHO):
    """请求体是来源系统的回调原文。返回每个匹配任务的处理结果。"""
    try:
        body = await request.json()
    except ValueError as e:
        raise Rejected("invalid_request", "请求体需要是 JSON", 422) from e
    return await rt.events.receive(source, body if isinstance(body, dict) else {"data": body},
                                   dict(request.headers), who)


@router.post("/auth/session")
async def login(body: LoginBody, request: Request, response: Response, rt: Runtime = RT):
    who = await caller_for_token(request, body.token, body.name.strip() or None)
    if who is None:
        raise Rejected("unauthorized", "密钥无效、已吊销或已过期", 401)
    response.set_cookie(COOKIE, make_session(rt.settings.root_token, body.token, who.name), max_age=COOKIE_MAX_AGE,
                        httponly=True, samesite="lax", secure=rt.settings.public_url.startswith("https://"))
    return who.model_dump()


@router.get("/auth/session")
async def whoami(who: Caller = WHO):
    return who.model_dump()


@router.delete("/auth/session", status_code=204)
async def logout(response: Response):
    response.delete_cookie(COOKIE)
