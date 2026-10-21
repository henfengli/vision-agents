"""服务×环境：agent 实际看到的东西与进程启停。

    GET  /v1/services/{s}/envs/{env}                               该环境的解析结果（目录、配置文件、git、档案）
    GET  /v1/services/{s}/envs/{env}/config?path=                  读本环境声明过的配置文件（密钥打码）
    GET  /v1/services/{s}/processes                                全部 环境×进程 的实例状态
    POST /v1/services/{s}/envs/{env}/processes/{p}/start|stop|renew  启停 / 续期；受保护环境的启停先审批，
                                                                      只看不起的环境拒绝 start（start_not_allowed）
    GET  /v1/services/{s}/envs/{env}/processes/{p}/logs?lines=
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected, ServiceView
from ...services import inspect
from ...store import approvals as approvals_store
from ..deps import ADMIN, RT, WHO, Caller, Runtime
from ..schemas import ProcessBody

router = APIRouter(prefix="/v1/services/{service}")


async def _view(rt: Runtime, service: str, env: str) -> ServiceView:
    view = await rt.registry.service_view(service, env)
    if view is None:
        raise Rejected.not_found(f"服务 {service}")
    return view


@router.get("/envs/{env}")
async def service_env(service: str, env: str, rt: Runtime = RT, _: Caller = WHO):
    return inspect.view_dict(await _view(rt, service, env))


@router.get("/envs/{env}/config")
async def service_config(service: str, env: str, path: str, rt: Runtime = RT, _: Caller = WHO):
    view = await _view(rt, service, env)
    return {"path": path, "content": inspect.read_config(view, path)}


@router.get("/processes")
async def processes(service: str, rt: Runtime = RT, _: Caller = WHO):
    return await rt.controller.list(service)


@router.post("/envs/{env}/processes/{process}/{action}")
async def process_action(service: str, env: str, process: str, action: str, body: ProcessBody | None = None,
                         rt: Runtime = RT, who: Caller = ADMIN):
    """返回 {instance, approval}：受保护环境的 start/stop 先建审批单（approval 非空），放行后才执行。"""
    if action not in ("start", "stop", "renew"):
        raise Rejected.not_found(f"动作 {action}")
    hours = body.hours if body else None
    if action == "start":
        await rt.controller.ensure_startable(service, env)
    if action != "renew" and (await rt.registry.env(env)).protected:
        await rt.controller.get(service, env, process)          # 先确认进程存在
        verb = "启动" if action == "start" else "停止"
        approval = await approvals_store.create(
            kind="process", title=f"进程{verb} · {service}/{process}@{env}",
            detail=f"{who.name} 请求在受保护环境 {env} {verb} {service}/{process}", service=service, env=env,
            payload={"service": service, "env": env, "process": process, "action": action, "hours": hours,
                     "executor": "api", "by": who.name},
            requested_by=who.name, timeout_s=(await rt.registry.config("approvals")).timeout_minutes * 60)
        await rt.gate.announce(approval)
        return {"instance": await rt.controller.get(service, env, process), "approval": approval}
    return {"instance": await perform(rt, action, service, env, process, hours, who.name), "approval": None}


async def perform(rt: Runtime, action: str, service: str, env: str, process: str, hours: float | None, by: str) -> dict:
    """真正执行进程动作。审批放行后（approvals 路由）也调它。"""
    if action == "start":
        return await rt.controller.start(service, env, process, by=by, lease_hours=hours)
    if action == "stop":
        return await rt.controller.stop(service, env, process, by=by)
    return await rt.controller.renew(service, env, process, hours)


@router.get("/envs/{env}/processes/{process}/logs")
async def process_logs(service: str, env: str, process: str, lines: int = 200, rt: Runtime = RT, _: Caller = WHO):
    return {"lines": await rt.controller.logs(service, env, process, lines)}
