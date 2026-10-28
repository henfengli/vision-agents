"""服务：agent 所在主机上实际部署着的一个业务项目（Python 项目）。

一份定义同时服务两件事：
- agent 看到什么：线上的代码目录、配置（生产是给 agent 的只读版，测试是真实的）、只读库、日志、档案
- 项目内核：用该环境的解释器、在该环境的代码目录、带着该环境的配置跑一段 Python（py 工具）

同机部署：项目部署在哪台主机上，那台主机上就装着管这个环境的 agent 服务（部署配置 env / services）。
这个服务×环境的运行由它执行，读的是线上那份代码、用的是线上那套解释器。
过渡期可以由别的环境的部署主机代管（部署配置 remote_envs）：路径按执行主机解析（代码是那台上的那份，当参考），
日志与主机状况不可用，配置一律用只读版（prompt_block 的 executor）。
平台不改代码、不装依赖、不启停业务进程。

配置文件（configs）写的是项目读配置的路径，比如 ~/deploy/vision-board/vision_board/settings-{env}.py。
受保护的环境（生产）里真实配置 agent 看不到：bash 里被遮蔽；项目内核启动时，平台把控制台里填的只读版
（存库，按 服务×环境×路径 带版本）盖在这个路径上，项目代码照常 import、照常连库，连上去的是只读账号。
不受保护的环境（测试）直接用真实配置：不遮、不替换，提示词要求库只读。生产的配置在测试的运行里照样遮蔽。

"服务×环境"是 agent 实际操作的单位：ServiceDef.view(env) 给出该环境的全部解析结果，
提示词、工具、页面用的都是这一份。路径可以写 {env}；以 ~ 开头的值展开成平台用户的 home
（平台和项目是同一个用户部署的）。

envs[env].enabled 决定这个服务在该环境接不接收运行（闸门第 2 环），也决定能不能在该环境起内核。
"""

from __future__ import annotations

import os
import re
from typing import Any

from pydantic import BaseModel, Field, field_validator

NAME_RE = re.compile(r"^[a-z][a-z0-9._-]{1,40}$")
LOG_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
DEFAULT_PYTHON = "python3"


def render(template: str, env: str, python: str | None = None) -> str:
    out = template.replace("{env}", env)
    if python is not None:
        out = out.replace("{python}", python)
    return os.path.expanduser(out) if out.startswith("~") else out


DB_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,30}$")
_DB_LABELS = {"postgres": "PostgreSQL", "mysql": "MySQL/MariaDB", "doris": "Doris", "clickhouse": "ClickHouse",
              "mongo": "MongoDB"}
# 连接串的 scheme → 库的类型（agent/tools/db.py 按类型选驱动与只读手段）
DB_SCHEMES = {"postgresql": "postgres", "postgres": "postgres", "mysql": "mysql", "mariadb": "mysql",
              "doris": "doris", "clickhouse": "clickhouse", "clickhouses": "clickhouse",
              "mongodb": "mongo", "mongodb+srv": "mongo"}


def db_kind(url: str) -> str | None:
    """postgres / mysql / doris / clickhouse / mongo；不认识返回 None。"""
    return DB_SCHEMES.get(url.split("://", 1)[0].lower()) if "://" in url else None


def _check_databases(v: dict[str, str] | None) -> dict[str, str] | None:
    for name, url in (v or {}).items():
        if not DB_NAME_RE.match(name):
            raise ValueError(f"库名不合法：{name!r}（小写字母开头，可含数字 _ -）")
        if url and db_kind(url) is None:
            raise ValueError(f"库 {name} 的连接串类型不认识：{url.split('://')[0]}://"
                             f"（可用：{'、'.join(s + '://' for s in DB_SCHEMES)}）")
    return v


def _absolute(path: str) -> bool:
    return path.startswith(("/", "~")) or os.path.isabs(path)


LOG_PREFIXES = ("docker:", "journal:")


