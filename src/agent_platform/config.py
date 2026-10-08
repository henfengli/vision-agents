"""配置：环境 YAML → Settings。三环境（prod/test/dev）同代码不同配置。

优先级：env/{ENV}.yaml > base/domains.yaml 合并；${VAR} 从环境变量插值。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

_CONF_ROOT = Path(os.environ.get("AGENT_CONF", "conf"))


class DomainConfig(BaseModel):
    """业务域：代码目录（读口径/排障用）+ 可选只读库。"""

    code_paths: list[str] = []
    readonly_dsn: str | None = None


class ModelConfig(BaseModel):
    """内部统一模型 API（OpenAI 兼容）。"""

    url: str
    name: str
    tokens: list[str]                     # 多 token 轮询
    max_concurrency: int = 10
    embedding_name: str | None = None     # 空 = 关闭向量检索（退化 trgm）


class TemporalConfig(BaseModel):
    address: str = "127.0.0.1:7233"
    namespace: str = "default"
    task_queue: str = "agent-platform"


class LangfuseConfig(BaseModel):
    """提示词源头 + 观测。enabled=false 时角色直读 PG。"""

    enabled: bool = False
    host: str = "http://127.0.0.1:3000"
    public_key: str = ""
    secret_key: str = ""
    prompt_label: str = "production"
    prompt_cache_ttl_s: float = 10.0


class ApprovalsConfig(BaseModel):
    """危险命令人工审批。danger_patterns 命中即挂起等人放行。"""

    enabled: bool = False
    danger_patterns: list[str] = Field(default_factory=list)


class Settings(BaseModel):
    env: str
    host: str = "127.0.0.1"
    port: int = 8100
    db_dsn: str
    model: ModelConfig
    dingtalk_relay_url: str
    dingtalk_token: str
    bearer_token: str                      # 固定 token 鉴权（内网无用户体系）
    viewer_base_url: str
    scratch_dir: str = "/var/lib/agent-platform/scratch"
    domains: dict[str, DomainConfig] = Field(default_factory=dict)
    temporal: TemporalConfig = TemporalConfig()
    langfuse: LangfuseConfig = LangfuseConfig()
    approvals: ApprovalsConfig = ApprovalsConfig()
    # 内部 MCP 服务器：{名字: langchain-mcp-adapters 连接配置}
    mcp_servers: dict[str, dict] = Field(default_factory=dict)


_ENV_VAR = re.compile(r"\$\{(\w+)\}")


def _interpolate(node):
    """${VAR} 从环境变量取值，未设置即报错（启动期暴露配置问题）。"""
    if isinstance(node, str):
        def sub(m):
            var = m.group(1)
            if var not in os.environ:
                raise KeyError(f"配置引用了未设置的环境变量 {var}")
            return os.environ[var]
        return _ENV_VAR.sub(sub, node)
    if isinstance(node, dict):
        return {k: _interpolate(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_interpolate(v) for v in node]
    return node


def load_settings(env: str | None = None) -> Settings:
    env = env or os.environ.get("AGENT_ENV", "dev")
    base = yaml.safe_load((_CONF_ROOT / "base/domains.yaml").read_text()) or {}
    overlay = yaml.safe_load((_CONF_ROOT / f"env/{env}.yaml").read_text()) or {}
    merged = {**base, **overlay, "env": env}
    return Settings.model_validate(_interpolate(merged))
