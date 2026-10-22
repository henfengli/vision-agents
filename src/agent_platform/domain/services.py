"""服务：与 agent 同机部署的一个业务项目（Python 项目）。

一份定义同时服务三件事：
- agent 看到什么：部署目录、代码目录、各环境配置文件、只读库、主机、档案
- 项目内核：用该环境的解释器、在该环境的代码目录、带着该环境的配置跑一段 Python（py 工具）
- 进程怎么起：processes（cmd/端口/租约），由 services.control 按环境启停

"服务×环境"是 agent 实际操作的单位：ServiceDef.view(env) 给出该环境的全部解析结果，
提示词、工具、页面用的都是这一份。

路径（root / code_paths / 配置文件两端 / python / workdir / cmd）都可以写 {env}：每个环境一份
git 工作目录（/srv/svc/board/code/{env}）时，一份定义就描述了三套代码。进程的 cmd 里还可以写
{python}（该环境的解释器）与 {port}。

envs[env].enabled 决定这个服务在该环境接不接收运行（闸门第 2 环），也决定能不能在该环境起进程和内核。
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

NAME_RE = re.compile(r"^[a-z][a-z0-9._-]{1,40}$")
PROCESS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
DEFAULT_PYTHON = "python3"


def instance_name(service: str, env: str, process: str) -> str:
    """进程实例名（systemd 模板实例 / 启动规格文件名）。三段都不含冒号。"""
    return f"{service}:{env}:{process}"


def render(template: str, env: str, port: int | None = None, python: str | None = None) -> str:
    out = template.replace("{env}", env).replace("{port}", "" if port is None else str(port))
    return out.replace("{python}", python) if python is not None else out


def _no_placeholders(v: dict[str, str]) -> dict[str, str]:
    # 启动规格是落盘的明文 JSON：口令放进该环境的配置文件（按环境隔离、bind 进进程），不走环境变量
    bad = [k for k, x in v.items() if "${" in str(x)]
    if bad:
        raise ValueError(f"环境变量不支持 ${{VAR}}：{'、'.join(bad)}（口令写进该环境的配置文件）")
    return v


class ConfigFile(BaseModel):
    """固定路径 ← 每环境一份的模板。进程和内核启动时选中环境的文件 bind 到 canonical。"""

    canonical: str
    template: str

    def path_for(self, env: str) -> str:
        return render(self.template, env)

    def canonical_for(self, env: str) -> str:
        return render(self.canonical, env)


class ProcessDef(BaseModel):
    cmd: list[str]
    workdir: str | None = None
    ports: dict[str, int] = Field(default_factory=dict)
    env_vars: dict[str, str] = Field(default_factory=dict)   # 叠加在服务级 env_vars 之上
    lease_hours: float | None = None          # 空 = 用平台默认租约（设置 → 进程）

    @field_validator("cmd")
    @classmethod
    def _non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("进程的启动命令不能为空")
        return v

    @field_validator("env_vars")
    @classmethod
    def _no_secrets(cls, v: dict[str, str]) -> dict[str, str]:
        return _no_placeholders(v)


class EnvOverride(BaseModel):
    """按环境覆盖：只写和基座不同的部分。enabled=false 表示该服务在这个环境不接收运行。"""

    enabled: bool = True
    hosts: list[str] | None = None
    readonly_dsn: str | None = None
    code_paths: list[str] | None = None
    ref: str | None = None                    # 这个环境跟踪的分支 / tag（代码同步的默认目标）
    python: str | None = None                 # 这个环境的解释器（不写跟随服务的 python）
    urls: dict[str, str] = Field(default_factory=dict)   # 按键覆盖服务的 urls
    profile: dict[str, str] = Field(default_factory=dict)


class ServiceView(BaseModel):
    """服务×环境的解析结果（基座 + 覆盖 + 渲染后的路径）。"""

    service: str
    env: str
    title: str
    enabled: bool
    root: str
    code_paths: list[str]
    repo: str
    ref: str
    python: str
    env_vars: dict[str, str]
    urls: dict[str, str]
    hosts: list[str]
    readonly_dsn: str | None
    config_files: list[dict[str, str]]       # [{canonical, path}]
    processes: dict[str, ProcessDef]
    mcp_servers: list[str]                   # 服务自己声明的 MCP server（工具在运行里自动出现）
    profile: dict[str, str]

    def prompt_block(self) -> str:
        """给 agent 的"你在哪"：服务×环境的事实清单（档案另起一块）。"""
        lines = [f"[运行环境] 服务 {self.service}（{self.title}）· 环境 {self.env}",
                 f"部署目录：{self.root or '未配置'}"]
        if self.code_paths:
            lines.append("代码目录：" + "、".join(self.code_paths))
        lines.append(f"项目 Python：{self.python}。用 py 工具在这个环境里执行代码：工作目录是部署目录、"
                     "本环境的配置文件已就位，可以直接 import 项目模块、调用项目自己的函数；变量在本会话内保留")
        if self.config_files:
            lines.append("配置文件（本环境）：" + "；".join(f"{c['path']}（进程读到的路径 {c['canonical']}）" for c in self.config_files))
            lines.append("配置文件内容用 service_info(what=config) 读（密钥已打码）；bash 里读不到配置文件原文")
        lines.append("只读库：" + ("已配置，用 sql_query 查询" if self.readonly_dsn else "未配置"))
        if self.urls:
            lines.append("地址（本环境）：" + "；".join(f"{k} = {v}" for k, v in self.urls.items()))
        if self.mcp_servers:
            lines.append("服务工具（MCP）：" + "、".join(self.mcp_servers) + "——工具已按本环境连好，直接调用")
        if self.processes:
            lines.append("可启停进程：" + "、".join(self.processes) + "（service_ctl，按需起、用完停；启动带租约）")
        return "\n".join(lines)


class ServiceDef(BaseModel):
    title: str = ""
    description: str = ""
    root: str = ""
    code_paths: list[str] = Field(default_factory=list)
    repo: str = ""                            # git 远端：代码同步（内建任务 code-sync）从这里拉到 root
    ref: str = ""                             # 默认跟踪的分支；各环境可在 envs[env].ref 覆盖
    python: str = ""                          # 项目解释器（可写 {env}，如 /srv/svc/board/venv/{env}/bin/python）；空 = python3
    env_vars: dict[str, str] = Field(default_factory=dict)   # 服务级环境变量（可写 {env}）：内核与进程都带上
    # 有名字的地址（可写 {env}）：线上部署的页面 / API、本机副本的端口……给 agent 看，也可在 mcp 配置里用 {url:名字} 引用
    urls: dict[str, str] = Field(default_factory=dict)
    hosts: list[str] = Field(default_factory=list)
    readonly_dsn: str | None = None
    configs: list[ConfigFile] = Field(default_factory=list)
    processes: dict[str, ProcessDef] = Field(default_factory=dict)
    # 服务自己的 MCP server：{名字: langchain-mcp-adapters 连接配置}，另可写 envs: {环境: 深合并的覆盖}。
    # 字符串里可写 {env}、{url:名字}、${VAR}（连接时才取值）。运行在本服务上时工具自动出现，调用按运行的环境路由
    mcp: dict[str, dict] = Field(default_factory=dict)
    envs: dict[str, EnvOverride] = Field(default_factory=dict)
    profile: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("processes")
    @classmethod
    def _process_names(cls, v: dict[str, ProcessDef]) -> dict[str, ProcessDef]:
        bad = [k for k in v if not PROCESS_RE.match(k)]
        if bad:
            raise ValueError(f"进程名不合法：{'、'.join(bad)}（小写字母开头，可含数字 _ -）")
        return v

    @field_validator("env_vars")
    @classmethod
    def _no_secrets(cls, v: dict[str, str]) -> dict[str, str]:
        return _no_placeholders(v)

    @field_validator("profile", mode="before")
    @classmethod
    def _profile_str(cls, v: Any) -> dict[str, str]:
        if not isinstance(v, dict):
            return {}
        return {str(k): "、".join(map(str, x)) if isinstance(x, list) else str(x) for k, x in v.items() if str(x).strip()}

    def view(self, name: str, env: str) -> ServiceView:
        o = self.envs.get(env) or EnvOverride()
        root = render(self.root, env)
        code_paths = o.code_paths if o.code_paths is not None else (self.code_paths or ([self.root] if self.root else []))
        python = render(o.python or self.python or DEFAULT_PYTHON, env)
        return ServiceView(
            service=name, env=env, title=self.title or name, enabled=self.enabled and o.enabled,
            root=root, code_paths=[render(p, env) for p in code_paths],
            repo=self.repo, ref=o.ref if o.ref is not None else self.ref,
            python=python, env_vars={k: render(v, env, python=python) for k, v in self.env_vars.items()},
            urls=self.urls_for(env), hosts=o.hosts if o.hosts is not None else self.hosts,
            readonly_dsn=o.readonly_dsn if o.readonly_dsn is not None else self.readonly_dsn,
            config_files=[{"canonical": c.canonical_for(env), "path": c.path_for(env)} for c in self.configs],
            processes=self.processes, mcp_servers=list(self.mcp), profile={**self.profile, **o.profile},
        )

    def urls_for(self, env: str) -> dict[str, str]:
        o = self.envs.get(env) or EnvOverride()
        port = {name: p.ports.get(env) for name, p in self.processes.items()}
        out = {}
        for k, v in {**self.urls, **o.urls}.items():
            text = render(v, env)
            for proc, pnum in port.items():       # {port:进程名}：该进程在这个环境的端口
                text = text.replace("{port:" + proc + "}", "" if pnum is None else str(pnum))
            out[k] = text
        return out

    def mcp_connections(self, env: str) -> dict[str, dict]:
        """这个环境的 MCP 连接配置：基座深合并 envs[env]，再渲染 {env} 与 {url:名字}。${VAR} 留给连接时展开。"""
        urls = self.urls_for(env)

        def fill(node: Any) -> Any:
            if isinstance(node, str):
                text = render(node, env)
                for k, v in urls.items():
                    text = text.replace("{url:" + k + "}", v)
                return text
            if isinstance(node, dict):
                return {k: fill(v) for k, v in node.items()}
            if isinstance(node, list):
                return [fill(v) for v in node]
            return node

        out = {}
        for server, cfg in self.mcp.items():
            base = {k: v for k, v in cfg.items() if k != "envs"}
            per_env = (cfg.get("envs") or {})
            if per_env and env not in per_env and cfg.get("only_listed_envs", True):
                continue                          # 写了 envs 就只在列出的环境可用：没配的环境不会悄悄连到别处
            out[server] = fill(_deep_merge({k: v for k, v in base.items() if k != "only_listed_envs"},
                                           per_env.get(env) or {}))
        return out

    def secret_paths(self, envs: list[str]) -> set[str]:
        """所有环境的配置文件（两端）：bash 沙箱里一律遮蔽，内容只能经 service_info 打码后读。"""
        return {p for c in self.configs for env in envs for p in (c.path_for(env), c.canonical_for(env))}


def _deep_merge(base: dict, overlay: dict) -> dict:
    merged = dict(base)
    for k, v in overlay.items():
        merged[k] = _deep_merge(merged[k], v) if isinstance(merged.get(k), dict) and isinstance(v, dict) else v
    return merged


def check_service_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise ValueError(f"服务名不合法：{name!r}（小写字母开头，可含数字 . _ -，2~41 字符）")
