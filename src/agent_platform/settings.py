"""配置加载与合并：conf/base/domains.yaml + conf/env/{env}.yaml + 环境变量密钥。

加载顺序：base → env 覆盖 → ${VAR} 从进程环境注入（systemd EnvironmentFile）。
合并结果经 pydantic 校验，任何错误在启动时直接拒起。
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

_CONF_ROOT = Path(os.environ.get(
    "AGENT_CONF_ROOT",
    Path(__file__).resolve().parents[2] / "conf"))  # src/agent_platform/settings.py → 项目根/conf
_VAR_PATTERN = re.compile(r"\$\{(\w+)\}")


class DomainConfig(BaseModel):
    code_paths: list[str]
    readonly_dsn: str | None = None      # 该域只读库 DSN（sql_query 工具用）


class ServerConfig(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8100


class ModelConfig(BaseModel):
    url: str
    name: str
    tokens: list[str]
    max_concurrency: int = 10
    embedding_name: str | None = None   # 内网嵌入模型（OpenAI 兼容 /embeddings）；空=关向量检索


class DbConfig(BaseModel):
    dsn: str


class DingTalkConfig(BaseModel):
    relay_url: str
    access_token: str


class TemporalConfig(BaseModel):
    """Temporal durable execution：编排/调度/恢复全部由它接管。"""
    address: str = "127.0.0.1:7233"
    namespace: str = "default"
    task_queue: str = "agent-platform"


class LangfuseConfig(BaseModel):
    """Langfuse：观测(OTEL trace) + 评估 + prompt 源头。

    enabled=false 时：角色定义读 PG 缓存表，trace 不发送，零外部依赖。
    """
    enabled: bool = False
    host: str = "http://127.0.0.1:3000"
    public_key: str = ""
    secret_key: str = ""
    prompt_label: str = "production"         # 角色定义拉取的 label
    prompt_cache_ttl_s: float = 10.0
    record_content: bool = True              # false=trace 只带长度（脱敏）


class ApprovalsConfig(BaseModel):
    enabled: bool = False
    danger_patterns: list[str] = Field(default_factory=list)


class Settings(BaseModel):
    env: str
    server: ServerConfig = ServerConfig()
    model: ModelConfig
    db: DbConfig
    dingtalk: DingTalkConfig
    viewer_base_url: str
    approvals: ApprovalsConfig = ApprovalsConfig()
    temporal: TemporalConfig = TemporalConfig()
    langfuse: LangfuseConfig = LangfuseConfig()
    scratch_dir: str = "/var/lib/agent-platform/scratch"
    bearer_token: str
    domains: dict[str, DomainConfig] = Field(default_factory=dict)
    # 内部 MCP 服务器：{名字: 连接配置}（langchain-mcp-adapters MultiServerMCPClient 格式）
    mcp_servers: dict[str, dict] = Field(default_factory=dict)


def _interpolate(node: object) -> object:
    """递归把配置值里的 ${VAR} 替换为进程环境变量；缺失即报错，拒绝带病启动。"""
    if isinstance(node, str):
        def _sub(m: re.Match[str]) -> str:
            var = m.group(1)
            if var not in os.environ:
                raise KeyError(f"配置引用的环境变量 {var} 未设置（检查 secrets.env / EnvironmentFile）")
            return os.environ[var]
        return _VAR_PATTERN.sub(_sub, node)
    if isinstance(node, dict):
        return {k: _interpolate(v) for k, v in node.items()}
    if isinstance(node, list):
        return [_interpolate(v) for v in node]
    return node


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_settings(env: str | None = None, conf_root: Path = _CONF_ROOT) -> Settings:
    env = env or os.environ.get("AGENT_ENV", "dev")
    base = _load_yaml(conf_root / "base" / "domains.yaml")
    env_conf = _load_yaml(conf_root / "env" / f"{env}.yaml")
    merged = {**env_conf, "env": env}
    merged["domains"] = base.get("domains", {})
    return Settings.model_validate(_interpolate(merged))


@lru_cache
def get_settings() -> Settings:
    return load_settings()
