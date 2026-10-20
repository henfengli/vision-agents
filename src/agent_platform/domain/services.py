"""服务：与 agent 同机部署的一个业务项目。

一份定义同时服务两件事（v5 分散在 conf/services.yaml 与 kind=domain 两处）：
- agent 看到什么：部署目录、代码目录、各环境配置文件、只读库、主机、档案
- 进程怎么起：processes（cmd/端口/租约），由 services.control 按环境启停

"服务×环境"是 agent 实际操作的单位：ServiceDef.view(env) 给出该环境的全部解析结果，
提示词、工具、页面用的都是这一份。
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

NAME_RE = re.compile(r"^[a-z][a-z0-9._-]{1,40}$")
PROCESS_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")


def instance_name(service: str, env: str, process: str) -> str:
    """进程实例名（systemd 模板实例 / 启动规格文件名）。三段都不含冒号。"""
    return f"{service}:{env}:{process}"


def render(template: str, env: str, port: int | None = None) -> str:
    return template.replace("{env}", env).replace("{port}", "" if port is None else str(port))


class ConfigFile(BaseModel):
    """固定路径 ← 每环境一份的模板。进程启动时选中环境的文件 bind 到 canonical。"""

    canonical: str
    template: str

    def path_for(self, env: str) -> str:
        return render(self.template, env)


class ProcessDef(BaseModel):
    cmd: list[str]
    workdir: str | None = None
    ports: dict[str, int] = Field(default_factory=dict)
    env_vars: dict[str, str] = Field(default_factory=dict)
    lease_hours: float | None = None          # 空 = 用平台默认租约（设置 → 进程）

    @field_validator("cmd")
    @classmethod
    def _non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("进程的启动命令不能为空")
        return v


class EnvOverride(BaseModel):
    """按环境覆盖：只写和基座不同的部分。enabled=false 表示该服务在这个环境不接收运行。"""

    enabled: bool = True
    hosts: list[str] | None = None
    readonly_dsn: str | None = None
    code_paths: list[str] | None = None
    profile: dict[str, str] = Field(default_factory=dict)


class ServiceView(BaseModel):
    """服务×环境的解析结果（基座 + 覆盖 + 渲染后的配置文件路径）。"""

    service: str
    env: str
    title: str
    enabled: bool
    root: str
    code_paths: list[str]
    hosts: list[str]
    readonly_dsn: str | None
    config_files: list[dict[str, str]]       # [{canonical, path}]
    processes: dict[str, ProcessDef]
    profile: dict[str, str]

    def prompt_block(self) -> str:
        """给 agent 的"你在哪"：服务×环境的事实清单（档案另起一块）。"""
        lines = [f"[运行环境] 服务 {self.service}（{self.title}）· 环境 {self.env}",
                 f"部署目录：{self.root or '未配置'}"]
        if self.code_paths:
            lines.append("代码目录：" + "、".join(self.code_paths))
        if self.config_files:
            lines.append("配置文件（本环境）：" + "；".join(f"{c['path']}（进程读到的路径 {c['canonical']}）" for c in self.config_files))
        lines.append("只读库：" + ("已配置，用 sql_query 查询" if self.readonly_dsn else "未配置"))
        if self.processes:
            lines.append("可启停进程：" + "、".join(self.processes) + "（service_ctl）")
        return "\n".join(lines)


class ServiceDef(BaseModel):
    title: str = ""
    description: str = ""
    root: str = ""
    code_paths: list[str] = Field(default_factory=list)
    hosts: list[str] = Field(default_factory=list)
    readonly_dsn: str | None = None
    configs: list[ConfigFile] = Field(default_factory=list)
    processes: dict[str, ProcessDef] = Field(default_factory=dict)
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

    @field_validator("profile", mode="before")
    @classmethod
    def _profile_str(cls, v: Any) -> dict[str, str]:
        if not isinstance(v, dict):
            return {}
        return {str(k): "、".join(map(str, x)) if isinstance(x, list) else str(x) for k, x in v.items() if str(x).strip()}

    def view(self, name: str, env: str) -> ServiceView:
        o = self.envs.get(env) or EnvOverride()
        code_paths = o.code_paths if o.code_paths is not None else (self.code_paths or ([self.root] if self.root else []))
        return ServiceView(
            service=name, env=env, title=self.title or name, enabled=self.enabled and o.enabled,
            root=self.root, code_paths=code_paths,
            hosts=o.hosts if o.hosts is not None else self.hosts,
            readonly_dsn=o.readonly_dsn if o.readonly_dsn is not None else self.readonly_dsn,
            config_files=[{"canonical": c.canonical, "path": c.path_for(env)} for c in self.configs],
            processes=self.processes, profile={**self.profile, **o.profile},
        )


def check_service_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise ValueError(f"服务名不合法：{name!r}（小写字母开头，可含数字 . _ -，2~41 字符）")
