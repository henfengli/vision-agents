"""节点状态：本机上各服务×环境的代码目录、git、解释器、配置路径在不在，随心跳写进 nodes 表。

控制台的接口可能由别的节点回答，这些只有部署那台主机上才看得到的东西就从这里读。
"""

from __future__ import annotations

import os
import shutil
import socket
from datetime import datetime, timezone

from .. import __version__
from ..config import Settings
from ..domain import ServiceView
from ..registry import Registry
from ..store import nodes
from . import inspect

STARTED_AT = datetime.now(timezone.utc)


def local_status(view: ServiceView) -> dict:
    python_ok = bool(shutil.which(view.python) or os.path.isfile(view.python))
    return {"root_exists": bool(view.root) and os.path.isdir(view.root), "python_ok": python_ok,
            "git": inspect.git_state(view.root) if view.root and os.path.isdir(view.root) else None,
            "configs": {c["key"]: os.path.exists(c["path"]) for c in view.config_files}}


def hosted(settings: Settings, view: ServiceView) -> bool:
    """这个服务×环境是不是部署在本节点（单机部署：都算）。"""
    return view.enabled and (not settings.node or view.node == settings.node or not view.node)


async def collect(registry: Registry, settings: Settings) -> dict:
    envs = (await registry.envs()).names
    out = {}
    for s in await registry.services():
        for env in envs:
            v = s.spec.view(s.name, env)
            if hosted(settings, v) and (v.node or not settings.node):
                out[f"{s.name}@{env}"] = local_status(v)
    return {"services": out}


async def report(registry: Registry, settings: Settings) -> None:
    await nodes.beat(settings.node or "local", host=socket.gethostname(), version=__version__,
                     started_at=STARTED_AT, info=await collect(registry, settings))


async def for_view(settings: Settings, view: ServiceView) -> dict | None:
    """接口用：部署节点的心跳 + 上报的状态。服务×环境没写节点（单机部署）时就地看本机。"""
    if view.node:
        return await nodes.get(view.node)
    return {"name": "", "host": socket.gethostname(), "online": True,
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            "info": {"services": {f"{view.service}@{view.env}": local_status(view)}}}
