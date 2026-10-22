"""MCP 桥：MCP server 的工具加载（可选依赖 langchain-mcp-adapters）。两种来源：

1. 平台 MCP（部署配置 mcp_servers）：通用能力，比如浏览器。角色里写工具名或 "mcp:<server>" 引用。
2. 服务 MCP（服务定义的 mcp，见 ServiceMcp）：某个服务特有的能力，比如 dagster 的 GraphQL。
   不用写进角色：运行在这个服务上，工具就自动出现（角色 service_tools=false 时不带）。

两种都绑定到运行的 服务×环境：每个环境一份连接，同名工具合成一个，调用时按 RunScope 路由到本次运行的环境；
没配该环境的连接就如实返回「不可用」，不会退回到别的环境。

平台 MCP 的部署配置（每个 server 可写两个平台字段，其余原样交给适配器）：

    mcp_servers:
      browser:
        transport: stdio
        command: npx
        args: ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated"]
      dagster:                                 # 也可以在部署配置里按服务限定（更推荐写进服务定义的 mcp）
        service: dagster
        envs: {prod: {env: {DAGSTER_URL: "http://10.0.0.11:3000"}}, test: {env: {DAGSTER_URL: "http://10.0.1.11:3001"}}}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from ... import credentials
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


def route(name: str, service: str | None, by_env: dict[str | None, Any], sample: Any, server: str = "") -> Any:
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
            return f"[不可用] {name} 没有配置 {sc.env} 环境的连接（已配置：{'、'.join(envs) or '无'}）"
        try:
            return _text(await tool.ainvoke(kwargs))
        except Exception as e:  # noqa: BLE001 —— MCP 侧的错误如实交给模型，不炸运行
            return f"[调用失败] {name}：{type(e).__name__}: {str(e)[:500]}"

    description = (sample.description or "") + (f"\n（{'；'.join(notes)}）" if notes else "")
    return StructuredTool(name=name, description=description, args_schema=sample.args_schema, coroutine=call,
                          metadata={"mcp_server": server, "service": service, "envs": envs})


def _expanded(conn: dict) -> dict:
    """连接配置里的 ${VAR} 在连接时才取值（口令只在 secrets.env）。
    另有两个占位：{platform} = 平台安装目录（仓库自带的 mcp_servers/ 在它下面），{platform_python} = 平台的解释器。"""
    import sys

    from ...config import CONF_ROOT
    platform = str(CONF_ROOT.resolve().parent)

    def walk(node: Any) -> Any:
        if isinstance(node, str):
            return credentials.expand(node.replace("{platform_python}", sys.executable).replace("{platform}", platform))
        if isinstance(node, dict):
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return walk(conn)


async def load_routed(conns: dict[str, dict], owners: dict[str, tuple[str, str | None, str | None]]
                      ) -> tuple[list, list[str]]:
    """逐个连接取工具（一个连不上不影响别的），按名字分组成路由工具。→ (工具, 失败的连接名)。"""
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        log.warning("配置了 MCP 但未安装 langchain-mcp-adapters，跳过")
        return [], list(conns)
    ready, failed = {}, []
    for key, conn in conns.items():
        try:
            ready[key] = _expanded(conn)
        except credentials.MissingSecret as e:
            log.warning("MCP 连接 %s 跳过：%s", key, e)
            failed.append(key)
    client = MultiServerMCPClient(ready)
    grouped: dict[str, dict] = {}
    for key in ready:
        server, service, env = owners[key]
        try:
            tools = await asyncio.wait_for(client.get_tools(server_name=key), 60)
        except Exception as e:  # noqa: BLE001 —— 单个连接失败不影响其余
            log.warning("MCP 连接 %s 取工具失败：%s", key, e)
            failed.append(key)
            continue
        for t in tools:
            slot = grouped.setdefault(t.name, {"server": server, "service": service, "by_env": {}, "sample": t})
            if slot["server"] != server:
                log.warning("MCP 工具 %s 在 %s 与 %s 里重名，只保留前者", t.name, slot["server"], server)
                continue
            slot["by_env"][env] = t
    return [route(n, g["service"], g["by_env"], g["sample"], g["server"]) for n, g in grouped.items()], failed


async def load_mcp_tools(servers: dict[str, dict]) -> list:
    """平台 MCP：连接部署配置里的全部 server，返回按 服务×环境 路由的 LangChain 工具列表。"""
    if not servers:
        return []
    conns, owners = connections(servers)
    try:
        tools, failed = await load_routed(conns, owners)
    except Exception:  # noqa: BLE001 —— MCP 不可用不阻断主流程
        log.exception("MCP 工具加载失败")
        return []
    log.info("平台 MCP 加载 %d 个工具（%d 个 server，%d 个连接，失败 %d）", len(tools), len(servers), len(conns), len(failed))
    return tools


class ServiceMcp:
    """服务 MCP：按服务定义里的 mcp 懒加载，按定义内容缓存（改了定义下次运行自动重连）。
    有连接失败时 5 分钟后重试，不会因为一次网络抖动整天缺工具。"""

    RETRY_S = 300

    def __init__(self) -> None:
        self._cache: dict[str, tuple[str, float, list, list[str]]] = {}   # 服务 → (定义指纹, 时间, 工具, 失败的连接)
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def fingerprint(svc_mcp: dict, urls: dict, envs: list[str]) -> str:
        raw = json.dumps({"mcp": svc_mcp, "urls": urls, "envs": envs}, sort_keys=True, ensure_ascii=False)
        return hashlib.sha1(raw.encode()).hexdigest()[:12]

    async def tools_for(self, service: str, svc: Any, envs: list[str]) -> tuple[list, str]:
        """→ (路由好的工具, 版本键)。svc 是 ServiceDef，envs 是该服务启用的环境。"""
        if not svc.mcp:
            return [], ""
        fp = self.fingerprint(svc.mcp, {e: svc.urls_for(e) for e in envs}, envs)
        hit = self._cache.get(service)
        if hit and hit[0] == fp and (not hit[3] or time.monotonic() - hit[1] < self.RETRY_S):
            return hit[2], fp
        async with self._locks.setdefault(service, asyncio.Lock()):
            hit = self._cache.get(service)
            if hit and hit[0] == fp and (not hit[3] or time.monotonic() - hit[1] < self.RETRY_S):
                return hit[2], fp
            conns, owners = {}, {}
            for env in envs:
                for server, conn in svc.mcp_connections(env).items():
                    key = f"{service}.{server}@{env}"
                    conns[key], owners[key] = conn, (server, service, env)
            tools, failed = await load_routed(conns, owners)
            log.info("服务 %s 的 MCP：%d 个工具（%d 个连接，失败 %d）", service, len(tools), len(conns), len(failed))
            self._cache[service] = (fp, time.monotonic(), tools, failed)
            return tools, fp

    def forget(self, service: str) -> None:
        self._cache.pop(service, None)

    def describe(self, service: str) -> dict:
        hit = self._cache.get(service)
        if hit is None:
            return {"loaded": False, "tools": [], "failed": []}
        return {"loaded": True, "failed": hit[3], "tools": [
            {"name": t.name, "description": (t.description or "").split("\n")[0][:200],
             "server": (t.metadata or {}).get("mcp_server"), "envs": (t.metadata or {}).get("envs", [])}
            for t in hit[2]]}