def _check_logs(v: dict[str, str] | None) -> dict[str, str]:
    """日志：{名字: 文件路径（可带 * 通配，取最新的那个）| docker:<容器名> | journal:<systemd 单元>}。
    值写空串 = （环境覆盖里）本环境没有这个日志。"""
    for name, target in (v or {}).items():
        if not LOG_NAME_RE.match(name):
            raise ValueError(f"日志名不合法：{name!r}（小写字母开头，可含数字 _ -）")
        prefixed = any(target.startswith(p) and len(target) > len(p) for p in LOG_PREFIXES)
        if target and not (_absolute(target) or prefixed):
            raise ValueError(f"日志 {name} 要写绝对路径（可以 ~ 开头，可带 * 通配）、docker:<容器名> 或 "
                             f"journal:<systemd 单元>，不是 {target!r}")
    return v or {}


def _no_placeholders(v: dict[str, str]) -> dict[str, str]:
    # 环境变量会出现在内核进程的环境里：口令写进给 agent 的配置文件，不走环境变量
    bad = [k for k, x in v.items() if "${" in str(x)]
    if bad:
        raise ValueError(f"环境变量不支持 ${{VAR}}：{'、'.join(bad)}（口令写进给 agent 用的配置文件）")
    return v


def _config_paths(v: Any) -> list[str]:
    """configs / hidden 是路径列表；configs 的旧写法 [{canonical, template, upstream}] 取 canonical。"""
    out = []
    for item in v or []:
        path = item.get("path") or item.get("canonical") if isinstance(item, dict) else item
        if not isinstance(path, str) or not path.strip():
            raise ValueError("路径不能为空")
        if not _absolute(path):
            raise ValueError(f"路径要写绝对路径（可以 ~ 开头）：{path!r}")
        if path not in out:
            out.append(path.strip())
    return out


class EnvOverride(BaseModel):
    """按环境覆盖：只写和基座不同的部分。enabled=false 表示该服务在这个环境不接收运行。"""

    enabled: bool = True
    # 暂停自动触发：定时、事件、上游联动在这个服务×环境上一律不建运行（触发记录里记一条 paused）；
    # 人手动跑、API、对话照常。维护窗口（比如库重启）用，过后打开就好，不用一个个去关触发器
    triggers_paused: bool = False
    root: str | None = None                   # 这个环境的代码目录（不写跟随服务的 root）
    databases: dict[str, str] = Field(default_factory=dict)   # 按库名覆盖服务的 databases；值写空串 = 本环境没有这个库
    code_paths: list[str] | None = None
    python: str | None = None                 # 这个环境的解释器（不写跟随服务的 python）
    urls: dict[str, str] = Field(default_factory=dict)   # 按键覆盖服务的 urls
    logs: dict[str, str] = Field(default_factory=dict)   # 按名字覆盖服务的 logs；值写空串 = 本环境没有这个日志
    profile: dict[str, str] = Field(default_factory=dict)

    @field_validator("databases")
    @classmethod
    def _dbs(cls, v: dict[str, str]) -> dict[str, str]:
        return _check_databases(v) or {}

    @field_validator("logs")
    @classmethod
    def _logs(cls, v: dict[str, str]) -> dict[str, str]:
        return _check_logs(v)


