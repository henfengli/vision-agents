"""平台配置：conf/base/common.yaml 深合并 conf/env/{AGENT_ENV}.yaml（可 extends 另一份），${VAR} 从环境变量插值。

这里只有部署参数：数据库、模型、执行并发、鉴权引导密钥、数据目录、外部系统地址。
服务/角色/任务与平台配置（环境、审批、通知、记忆、进程）都是数据，存库、在控制台编辑；
conf/seeds/ 只在库里还没有对应对象时播种一次。
AGENT_ENV 只决定读哪份部署配置（开发机 / 生产机），与业务环境（prod/test/dev）无关。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


def _default_conf_root() -> Path:
    """源码部署：包旁边的 conf（任意 cwd 可启动）；否则 cwd/conf。"""
    repo_conf = Path(__file__).resolve().parents[2] / "conf"
    return repo_conf if (repo_conf / "base/common.yaml").is_file() else Path("conf")


CONF_ROOT = Path(os.environ.get("AGENT_CONF") or _default_conf_root())


def _default_data_dir() -> str:
    """数据目录：AGENT_DATA_DIR > /var/lib/agent-platform（可写时）> ~/.local/share/agent-platform。"""
    if env := os.environ.get("AGENT_DATA_DIR"):
        return env
    var_lib = Path("/var/lib/agent-platform")
    try:
        if var_lib.is_dir() or os.access("/var/lib", os.W_OK):
            return str(var_lib)
    except OSError:
        pass
    return str(Path.home() / ".local" / "share" / "agent-platform")


class ModelConfig(BaseModel):
    url: str
    name: str
    tokens: list[str]
    max_concurrency: int = 10
    embedding_name: str | None = None     # 空 = 关闭向量检索（退化 pg_trgm）


class WorkerConfig(BaseModel):
    """执行队列（runs 表）的消费端：同时执行几个运行。"""

    max_concurrent_runs: int = 10


class KernelConfig(BaseModel):
    """项目内核（py 工具）：每个 会话×服务×环境 一个常驻 Python 进程。"""

    idle_minutes: float = 30          # 空闲多久回收
    max_kernels: int = 8              # 同时最多几个（超了回收最久没用的）


class LangfuseConfig(BaseModel):
    enabled: bool = False
    host: str = "http://127.0.0.1:3000"
    public_key: str = ""
    secret_key: str = ""


class GrafanaConfig(BaseModel):
    url: str
    datasource_uid: str
    token: str = ""


class ProcessControlConfig(BaseModel):
    """服务进程启停的执行方式。systemd：模板单元 agent-svc@.service（生产）；local：本机子进程（开发）。
    scope=user：平台跑在某个普通用户的 systemd --user 里（deploy/install-user.sh），没有 root 也能装。
    租约时长是平台配置（设置 → 进程），不在这里。"""

    backend: Literal["systemd", "local", "off"] = "local"
    scope: Literal["system", "user"] = "system"
    unit: str = "agent-svc"                    # 模板单元名前缀（agent-svc@<实例>.service）


def _default_hidden() -> list[str]:
    """agent 沙箱与业务进程里都看不到的路径：平台密钥，以及运行用户的凭据（用户级部署时就是同一个用户）。"""
    home = Path.home()
    return ["/etc/agent-platform", str(home / ".config/agent-platform"), str(home / ".ssh"),
            str(home / ".git-credentials"), str(home / ".netrc"), str(home / ".pgpass")]


class Settings(BaseModel):
    profile: str                               # AGENT_ENV：读的哪份部署配置（日志/健康检查用）
    db_dsn: str
    model: ModelConfig
    root_token: str                            # 引导密钥：首次登录与创建 API 密钥用，权限最高
    public_url: str = "http://127.0.0.1:8100"  # 通知里跳转控制台用
    data_dir: str = Field(default_factory=_default_data_dir)
    worker: WorkerConfig = WorkerConfig()
    kernel: KernelConfig = KernelConfig()
    langfuse: LangfuseConfig = LangfuseConfig()
    grafana: GrafanaConfig | None = None
    process_control: ProcessControlConfig = ProcessControlConfig()
    mcp_servers: dict[str, dict] = Field(default_factory=dict)
    hidden_paths: list[str] = Field(default_factory=_default_hidden)   # 存在的才遮蔽；目录整个换成空目录

    @property
    def scratch_dir(self) -> str:
        return os.path.join(self.data_dir, "scratch")

    @property
    def assets_dir(self) -> str:
        return os.path.join(self.data_dir, "assets")

    @property
    def instances_dir(self) -> str:
        """进程实例的启动规格（svcrun 读它）与本地后端的日志。"""
        return os.path.join(self.data_dir, "instances")

    @property
    def seeds_dir(self) -> Path:
        return CONF_ROOT / "seeds"

    @property
    def webui_dist(self) -> Path:
        """控制台前端构建产物（web/ 下 node scripts/build.mjs build 产出）。"""
        return Path(__file__).resolve().parent / "webui" / "dist"


_ENV_VAR = re.compile(r"\$\{(\w+)\}")


def _interpolate(node):
    if isinstance(node, str):
        def sub(m):
            if m.group(1) not in os.environ:
                raise KeyError(f"配置引用了未设置的环境变量 {m.group(1)}")
            return os.environ[m.group(1)]
        return _ENV_VAR.sub(sub, node)
    if isinstance(node, dict):
        return {k: _interpolate(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_interpolate(v) for v in node]
    return node


def deep_merge(base: dict, overlay: dict) -> dict:
    """两边都是 dict 则递归，否则 overlay 整体替换。"""
    merged = dict(base)
    for k, v in overlay.items():
        merged[k] = deep_merge(merged[k], v) if isinstance(merged.get(k), dict) and isinstance(v, dict) else v
    return merged


def _env_overlay(profile: str, seen: tuple[str, ...] = ()) -> dict:
    """conf/env/{profile}.yaml；文件里写 extends: <另一份> 时先合并那一份（只写差异）。"""
    if profile in seen:
        raise ValueError(f"部署配置 extends 成环：{' → '.join((*seen, profile))}")
    env_file = CONF_ROOT / f"env/{profile}.yaml"
    overlay = (yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}) if env_file.exists() else {}
    parent = overlay.pop("extends", None)
    return deep_merge(_env_overlay(parent, (*seen, profile)), overlay) if parent else overlay


def load_settings(profile: str | None = None) -> Settings:
    profile = profile or os.environ.get("AGENT_ENV", "dev")
    base = yaml.safe_load((CONF_ROOT / "base/common.yaml").read_text(encoding="utf-8")) or {}
    merged = deep_merge(base, _env_overlay(profile))
    merged["profile"] = profile
    return Settings.model_validate(_interpolate(merged))
