"""服务×环境的只读观察：给 agent 的配置、git 状态、接口返回的形状。API（服务页）与 agent 工具（service_info）共用。

读配置只允许读该服务该环境声明过的路径——路径来自定义，不来自请求。读到的是给 agent 的只读版（存库），
线上真实配置平台不读、不显示。
"""

from __future__ import annotations

import subprocess

from .. import credentials
from ..domain import Rejected, ServiceView
from ..store import service_configs

MAX_CONFIG_CHARS = 256 * 1024
_SECRET_HINTS = ("password", "passwd", "secret", "token", "apikey", "api_key", "access_key", "private_key")


def config_entry(view: ServiceView, path: str) -> dict:
    """path 可以是定义里的写法（key）或渲染后的路径。"""
    c = next((c for c in view.config_files if path in (c["key"], c["path"])), None)
    if c is None:
        raise Rejected("not_found", f"{path} 不是服务 {view.service} 在 {view.env} 声明的配置文件", 404)
    return c


async def config_status(view: ServiceView) -> list[dict]:
    """[{key, path, version, updated_by, updated_at, sha}]，version 为 None = 还没有填给 agent 的版本。"""
    current = await service_configs.versions(view.service, view.env)
    return [{**c, **(current.get(c["key"]) or {"version": None, "updated_by": None, "updated_at": None, "sha": ""})}
            for c in view.config_files]


async def read_config(view: ServiceView, path: str, mask_secrets: bool = True) -> str:
    c = config_entry(view, path)
    row = await service_configs.current(view.service, view.env, c["key"])
    if row is None:
        raise Rejected("not_found", f"{c['path']} 在 {view.env} 还没有填给 agent 的只读版", 404)
    text = row["content"][:MAX_CONFIG_CHARS]
    if len(row["content"]) > MAX_CONFIG_CHARS:
        text += "\n…[超过 256KB，已截断]"
    return mask(text) if mask_secrets else text


def mask(text: str) -> str:
    """把形如 key: value / KEY=value 且 key 像密钥的行的值打码。只为防止在页面/模型上下文里裸露。"""
    lines = []
    for line in text.splitlines():
        low = line.lower()
        if any(h in low for h in _SECRET_HINTS):
            for sep in ("=", ":"):
                head, s, tail = line.partition(sep)
                if s and tail.strip() and any(h in head.lower() for h in _SECRET_HINTS):
                    line = f"{head}{s}{' ' if tail.startswith(' ') else ''}***"
                    break
        lines.append(line)
    return "\n".join(lines)


def _git(path: str, *args: str) -> str | None:
    try:
        r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def git_state(path: str) -> dict | None:
    """{branch, commit, subject, dirty, committed_at}；不是 git 仓库返回 None。"""
    head = _git(path, "log", "-1", "--format=%h%x00%cI%x00%s")
    if not head:
        return None
    commit, at, subject = (head.split("\x00") + ["", ""])[:3]
    branch = _git(path, "rev-parse", "--abbrev-ref", "HEAD") or ""
    dirty = bool(_git(path, "status", "--porcelain", "--untracked-files=no"))
    return {"branch": branch, "commit": commit, "subject": subject[:200], "dirty": dirty, "committed_at": at}


def git_log(path: str, n: int = 10) -> str:
    return _git(path, "log", f"-{n}", "--format=%h %cs %an %s") or "（不是 git 仓库或无提交）"


def view_dict(view: ServiceView, configs: list[dict], node: dict | None) -> dict:
    """API 的 ServiceView 形状。node：部署节点的心跳与它上报的本服务×环境状态（代码目录、git、解释器、配置路径）。"""
    local = ((node or {}).get("info") or {}).get("services", {}).get(f"{view.service}@{view.env}") or {}
    present = local.get("configs") or {}
    return {"service": view.service, "env": view.env, "enabled": view.enabled, "python": view.python,
            "root": view.root, "code_paths": view.code_paths, "urls": view.urls, "mcp_servers": view.mcp_servers,
            "hosts": view.hosts, "databases": {k: credentials.redact_dsn(v) for k, v in view.databases.items()},
            "logs": view.logs, "profile": view.profile,
            "config_files": [{**c, "present": present.get(c["key"])} for c in configs],
            "node": {"name": view.node, "online": bool(node and node["online"]),
                     "heartbeat_at": node["heartbeat_at"] if node else None, "host": node["host"] if node else None}
            if view.node else None,
            "root_exists": local.get("root_exists"), "python_ok": local.get("python_ok"),
            "git": local.get("git"), "reported_at": node["heartbeat_at"] if node and local else None}