class ServiceView(BaseModel):
    """服务×环境的解析结果（基座 + 覆盖 + 渲染后的路径）。"""

    service: str
    env: str
    title: str
    enabled: bool
    triggers_paused: bool = False
    root: str
    code_paths: list[str]
    python: str
    env_vars: dict[str, str]
    urls: dict[str, str]
    databases: dict[str, str]                # 本环境的只读库：{库名: 连接串}（口令是 ${VAR} 占位，用到时才展开）
    config_files: list[dict[str, str]]       # [{key: 定义里的写法, path: 渲染后的路径}]；内容按 key 存库
    logs: dict[str, str]                     # {名字: 渲染后的文件路径 | docker:<容器>}
    mcp_servers: list[str]                   # 服务自己声明的 MCP server（工具在运行里自动出现）
    profile: dict[str, str]

    def prompt_block(self, protected: bool = False, executor: str = "") -> str:
        """给 agent 的"你在哪"：服务×环境的事实清单（档案另起一块）。protected：环境受保护（生产）。
        executor：代管执行时（部署配置 remote_envs）执行这次运行的那台主机——它不是这个环境的部署主机：
        日志、主机状况看不到，代码目录是那台上的那份（当参考），配置是给 agent 的只读版。"""
        if executor:
            lines = [f"[运行环境] 服务 {self.service}（{self.title}）· 环境 {self.env} · 代管执行：你不在 {self.env} 的部署主机上，"
                     f"这次运行由 {executor} 代为执行（角色说明里说「就在部署主机上」，这次不成立）",
                     f"看不到 {self.env} 主机上的东西：logs、host_status 不可用；本机的日志、进程、容器、crontab 不是 {self.env} 的，"
                     f"不要拿来下结论。{self.env} 的运行记录和日志用服务工具（MCP）查，页面用浏览器工具（有的话）看，数据用 db_query / py 查",
                     f"代码目录：{self.root or '未配置'}（执行主机上部署的那份，只读）：当参考读，不一定是 {self.env} 正在跑的版本；"
                     "结论依赖具体代码行为时说明这一点"]
        else:
            lines = [f"[运行环境] 服务 {self.service}（{self.title}）· 环境 {self.env} · 你就在这个环境部署它的那台主机上",
                     f"代码目录：{self.root or '未配置'}（线上实际部署的那份，只读）"]
        if self.code_paths and self.code_paths != [self.root]:
            lines.append("其他代码目录：" + "、".join(p for p in self.code_paths if p != self.root))
        if executor:
            lines.append(f"项目 Python：{self.python}（执行主机上的环境）。用 py 工具执行代码：工作目录是代码目录，"
                         f"可以直接 import 项目模块、调用项目自己的函数，连的是 {self.env} 的库（给 agent 的只读版配置）；变量在本会话内保留")
        else:
            lines.append(f"项目 Python：{self.python}。用 py 工具在这个环境里执行代码：工作目录是代码目录，"
                         "可以直接 import 项目模块、调用项目自己的函数；变量在本会话内保留")
        files = "、".join(c["path"] for c in self.config_files)
        if (protected or executor) and files:
            lines.append(f"配置文件：{files}。py 里读到的是给 agent 的只读版（库是只读账号），线上真实配置你看不到；"
                         "内容用 service_info(what=config) 读（密钥已打码），bash 里读不到")
        elif files:
            lines.append(f"配置文件：{files}。这是本环境项目的真实配置，bash、py 里都能直接读")
        if not protected and not executor:
            lines.append("数据库只读：项目配置里的库账号可能有写权限，但你只能查，不能改。不要执行 INSERT / UPDATE / DELETE / "
                         "DDL，不要调用会写库的项目函数（ORM 的 save / delete、迁移、manage.py 的写命令、物化 dagster 资产）")
        if self.databases:
            from urllib.parse import urlsplit
            names = []
            for name, url in self.databases.items():
                u = urlsplit(url)
                where = f"{u.hostname or ''}{'/' + u.path.lstrip('/') if u.path.strip('/') else ''}"
                names.append(f"{name}（{_DB_LABELS.get(db_kind(url) or '', '?')}，{where}）")
            lines.append("只读库（db_query 查询，db 填库名）：" + "；".join(names))
        else:
            lines.append("只读库：未配置")
        if self.logs and not executor:
            lines.append("日志（logs 工具，name 填名字）：" + "、".join(self.logs))
        if self.urls:
            lines.append("地址（本环境）：" + "；".join(f"{k} = {v}" for k, v in self.urls.items()))
        if self.mcp_servers:
            lines.append("服务工具（MCP）：" + "、".join(self.mcp_servers) + "——工具已按本环境连好，直接调用")
        return "\n".join(lines)


