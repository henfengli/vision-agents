"""项目内核与 bash 的运行规格：解释器、工作目录、给 agent 的只读配置就位、沙箱里能看到什么。

- 只读配置：控制台里按 服务×环境×路径 填的内容（存库）。起内核前写到本机数据目录 agent-conf/（700、文件 600），
  再只读 bind 到项目读配置的那个路径——线上真实配置被盖住，项目代码 import 到的是只读版
- 遮蔽：所有服务所有环境的配置文件路径、给 agent 的配置在本机的落地目录、docker socket（部署配置 hidden_paths）
- home 白名单：沙箱里 home 是空的，只挂回 代码目录、解释器所在的 conda 环境、方法目录、home_allow
- digest：解释器 + 配置版本 + 环境变量；变了内核自动重启（配置是在控制台改的，存库）
"""

from __future__ import annotations

import hashlib
import json
import os

from ..config import Settings
from ..domain import Rejected, ServiceView
from ..registry import Registry
from ..store import service_configs


def _tag(service: str, env: str, key: str) -> str:
    return hashlib.sha1(f"{service}\0{env}\0{key}".encode()).hexdigest()[:12]


def materialize(conf_dir: str, service: str, env: str, key: str, path: str, content: str) -> str:
    """把给 agent 的配置写到本机（内容没变不重写，已经 bind 进内核的文件不换 inode）。→ 本机文件路径。"""
    d = os.path.join(conf_dir, service, env)
    os.makedirs(d, mode=0o700, exist_ok=True)
    file = os.path.join(d, f"{_tag(service, env, key)}-{os.path.basename(path) or 'config'}")
    data = content.encode("utf-8")
    try:
        with open(file, "rb") as f:
            if f.read() == data:
                return file
    except FileNotFoundError:
        pass
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(file, flags, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return file


def python_dirs(python: str) -> list[str]:
    """解释器所在的环境目录（conda 环境再带上 conda 根目录：包可能是硬链接或软链接到 pkgs/）。"""
    real = os.path.realpath(python) if os.path.exists(python) else python
    if not (real.startswith("/") or os.path.isabs(real)):
        return []
    prefix = os.path.dirname(os.path.dirname(real))
    out = [prefix]
    if "/envs/" in prefix:
        out.append(prefix.split("/envs/")[0])
    return out


def check_serves(settings: Settings, view: ServiceView) -> None:
    """兜底：认领时已经按环境（和 services）过滤了，这里防止别的路径在错的主机上起内核。"""
    if not settings.serves(view.service, view.env):
        raise Rejected("wrong_env", f"这台主机上的 agent 服务负责 {settings.env or '所有环境'}"
                                    f"{'（' + '、'.join(settings.services) + '）' if settings.services else ''}，"
                                    f"不执行 {view.service} 在 {view.env} 的运行")


async def sandbox_paths(registry: Registry, settings: Settings) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """bash 沙箱：(遮蔽, home 下挂回的目录)。遮蔽所有服务所有环境的配置文件；挂回本主机负责的各服务的代码目录
    （跨服务排查要能读别的服务的代码）与方法目录。"""
    envs = (await registry.envs()).names
    hidden = set(settings.hidden_paths) | {settings.agent_conf_dir}
    allow = {settings.assets_dir, *map(os.path.expanduser, settings.home_allow)}
    for s in await registry.services():
        hidden |= s.spec.secret_paths(envs)
        for env in envs:
            v = s.spec.view(s.name, env)
            if v.enabled and settings.serves(s.name, env):
                allow |= {p for p in (v.root, *v.code_paths) if p}
    return tuple(sorted(hidden)), tuple(sorted(allow))


async def runtime_spec(registry: Registry, settings: Settings, service: str, env: str) -> dict:
    """项目内核用：{service, env, python, env_vars, workdir, binds, hidden, allow, digest}。"""
    entry = await registry.service(service)
    if entry is None:
        raise Rejected.not_found(f"服务 {service}")
    view = await registry.service_view(service, env)
    if not view.enabled:
        raise Rejected("service_env_disabled", f"服务 {service} 在 {env} 环境已停用")
    check_serves(settings, view)
    binds, versions = [], []
    for c in view.config_files:
        row = await service_configs.current(service, env, c["key"])
        if row is None:
            raise Rejected("config_missing", f"{service} 在 {env} 还没有填给 agent 用的配置 {c['path']}："
                                             "到控制台 服务 → 配置文件 里填一份只读账号的版本")
        if not os.path.exists(c["path"]):
            raise Rejected("config_missing", f"配置文件 {c['path']} 在本机不存在：服务定义里 configs 的路径写错了，"
                                             "或者项目还没部署在这台主机上")
        src = materialize(settings.agent_conf_dir, service, env, c["key"], c["path"], row["content"])
        binds.append((src, c["path"]))
        versions.append(f"{c['key']}@{row['version']}")
    envs = (await registry.envs()).names
    others = {p for p in entry.spec.secret_paths(envs) if p not in {dst for _, dst in binds}}
    hidden = sorted(set(settings.hidden_paths) | {settings.agent_conf_dir} | others)
    allow = sorted({p for p in (view.root, *view.code_paths) if p} | set(python_dirs(view.python))
                   | {settings.assets_dir} | {os.path.expanduser(p) for p in settings.home_allow})
    digest = hashlib.sha1(json.dumps([view.python, versions, view.env_vars, view.root], sort_keys=True)
                          .encode()).hexdigest()[:12]
    return {"service": service, "env": env, "python": view.python, "env_vars": view.env_vars,
            "workdir": view.root or None, "binds": binds, "hidden": hidden, "allow": allow, "digest": digest}
