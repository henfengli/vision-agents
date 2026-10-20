"""服务×环境的只读观察：配置文件、git 状态。API（服务页）与 agent 工具（service_info）共用。

读配置文件只允许读该服务该环境声明过的文件——路径来自定义，不来自请求，
避免控制台/模型借此读任意文件。
"""

from __future__ import annotations

import os
import subprocess

from ..domain import Rejected, ServiceView

MAX_CONFIG_BYTES = 256 * 1024
_SECRET_HINTS = ("password", "passwd", "secret", "token", "apikey", "api_key", "access_key", "private_key")


def config_files(view: ServiceView) -> list[dict]:
    """[{canonical, path, exists, size}]"""
    out = []
    for c in view.config_files:
        try:
            st = os.stat(c["path"])
            out.append({**c, "exists": True, "size": st.st_size})
        except OSError:
            out.append({**c, "exists": False, "size": None})
    return out


def read_config(view: ServiceView, path: str, mask_secrets: bool = True) -> str:
    """读本环境声明过的配置文件（path 可以是真实路径或 canonical）。"""
    match = next((c for c in view.config_files if path in (c["path"], c["canonical"])), None)
    if match is None:
        raise Rejected("not_found", f"{path} 不是服务 {view.service} 在 {view.env} 声明的配置文件", 404)
    try:
        with open(match["path"], "rb") as f:
            raw = f.read(MAX_CONFIG_BYTES + 1)
    except OSError as e:
        raise Rejected("not_found", f"配置文件不可读：{match['path']}（{e.strerror}）", 404) from e
    text = raw[:MAX_CONFIG_BYTES].decode("utf-8", errors="replace")
    if len(raw) > MAX_CONFIG_BYTES:
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
        r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def git_state(path: str) -> dict | None:
    """{branch, commit, dirty, committed_at}；不是 git 仓库返回 None。"""
    head = _git(path, "log", "-1", "--format=%h%x00%cI")
    if not head:
        return None
    commit, _, at = head.partition("\x00")
    branch = _git(path, "rev-parse", "--abbrev-ref", "HEAD") or ""
    dirty = bool(_git(path, "status", "--porcelain", "--untracked-files=no"))
    return {"branch": branch, "commit": commit, "dirty": dirty, "committed_at": at}


def git_log(path: str, n: int = 10) -> str:
    return _git(path, "log", f"-{n}", "--format=%h %cs %an %s") or "（不是 git 仓库或无提交）"


def view_dict(view: ServiceView) -> dict:
    """API 的 ServiceView 形状。"""
    base = view.code_paths[0] if view.code_paths else view.root
    return {"service": view.service, "env": view.env, "root": view.root, "code_paths": view.code_paths,
            "hosts": view.hosts, "readonly_dsn": _dsn_hint(view.readonly_dsn), "config_files": config_files(view),
            "profile": view.profile, "git": git_state(base) if base else None}


def _dsn_hint(dsn: str | None) -> str | None:
    """页面只显示连到哪，不显示口令。"""
    if not dsn:
        return None
    if "@" in dsn and "://" in dsn:
        scheme, _, rest = dsn.partition("://")
        creds, _, host = rest.rpartition("@")
        user = creds.split(":")[0]
        return f"{scheme}://{user}:***@{host}"
    return dsn
