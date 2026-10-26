"""服务×环境：agent 实际看到的东西、给 agent 用的只读配置、服务自己的 MCP 工具。

    GET  /v1/services/{s}/envs/{env}                         该环境的解析结果（代码目录、解释器、配置各是第几版、日志）
    GET  /v1/services/{s}/envs/{env}/config?path=&raw=       读给 agent 的一份配置（默认密钥打码；raw=true 原文，编辑用）
    PUT  /v1/services/{s}/envs/{env}/config                  保存 {path, content}：存成新版本；该环境的内核下次调用时重启
    GET  /v1/services/{s}/envs/{env}/config/history?path=    版本列表；…/history/{version}?path= 某一版的内容
    GET  /v1/services/{s}/tools?reload=                      服务自己声明的 MCP 工具（按环境连接）

配置存库（不是文件）：哪台主机回答这些接口都一样；执行运行的主机起内核前才把它写到本机。
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected, ServiceView
from ...services import inspect
from ...store import service_configs
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import ConfigWrite

router = APIRouter(prefix="/v1/services/{service}")


async def _view(rt: Runtime, service: str, env: str) -> ServiceView:
    view = await rt.registry.service_view(service, env)
    if view is None:
        raise Rejected.not_found(f"服务 {service}")
    return view


@router.get("/envs/{env}")
async def service_env(service: str, env: str, rt: Runtime = RT, _: Caller = WHO):
    view = await _view(rt, service, env)
    return inspect.view_dict(view, await inspect.config_status(view))


# ———————— 给 agent 用的配置 ————————

@router.get("/envs/{env}/config")
async def service_config(service: str, env: str, path: str, raw: bool = False, rt: Runtime = RT, _: Caller = WHO):
    view = await _view(rt, service, env)
    c = inspect.config_entry(view, path)
    if not raw:
        return {"path": c["path"], "key": c["key"], "content": await inspect.read_config(view, path)}
    row = await service_configs.current(service, env, c["key"])
    return {"path": c["path"], "key": c["key"], "exists": row is not None, "content": row["content"] if row else "",
            "version": row["version"] if row else None,
            "updated_by": row["updated_by"] if row else None, "updated_at": row["updated_at"] if row else None}


@router.put("/envs/{env}/config")
async def save_config(service: str, env: str, body: ConfigWrite, rt: Runtime = RT, who: Caller = WHO):
    """存成新版本（内容没变不加版本）。执行运行的主机下次起或用内核时发现版本变了，内核自动重启。"""
    view = await _view(rt, service, env)
    c = inspect.config_entry(view, body.path)
    saved = await service_configs.save(service, env, c["key"], body.content, by=who.name)
    return {"path": c["path"], "key": c["key"], **saved}


@router.get("/envs/{env}/config/history")
async def config_history(service: str, env: str, path: str, rt: Runtime = RT, _: Caller = WHO):
    c = inspect.config_entry(await _view(rt, service, env), path)
    return await service_configs.history(service, env, c["key"])


@router.get("/envs/{env}/config/history/{version}")
async def config_history_item(service: str, env: str, version: int, path: str, rt: Runtime = RT, _: Caller = WHO):
    c = inspect.config_entry(await _view(rt, service, env), path)
    row = await service_configs.at_version(service, env, c["key"], version)
    if row is None:
        raise Rejected.not_found(f"{c['path']} 的第 {version} 版")
    return {"version": row["version"], "content": row["content"], "updated_by": row["updated_by"],
            "updated_at": row["updated_at"]}


# ———————— 工具 ————————

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
