"""MCP 桥：内部 MCP 服务器的工具加载（可选依赖 langchain-mcp-adapters）。

内网 MCP 的价值不是接外部 SaaS，而是给内部服务一个带 schema 的类型化
接口（Dagster GraphQL、config-center API 等）。未安装适配器或未配置服务器时为空操作——链路不断。

工具和别的工具一样绑定到运行的 服务×环境（部署配置里每个 server 可写两个平台字段，其余原样交给适配器）：

    mcp_servers:
      dagster:
        transport: stdio
        command: python
        args: [/opt/agent-platform/mcp_servers/dagster_mcp.py]
        service: dagster                       # 只在 dagster 的运行里可用
        envs:                                  # 每个环境一份连接（深合并到上面），调用按运行的环境路由
          prod: {env: {DAGSTER_URL: "http://10.0.0.11:3000"}}
          test: {env: {DAGSTER_URL: "http://10.0.1.11:3001"}}

不写 envs 的 server 只有一份连接、不分环境；不写 service 的对所有服务可用。
"""

from __future__ import annotations

import logging
from typing import Any

from ...config import deep_merge
from .. import scope as run_scope

log = logging.getLogger(__name__)

_PLATFORM_KEYS = ("service", "envs")


def connections(servers: dict[str, dict]) -> tuple[dict[str, dict], dict[str, tuple[str, str | None, str | None]]]:
    """部署配置 → (适配器的连接表, {连接名: (server, 服务, 环境)})。纯函数。"""
    conns: dict[str, dict] = {}
    owners: dict[str, tuple[str, str | None, str | None]] = {}
    for name, cfg in servers.items():
        base = {k: v for k, v in cfg.items() if k not in _PLATFORM_KEYS}
        service = cfg.get("service")
        per_env = cfg.get("envs") or {}
        if not per_env:
            conns[name] = base
            owners[name] = (name, service, None)
            continue
        for env, overlay in per_env.items():
            key = f"{name}@{env}"
            conns[key] = deep_merge(base, overlay or {})
            owners[key] = (name, service, env)
    return conns, owners


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", str(p)) if isinstance(p, dict) else str(p) for p in content)
    return str(content)


def route(name: str, service: str | None, by_env: dict[str | None, Any], sample: Any) -> Any:
    """同名工具的各环境版本 → 一个按 RunScope 路由的工具（签名里没有 service/env）。"""
    from langchain_core.tools import StructuredTool

    envs = sorted(e for e in by_env if e)
    notes = [f"仅用于服务 {service}"] if service else []
    if envs:
        notes.append(f"按运行的环境连接（{'、'.join(envs)}）")

    async def call(**kwargs: Any) -> str:
        sc = run_scope.maybe_current()
        if sc is None:
            return f"[不可用] {name} 只能在运行里调用"
        if service and sc.service != service:
            return f"[不可用] {name} 只用于服务 {service}，本运行是 {sc.service or '平台任务'}"
        tool = by_env.get(None) if None in by_env else by_env.get(sc.env)
        if tool is None:
            return f"[不可用] {name} 没有配置 {sc.env} 环境的连接（已配置：{'、'.join(envs)}）"
        return _text(await tool.ainvoke(kwargs))

    description = (sample.description or "") + (f"\n（{'；'.join(notes)}）" if notes else "")
    return StructuredTool(name=name, description=description, args_schema=sample.args_schema, coroutine=call)


async def load_mcp_tools(servers: dict[str, dict]) -> list:
    """连接全部配置的 MCP server，返回按 服务×环境 路由的 LangChain 工具列表。"""
    if not servers:
        return []
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        log.warning("配置了 mcp_servers 但未安装 langchain-mcp-adapters，跳过")
        return []
    conns, owners = connections(servers)
    try:
        client = MultiServerMCPClient(conns)
        grouped: dict[str, dict] = {}
        for key, (server, service, env) in owners.items():
            for t in await client.get_tools(server_name=key):
                slot = grouped.setdefault(t.name, {"server": server, "service": service, "by_env": {}, "sample": t})
                if slot["server"] != server:
                    log.warning("MCP 工具 %s 在 %s 与 %s 里重名，只保留前者", t.name, slot["server"], server)
                    continue
                slot["by_env"][env] = t
        tools = [route(n, g["service"], g["by_env"], g["sample"]) for n, g in grouped.items()]
        log.info("MCP 加载 %d 个工具（%d 个 server，%d 个连接）", len(tools), len(servers), len(conns))
        return tools
    except Exception:  # noqa: BLE001 —— MCP 不可用不阻断主流程
        log.exception("MCP 工具加载失败")
        return []
