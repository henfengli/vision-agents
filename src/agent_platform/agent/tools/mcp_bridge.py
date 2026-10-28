"""MCP 桥：MCP server 的工具加载（可选依赖 langchain-mcp-adapters）。两种来源：

1. 平台 MCP（部署配置 mcp_servers）：通用能力，比如浏览器。角色里写工具名或 "mcp:<server>" 引用。
2. 服务 MCP（服务定义的 mcp，见 ServiceMcp）：某个服务特有的能力，比如 dagster 的 GraphQL。
   不用写进角色：运行在这个服务上，工具就自动出现（角色 service_tools=false 时不带）。

两种都绑定到运行的 服务×环境：每个环境一份连接，同名工具合成一个，调用时按 RunScope 路由到本次运行的环境；
没配该环境的连接就如实返回「不可用」，不会退回到别的环境。

会话常驻（McpSessions）：适配器默认每次工具调用新开一条连接（stdio 就是每次新起一个进程），有状态的 server
（浏览器：先 navigate 再 snapshot）状态全丢。这里按 会话×连接 保持一条常驻 MCP 会话：同一个会话里的调用
落在同一条连接上；空闲 30 分钟回收，同时最多 16 条（超了回收最久没用的），连接断了下次调用自动重连。
取工具列表仍是一次性连接（启动时 / 服务定义变了时）。

平台 MCP 的部署配置（每个 server 可写几个平台字段，其余原样交给适配器）：service / envs（按服务限定、按环境分连接），
sandbox / memory / allow（stdio 进程跑在沙箱里、限内存，见 containment）：

    mcp_servers:
      browser:                                 # 浏览器能在自己的进程里执行任意代码：一定进沙箱
        transport: stdio
        command: node
        args: ["{platform}/browser/node_modules/@playwright/mcp/cli.js", "--headless", "--isolated", "--browser", "chromium"]
        sandbox: true
        memory: 4G
        allow: ["{platform}/browser"]
      dagster:                                 # 也可以在部署配置里按服务限定（更推荐写进服务定义的 mcp）
        service: dagster
        envs: {prod: {env: {DAGSTER_URL: "http://10.0.0.11:3000"}}, test: {env: {DAGSTER_URL: "http://10.0.1.11:3001"}}}
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable

from ... import credentials
from ...config import deep_merge
from .. import scope as run_scope

log = logging.getLogger(__name__)

# 平台字段（不交给适配器）：service / envs 见 connections；sandbox / memory / allow 见 containment
_PLATFORM_KEYS = ("service", "envs", "sandbox", "memory", "allow")


@dataclass(frozen=True)
class Endpoint:
    """一条 MCP 连接：连接名（如 dagster@prod、board.api@test）+ 已展开 ${VAR} 的适配器连接配置。"""

    key: str
    conn: dict


# ———————— 常驻会话 ————————

class _Held:
    """一条常驻 MCP 会话。连接的上下文（anyio 取消域）必须在同一个 task 里进出，所以单独起一个 task 持有它，
    调用方在别的 task 里直接用 session 发请求。"""

    def __init__(self, conn: dict):
        self.conn = conn
        self.session: Any = None
        self.used = time.monotonic()
        self.busy = 0
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._error: BaseException | None = None
        self._task: asyncio.Task | None = None

    @property
    def alive(self) -> bool:
        return self.session is not None and self._task is not None and not self._task.done()

    async def open(self, timeout: float) -> None:
        self._task = asyncio.create_task(self._hold())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except (TimeoutError, asyncio.TimeoutError):
            await self.close()
            raise RuntimeError(f"连接 MCP server 超时（{timeout:.0f}s）") from None
        if self.session is None:
            e = self._error
            raise RuntimeError(f"连接 MCP server 失败：{type(e).__name__}: {e}" if e else "连接 MCP server 失败")

    async def _hold(self) -> None:
        from langchain_mcp_adapters.sessions import create_session
        try:
            async with create_session(self.conn) as session:
                await session.initialize()
                self.session = session
                self._ready.set()
                await self._stop.wait()
        except Exception as e:  # noqa: BLE001 —— 连不上 / 中途断开：记下原因，下次调用重连
            self._error = e
        finally:
            self.session = None
            self._ready.set()

    async def close(self) -> None:
        self._stop.set()
        if self._task is None or self._task.done():
            return
        try:
            await asyncio.wait_for(asyncio.shield(self._task), 10)
        except BaseException:  # noqa: BLE001 —— 关不干净就强制取消
            self._task.cancel()


class McpSessions:
    IDLE_S = 1800
    MAX = 16
    CONNECT_S = 60

    def __init__(self) -> None:
        self._held: dict[tuple[str, str], _Held] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._reaper: asyncio.Task | None = None

    async def call(self, owner: str, ep: Endpoint, tool: str, args: dict) -> str:
        """owner = 会话 id：同一个会话对同一条连接的调用共用一条 MCP 会话。"""
        key = (owner, ep.key)
        held = await self._get(key, ep)
        held.busy += 1
        try:
            if held.session is None:
                raise RuntimeError("MCP 连接已断开（下次调用会重连）")
            result = await held.session.call_tool(tool, args)
        except Exception:
            await self._drop(key)            # 连接坏了：扔掉，下次调用重连
            raise
        finally:
            held.busy -= 1
            held.used = time.monotonic()
        return result_text(result)

    async def _get(self, key: tuple[str, str], ep: Endpoint) -> _Held:
        async with self._locks.setdefault(key, asyncio.Lock()):
            held = self._held.get(key)
            if held is not None and (not held.alive or held.conn != ep.conn):
                await self._drop(key)        # 断了，或者连接配置改了（服务定义改了）
                held = None
            if held is None:
                await self._make_room()
                held = _Held(ep.conn)
                await held.open(self.CONNECT_S)
                self._held[key] = held
                if self._reaper is None or self._reaper.done():
                    self._reaper = asyncio.create_task(self._reap_forever())
                log.info("MCP 常驻会话已建立 %s（会话 %s）", key[1], key[0])
            held.used = time.monotonic()
            return held

    async def _drop(self, key: tuple[str, str]) -> None:
        held = self._held.pop(key, None)
        if held is not None:
            await held.close()

    async def _make_room(self) -> None:
        while len(self._held) >= self.MAX:
            idle = [k for k, h in self._held.items() if not h.busy] or list(self._held)
            oldest = min(idle, key=lambda k: self._held[k].used)
            log.info("MCP 常驻会话到上限 %d，回收最久没用的 %s", self.MAX, oldest)
            await self._drop(oldest)

    async def _reap_forever(self) -> None:
        while self._held:
            await asyncio.sleep(60)
            now = time.monotonic()
            for key, h in list(self._held.items()):
                if not h.alive or (not h.busy and now - h.used > self.IDLE_S):
                    await self._drop(key)
                    self._locks.pop(key, None)

    async def close(self) -> None:
        for key in list(self._held):
            await self._drop(key)
        if self._reaper is not None:
            self._reaper.cancel()

    def listing(self) -> list[dict]:
        now = time.monotonic()
        return [{"session": o, "connection": c, "alive": h.alive, "idle_s": int(now - h.used)}
                for (o, c), h in self._held.items()]


SESSIONS = McpSessions()        # 进程内唯一；runtime 关闭时 close()


def result_text(result: Any) -> str:
    """MCP 的 CallToolResult → 给模型的文本。图片等二进制只留一句说明。"""
    parts: list[str] = []
    for c in getattr(result, "content", None) or []:
        kind = getattr(c, "type", "")
        if kind == "text":
            parts.append(c.text)
        elif kind == "resource":
            res = c.resource
            parts.append(getattr(res, "text", None) or f"[资源 {getattr(res, 'uri', '')}（二进制，未展示）]")
        elif kind == "resource_link":
            parts.append(f"[资源链接 {getattr(c, 'uri', '')}]")
        else:
            parts.append(f"[{kind or '未知'} 内容（{getattr(c, 'mimeType', '')}），未展示]")
    if not parts and getattr(result, "structuredContent", None) is not None:
        parts.append(json.dumps(result.structuredContent, ensure_ascii=False))
    text = "\n".join(parts)
    return f"[MCP 报错] {text}" if getattr(result, "isError", False) else text


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


def route(name: str, service: str | None, by_env: dict[str | None, Endpoint], sample: Any, server: str = "",
          sessions: McpSessions | None = None) -> Any:
    """同名工具的各环境连接 → 一个按 RunScope 路由的工具（签名里没有 service/env）。
    调用走常驻会话：同一个会话里对同一条连接的调用落在同一条 MCP 会话上。"""
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
        ep = by_env.get(None) if None in by_env else by_env.get(sc.env)
        if ep is None:
            return f"[不可用] {name} 没有配置 {sc.env} 环境的连接（已配置：{'、'.join(envs) or '无'}）"
        try:
            return await (sessions or SESSIONS).call(sc.session_id, ep, name, kwargs)
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
    """逐个连接取工具清单（一次性连接；一个连不上不影响别的），按名字分组成路由工具。→ (工具, 失败的连接名)。"""
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
            slot["by_env"][env] = Endpoint(key, ready[key])
    return [route(n, g["service"], g["by_env"], g["sample"], g["server"]) for n, g in grouped.items()], failed


Contain = Callable[[str, dict, dict], "dict | None"]


def containment(settings: Any, hidden: set[str] | tuple[str, ...] = ()) -> Contain:
    """平台 MCP 的 stdio 进程怎么起（部署配置里每个 server 可写的平台字段）：

    - sandbox: true —— 跑在和 bash 同一套的 bwrap 沙箱里：home 换成空目录（只挂回 allow 和 home_allow，只读），
      所有服务所有环境的配置、平台密钥目录、~/.ssh、docker socket 遮蔽，/run/user 换成空目录（碰不到 systemd 用户总线），
      工作区 scratch 可写；网络照常。浏览器这类 server 能在自己的进程里执行任意代码（Playwright 的 browser_run_code_unsafe），
      不进沙箱就等于让模型绕开全部遮蔽。没有 bwrap 且 require_sandbox 时这个 server 不加载
    - memory: 4G —— 套一个 systemd 用户 scope（agent.slice 下，limits.enabled 时）：超了只杀它，不波及同机的线上服务
    - allow —— 沙箱里要看得到的 home 下的目录（装在 home 下的 node、浏览器）

    字符串里还可以写 {data}（平台数据目录）。不写这几个字段的 server 照旧直接起。返回 None = 不加载。"""
    from . import sandbox as sb

    data = str(settings.data_dir)

    def fill(node: Any) -> Any:
        if isinstance(node, str):
            return node.replace("{data}", data)
        if isinstance(node, dict):
            return {k: fill(v) for k, v in node.items()}
        if isinstance(node, list):
            return [fill(v) for v in node]
        return node

    def place(text: str) -> str:
        from ...config import CONF_ROOT
        text = fill(text).replace("{platform}", str(CONF_ROOT.resolve().parent))
        return os.path.expanduser(text)

    def wrap(name: str, cfg: dict, conn: dict) -> dict | None:
        conn = fill(conn)
        sandboxed, memory = bool(cfg.get("sandbox")), str(cfg.get("memory") or "")
        if conn.get("transport", "stdio") != "stdio" or not (sandboxed or memory) or not conn.get("command"):
            return conn
        argv = [str(conn["command"]), *map(str, conn.get("args") or [])]
        env = dict(conn.get("env") or {})
        if sandboxed:
            if not sb.has_bwrap():
                if settings.require_sandbox:
                    log.warning("平台 MCP %s 要求沙箱但本机没有 bwrap（require_sandbox），不加载", name)
                    return None
                log.warning("平台 MCP %s：本机没有 bwrap，直接起（不隔离，只适合开发机）", name)
            else:
                allow = [place(p) for p in (cfg.get("allow") or [])] + [os.path.expanduser(p) for p in settings.home_allow]
                os.makedirs(settings.scratch_dir, exist_ok=True)
                # 当前目录放在工作区：浏览器的「工作区」（能上传的文件、默认输出）就是它
                argv = sb.bwrap_argv(argv, scratch=settings.scratch_dir, hidden=sorted(hidden), allow=allow,
                                     workdir=settings.scratch_dir)
        if memory and settings.limits.enabled:
            argv = sb.limit_argv(argv, settings.limits, memory=memory)
            # systemd-run 要从环境变量找到用户总线；适配器只给子进程一小撮默认环境变量（进 bwrap 时再去掉）
            env = sb.scope_env(env, settings.limits)
        out = {**conn, "command": argv[0], "args": argv[1:]}
        if env:
            out["env"] = env
        return out

    return wrap


async def load_mcp_tools(servers: dict[str, dict], contain: Contain | None = None) -> list:
    """平台 MCP：连接部署配置里的全部 server，返回按 服务×环境 路由的 LangChain 工具列表。
    contain：stdio 进程怎么起（沙箱、内存上限，见 containment）。"""
    if not servers:
        return []
    conns, owners = connections(servers)
    if contain is not None:
        wrapped = {k: contain(owners[k][0], servers[owners[k][0]], c) for k, c in conns.items()}
        conns = {k: c for k, c in wrapped.items() if c is not None}
        owners = {k: owners[k] for k in conns}
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
