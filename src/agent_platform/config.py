"""配置：环境 YAML → Settings。三环境（prod/test/dev）同代码不同配置。

优先级：env/{ENV}.yaml 深合并覆盖 base/common.yaml（dict 递归，其余整体替换）；
${VAR} 从环境变量插值。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

_CONF_ROOT = Path(os.environ.get("AGENT_CONF", "conf"))


class DomainConfig(BaseModel):
    """业务域：代码目录（读口径/排障用）+ 可选只读库 + 域包声明。

    域知识从内核搬进 conf/domains/<name>/ 域包：
    - rules.yaml        规则分类器（dagster_sensor 的规则先行）
    - session.yaml      episode 命名模板
    - tasks.yaml        域自带种子任务（如 failure-analysis 住 dagster 包）
    协作边界：平台团队维护内核，业务团队 PR 自己的域包。
    """

    code_paths: list[str] = []
    readonly_dsn: str | None = None
    rules: list[dict] = []                    # [{pattern, category, conclusion}]
    session_template: str | None = None       # 含 {asset}/{error_class}/{date}
    seed_tasks: list[dict] = []               # 域自带种子任务定义
    # 按目标环境覆盖连接信息：{env: {readonly_dsn/code_paths/...}}——
    # 一套 agent 部署操作多套业务环境时，差异只在这里
    envs: dict[str, dict] = Field(default_factory=dict)

    def for_env(self, target_env: str) -> "DomainConfig":
        """基座 + 目标环境覆盖（深合并）；无覆盖时原样返回。"""
        overlay = self.envs.get(target_env)
        if not overlay:
            return self
        return DomainConfig.model_validate(
            _merge(self.model_dump(exclude={"envs"}), overlay))


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
    env: str                               # 实例标签：本套部署自己是谁（定义/种子按它存取）
    target_envs: list[str] = Field(default_factory=list)  # 可操作的业务环境；空=单环境(=env)
    default_target_env: str | None = None  # 缺省目标环境（缺省=target_envs[0] 或 env）
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

    def resolve_target_env(self, env: str | None) -> str:
        """请求级目标环境解析；实现见模块级 resolve_target_env（唯一出处）。"""
        return resolve_target_env(env, self.target_envs,
                                  self.default_target_env, self.env)


def resolve_target_env(env: str | None, target_envs: list[str],
                       default_target: str | None, instance_env: str) -> str:
    """目标业务环境解析（唯一实现）：缺省给默认；配了列表则必须在列表里。

    一套 agent 部署服务多套业务环境（prod/test/dev 的 Dagster/board…），
    run/记忆/闸门都按这个维度区分；不配 target_envs 时退化为实例标签本身。
    Settings.resolve_target_env 与 Submitter._resolve_target_env 共用本函数。
    """
    if not env:
        return default_target or (target_envs[0] if target_envs else instance_env)
    if target_envs and env not in target_envs:
        raise ValueError(f"未知目标环境 {env}（本实例可操作：{target_envs}）")
    return env


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


def _merge(base: dict, overlay: dict) -> dict:
    """深合并：两边都是 dict 则递归，否则 overlay 整体替换。

    环境文件只写差异（如 approvals.enabled: true），共享默认（如
    danger_patterns）留在 common.yaml，避免三环境各抄一份后漂移。
    """
    merged = dict(base)
    for key, value in overlay.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _load_domain_packs(root: Path) -> dict[str, dict]:
    """读取 conf/domains/<name>/ 域包，返回 {域名: DomainConfig 片段}。"""
    packs_dir = root / "domains"
    packs: dict[str, dict] = {}
    if not packs_dir.is_dir():
        return packs
    for pack in sorted(packs_dir.iterdir()):
        if not pack.is_dir():
            continue
        cfg: dict = {}
        domain_yaml = pack / "domain.yaml"
        if domain_yaml.exists():
            cfg = yaml.safe_load(domain_yaml.read_text()) or {}
        rules_yaml = pack / "rules.yaml"
        if rules_yaml.exists():
            cfg["rules"] = (yaml.safe_load(rules_yaml.read_text())
                            or {}).get("rules", [])
        session_yaml = pack / "session.yaml"
        if session_yaml.exists():
            cfg["session_template"] = (yaml.safe_load(
                session_yaml.read_text()) or {}).get("template")
        tasks_yaml = pack / "tasks.yaml"
        if tasks_yaml.exists():
            cfg["seed_tasks"] = (yaml.safe_load(tasks_yaml.read_text())
                                 or {}).get("tasks", [])
        packs[pack.name] = cfg
    return packs


def load_settings(env: str | None = None) -> Settings:
    env = env or os.environ.get("AGENT_ENV", "dev")
    base = yaml.safe_load((_CONF_ROOT / "base/common.yaml").read_text()) or {}
    overlay = yaml.safe_load((_CONF_ROOT / f"env/{env}.yaml").read_text()) or {}
    merged = _merge(base, overlay)
    # 域包深合并进 domains：common.yaml < 域包 < env 覆盖 之外的补充来源
    packs = _load_domain_packs(_CONF_ROOT)
    if packs:
        merged["domains"] = _merge(packs, merged.get("domains") or {})
    merged["env"] = env
    return Settings.model_validate(_interpolate(merged))
