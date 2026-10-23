"""服务×环境：agent 实际看到的东西、进程启停、代码同步与配置文件。

    GET  /v1/services/{s}/envs/{env}                               该环境的解析结果（目录、解释器、配置文件、git、档案）
    GET  /v1/services/{s}/envs/{env}/config?path=&raw=             读本环境声明过的配置文件（默认密钥打码；raw=true 原文 + sha + 上游状态，编辑用）
    PUT  /v1/services/{s}/envs/{env}/config                        保存配置文件 {path, content, sha}：旧内容先备份；内核重启
    POST /v1/services/{s}/envs/{env}/config/ack                    {path} 已按上游核对过，不用改
    GET  /v1/services/{s}/envs/{env}/config/history?path=          备份列表；…/history/{id}?path= 某份备份的内容
    GET  /v1/services/{s}/envs/{env}/sync                          代码同步状态：当前提交、远端、步骤、配置是否待更新
    POST /v1/services/{s}/sync                                     立即同步 {envs?}：各环境各提交一次 code-sync
    GET  /v1/services/{s}/processes                                全部 环境×进程 的实例状态
    GET  /v1/services/{s}/tools?reload=                            服务自己声明的 MCP 工具（按环境连接）
    POST /v1/services/{s}/envs/{env}/processes/{p}/start|stop|renew  启停 / 续期
    GET  /v1/services/{s}/envs/{env}/processes/{p}/logs?lines=
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected, RunRequest, RunTrigger, ServiceView
from ...services import configfiles, inspect
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import ConfigAck, ConfigWrite, ProcessBody, SyncBody

router = APIRouter(prefix="/v1/services/{service}")


async def _view(rt: Runtime, service: str, env: str) -> ServiceView:
    view = await rt.registry.service_view(service, env)
    if view is None:
        raise Rejected.not_found(f"服务 {service}")
    return view


@router.get("/envs/{env}")
async def service_env(service: str, env: str, rt: Runtime = RT, _: Caller = WHO):
    return inspect.view_dict(await _view(rt, service, env))


# ———————— 配置文件 ————————

@router.get("/envs/{env}/config")
async def service_config(service: str, env: str, path: str, raw: bool = False, rt: Runtime = RT, _: Caller = WHO):
    view = await _view(rt, service, env)
    if not raw:
        return {"path": path, "content": inspect.read_config(view, path)}
    return {**configfiles.read(view, path), "upstream_state": await rt.code_sync.config_state(view, path)}


@router.put("/envs/{env}/config")
async def save_config(service: str, env: str, body: ConfigWrite, rt: Runtime = RT, who: Caller = WHO):
    """写本环境的配置文件；之后该服务×环境的项目内核重启，在跑的进程要重启才读到新配置（running 里列出）。"""
    view = await _view(rt, service, env)
    saved = configfiles.write(view, body.path, body.content, body.sha, who.name, rt.settings.config_history_dir)
    await rt.code_sync.ack_config(view, body.path, who.name)
    await rt.kernels.drop(service, env)
    running = [i["process"] for i in await rt.controller.list(service)
               if i["env"] == env and i["state"] in ("running", "starting")] if view.processes else []
    return {**saved, "running": running}


@router.post("/envs/{env}/config/ack")
async def ack_config(service: str, env: str, body: ConfigAck, rt: Runtime = RT, who: Caller = WHO):
    view = await _view(rt, service, env)
    configfiles.entry(view, body.path)
    await rt.code_sync.ack_config(view, body.path, who.name)
    return {"ok": True}


@router.get("/envs/{env}/config/history")
async def config_history(service: str, env: str, path: str, rt: Runtime = RT, _: Caller = WHO):
    return configfiles.history(await _view(rt, service, env), path, rt.settings.config_history_dir)


@router.get("/envs/{env}/config/history/{version_id}")
async def config_history_item(service: str, env: str, version_id: str, path: str, rt: Runtime = RT, _: Caller = WHO):
    view = await _view(rt, service, env)
    return {"id": version_id, "content": configfiles.history_content(view, path, version_id,
                                                                     rt.settings.config_history_dir)}


# ———————— 代码同步 ————————

@router.get("/envs/{env}/sync")
async def sync_status(service: str, env: str, rt: Runtime = RT, _: Caller = WHO):
    return await rt.code_sync.status(service, env)


@router.post("/sync", status_code=202)
async def sync_now(service: str, body: SyncBody | None = None, rt: Runtime = RT, who: Caller = WHO):
    """立即同步：每个环境提交一次 code-sync。→ [{env, run_id, status, error}]"""
    s = await rt.registry.service(service)
    if s is None:
        raise Rejected.not_found(f"服务 {service}")
    envs = body.envs if body and body.envs else [e for e in (await rt.registry.envs()).names
                                                 if s.spec.view(service, e).enabled]
    trigger = RunTrigger(type="web" if who.kind == "user" else "api", caller=who.name)
    out = []
    for env in envs:
        try:
            req = RunRequest(task="code-sync", service=service, env=env,
                             input={"force": True} if body and body.force else {})
            accepted = await rt.submitter.submit(req, trigger=trigger, caller=who)
            out.append({"env": env, "run_id": accepted.run_id, "status": accepted.status, "error": None})
        except Rejected as e:
            out.append({"env": env, "run_id": None, "status": "rejected", "error": {"code": e.code, "message": e.message}})
    return out


# ———————— 进程与工具 ————————

@router.get("/processes")
async def processes(service: str, rt: Runtime = RT, _: Caller = WHO):
    return await rt.controller.list(service)


@router.get("/tools")
async def service_tools(service: str, reload: bool = False, rt: Runtime = RT, _: Caller = WHO):
    """服务自己声明的 MCP 工具：{servers, loaded, tools: [{name, description, server, envs}], failed}。
    没加载过（还没有运行用到）时现连一次；reload=true 强制重连（改了 MCP 服务端之后）。"""
    from ...orchestration.pipeline import service_mcp_tools

    s = await rt.registry.service(service)
    if s is None:
        raise Rejected.not_found(f"服务 {service}")
    if reload:
        rt.service_mcp.forget(service)
    if s.spec.mcp:
        await service_mcp_tools(rt.registry, rt.service_mcp, service)
    return {"servers": list(s.spec.mcp), **rt.service_mcp.describe(service)}


@router.post("/envs/{env}/processes/{process}/{action}")
async def process_action(service: str, env: str, process: str, action: str, body: ProcessBody | None = None,
                         rt: Runtime = RT, who: Caller = WHO):
    """返回 {instance}：动作执行后的实例状态。"""
    if action not in ("start", "stop", "renew"):
        raise Rejected.not_found(f"动作 {action}")
    hours = body.hours if body else None
    if action == "start":
        await rt.controller.ensure_startable(service, env)
        instance = await rt.controller.start(service, env, process, by=who.name, lease_hours=hours)
    elif action == "stop":
        instance = await rt.controller.stop(service, env, process, by=who.name)
    else:
        instance = await rt.controller.renew(service, env, process, hours)
    return {"instance": instance}


@router.get("/envs/{env}/processes/{process}/logs")
async def process_logs(service: str, env: str, process: str, lines: int = 200, rt: Runtime = RT, _: Caller = WHO):
    return {"lines": await rt.controller.logs(service, env, process, lines)}