class ServiceDef(BaseModel):
    title: str = ""
    description: str = ""
    root: str = ""                            # 线上的代码目录（各环境可在 envs 里覆盖）
    code_paths: list[str] = Field(default_factory=list)
    python: str = ""                          # 项目解释器（可写 {env}、~）；空 = python3
    env_vars: dict[str, str] = Field(default_factory=dict)   # 服务级环境变量（可写 {env}）：项目内核带上
    # 有名字的地址（可写 {env}）：线上部署的页面 / API……给 agent 看，也可在 mcp 配置里用 {url:名字} 引用
    urls: dict[str, str] = Field(default_factory=dict)
    # 只读库：{库名: 连接串}，scheme 决定类型（postgresql / mysql / mariadb / doris / clickhouse(s) / mongodb）。
    # 口令写 ${VAR}，真实值放 secrets.env；各环境在 envs[env].databases 里按库名覆盖
    databases: dict[str, str] = Field(default_factory=dict)
    # 项目读的配置文件路径（可写 {env}、~）。生产：真实内容 agent 看不到，内核里盖上控制台填的只读版；测试：照常读真实的
    configs: list[str] = Field(default_factory=list)
    # 代码目录里其他含口令的文件或目录（比如生成出来的 docker-compose.yaml）：生产只遮蔽、不替换；测试不遮
    hidden: list[str] = Field(default_factory=list)
    logs: dict[str, str] = Field(default_factory=dict)   # 日志：{名字: 文件路径 | docker:<容器名>}（logs 工具读）
    # 服务自己的 MCP server：{名字: langchain-mcp-adapters 连接配置}，另可写 envs: {环境: 深合并的覆盖}。
    # 字符串里可写 {env}、{url:名字}、${VAR}（连接时才取值）。运行在本服务上时工具自动出现，调用按运行的环境路由
    mcp: dict[str, dict] = Field(default_factory=dict)
    envs: dict[str, EnvOverride] = Field(default_factory=dict)
    profile: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True

    @field_validator("configs", "hidden", mode="before")
    @classmethod
    def _configs(cls, v: Any) -> list[str]:
        return _config_paths(v)

    @field_validator("env_vars")
    @classmethod
    def _no_secrets(cls, v: dict[str, str]) -> dict[str, str]:
        return _no_placeholders(v)

    @field_validator("databases")
    @classmethod
    def _dbs(cls, v: dict[str, str]) -> dict[str, str]:
        return _check_databases(v) or {}

    @field_validator("logs")
    @classmethod
    def _logs(cls, v: dict[str, str]) -> dict[str, str]:
        return _check_logs(v)

    @field_validator("profile", mode="before")
    @classmethod
    def _profile_str(cls, v: Any) -> dict[str, str]:
        if not isinstance(v, dict):
            return {}
        return {str(k): "、".join(map(str, x)) if isinstance(x, list) else str(x) for k, x in v.items() if str(x).strip()}

    def view(self, name: str, env: str) -> ServiceView:
        o = self.envs.get(env) or EnvOverride()
        raw_root = o.root if o.root is not None else self.root
        root = render(raw_root, env)
        code_paths = o.code_paths if o.code_paths is not None else (self.code_paths or ([raw_root] if raw_root else []))
        python = render(o.python or self.python or DEFAULT_PYTHON, env)
        logs = {k: render(v, env) for k, v in {**self.logs, **o.logs}.items() if v}
        return ServiceView(
            service=name, env=env, title=self.title or name, enabled=self.enabled and o.enabled,
            triggers_paused=o.triggers_paused,
            root=root, code_paths=[render(p, env) for p in code_paths],
            python=python, env_vars={k: render(v, env, python=python) for k, v in self.env_vars.items()},
            urls=self.urls_for(env),
            databases={k: v for k, v in {**self.databases, **o.databases}.items() if v},
            config_files=[{"key": c, "path": render(c, env)} for c in self.configs],
            logs=logs, mcp_servers=list(self.mcp), profile={**self.profile, **o.profile},
        )

    def urls_for(self, env: str) -> dict[str, str]:
        o = self.envs.get(env) or EnvOverride()
        return {k: render(v, env) for k, v in {**self.urls, **o.urls}.items()}

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
        """这些环境的配置文件与 hidden（遮蔽哪些见 services/envspec.masked_configs）。envs 为空时是空集。"""
        return {render(c, env) for c in (*self.configs, *self.hidden) for env in envs}


def _deep_merge(base: dict, overlay: dict) -> dict:
    merged = dict(base)
    for k, v in overlay.items():
        merged[k] = _deep_merge(merged[k], v) if isinstance(merged.get(k), dict) and isinstance(v, dict) else v
    return merged


def check_service_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise ValueError(f"服务名不合法：{name!r}（小写字母开头，可含数字 . _ -，2~41 字符）")
