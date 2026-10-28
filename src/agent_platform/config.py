"""部署配置：conf/base/common.yaml 深合并 conf/env/{AGENT_ENV}.yaml（可 extends 另一份），再深合并本机的
~/.config/agent-platform/local.yaml（不进仓库：负责的业务环境、数据库地址、监听这类每台机器不同的值）；${VAR} 从环境变量插值。

这里只有部署参数：数据库、模型、执行并发、鉴权引导密钥、数据目录、负责的环境、沙箱与资源上限。
服务/角色/任务与平台配置（环境、通知、记忆、提示词）都是数据，存库、在控制台编辑；
conf/seeds/ 只在库里还没有对应对象时播种一次。
AGENT_ENV 只决定读哪份部署配置（开发机 / 线上主机），与业务环境（prod/test）无关。

同机部署：生产机上一个 agent 服务管 prod，测试机上的管 test，共用一个 PostgreSQL 和同一套控制台。
每个 agent 服务只执行自己那个环境（local.yaml 的 env）的运行；test 的项目分在两台机器上，各装一个，用 services 分。
过渡期（只在测试机部署）：测试机的 local.yaml 再写 remote_envs: [prod]，代管生产的运行（见 Settings.remote_envs）。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


def _default_conf_root() -> Path:
    """源码部署：包旁边的 conf（任意 cwd 可启动）；否则 cwd/conf。"""
    repo_conf = Path(__file__).resolve().parents[2] / "conf"
    return repo_conf if (repo_conf / "base/common.yaml").is_file() else Path("conf")


CONF_ROOT = Path(os.environ.get("AGENT_CONF") or _default_conf_root())
LOCAL_CONF = Path(os.environ.get("AGENT_CONF_LOCAL") or Path.home() / ".config" / "agent-platform" / "local.yaml")


def _default_data_dir() -> str:
    """数据目录：AGENT_DATA_DIR > ~/.local/share/agent-platform。"""
    return os.environ.get("AGENT_DATA_DIR") or str(Path.home() / ".local" / "share" / "agent-platform")


class ModelConfig(BaseModel):
    url: str
    name: str
    tokens: list[str]
    max_concurrency: int = 3              # 账号同时在途的模型请求上限（prod、test 所有调用合计，流式读完才算结束）；0 = 不限
    embedding_name: str | None = None     # 空 = 关闭向量检索（退化 pg_trgm）
    context_tokens: int = 400_000         # 模型上下文长度：对话历史到它的 75% 时压缩成摘要
    max_retries: int = 6                  # 限流 / 网关错误的重试次数（指数退避）
    stream_usage: bool = True             # 流式响应里要 token 用量（stream_options.include_usage）；网关不支持就关掉


class ListenConfig(BaseModel):
    """serve 监听在哪。默认只听本机、由反向代理对外；没有反代时 host 写 0.0.0.0，
    证书与私钥（PEM，路径可写 ~）都填了就直接用 HTTPS。端口要 ≥ 1024（普通用户绑不了 443）。"""

    host: str = "127.0.0.1"
    port: int = 8100
    tls_cert: str = ""
    tls_key: str = ""


class WorkerConfig(BaseModel):
    """执行队列（runs 表）的消费端：同时执行几个运行。"""

    max_concurrent_runs: int = 4
    # 排队超过这么久（秒）还没被认领就告警一次：通常是负责这个环境（和服务）的主机没在跑。等上游、任务并发满了的不算
    queued_alert_s: int = 600


class KernelConfig(BaseModel):
    """项目内核（py 工具）：每个 会话×服务×环境 一个常驻 Python 进程。"""

    idle_minutes: float = 30          # 空闲多久回收
    max_kernels: int = 3              # 同时最多几个（超了回收最久没用的）；和生产服务同机，宁少勿多


class LimitsConfig(BaseModel):
    """模型生成的代码（项目内核、bash）各自跑在一个 systemd 用户 scope 里，内存超了只杀这个 scope，线上服务不受影响。
    这些 scope 都在 slice 里（deploy/user/agent.slice 再设内存总上限 64G）；平台进程不在里面，slice 满了杀不到它。
    enabled=false（开发机）时不套 scope。
    只管内存：CPU 不设上限（slice 的 CPUWeight 低，抢 CPU 时让着线上服务）。生产机和测试机内存一样，所有主机用同一组固定值。"""

    enabled: bool = False
    slice: str = "agent.slice"
    kernel_memory: str = "32G"
    bash_memory: str = "8G"
    tasks: int = 4096                 # TasksMax：进程 + 线程数（numpy 这类库按核数开线程，核多的机器别设小）


class OtelConfig(BaseModel):
    """可选的链路追踪：OTLP/HTTP 导出到任意兼容后端（Jaeger、Tempo、各家 APM）。页面不依赖它。"""

    enabled: bool = False
    endpoint: str = "http://127.0.0.1:4318/v1/traces"
    headers: dict[str, str] = Field(default_factory=dict)   # 鉴权头等，值可写 ${VAR}


class RetentionConfig(BaseModel):
    """数据保留（天）：维护循环每 6 小时清一次。运行台账（runs，含输入、输出、配方）一直保留。"""

    run_events_days: int = 90       # 运行的过程事件；被 👎 过的运行不清（回归重放要用）
    checkpoints_days: int = 30      # 会话的 LangGraph checkpoint：最后一轮结束这么久后清掉，之后不能再续跑
    recall_hits_days: int = 90      # 召回埋点
    trigger_ticks_days: int = 30    # 触发记录（定时 / 事件 / 上游联动 / 自动重试的每次判定）
    scratch_days: int = 7           # 工作目录（db_query 的结果文件、agent 写的临时文件），每台主机清自己的


def _default_hidden() -> list[str]:
    """agent 沙箱里看不到的 home 以外的路径（home 本身在沙箱里整个换成空目录，只挂回需要的目录）：
    docker 的 socket（能 docker exec 进容器改东西、拿到真实配置）。服务声明的配置文件按环境遮蔽，不用写在这里。"""
    return ["/var/run/docker.sock", "/run/docker.sock"]


class Settings(BaseModel):
    profile: str                               # AGENT_ENV：读的哪份部署配置（日志/健康检查用）
    db_dsn: str
    model: ModelConfig
    root_token: str                            # 引导密钥：首次登录与创建 API 密钥用
    public_url: str = "http://127.0.0.1:8100"  # 通知里跳转控制台用；必须是用户实际访问的地址
    # 这个 agent 服务负责哪个业务环境（prod / test，和 AGENT_ENV 无关）：只执行这个环境的运行。空 = 所有环境（开发机）
    env: str = ""
    # 同一个环境的项目分在几台主机上时（test：dagster 一台、board 一台），写这台主机上部署了哪些服务。空 = 该环境全部服务
    services: list[str] = Field(default_factory=list)
    # 代管的环境：这台不是它们的部署主机，但也执行它们的运行（过渡期：只在测试机部署，生产的运行由测试机代管）。
    # 代管的运行看不到那个环境主机上的东西（日志、主机状况、进程），代码目录是本机这份（当参考），
    # 配置一律用控制台填的只读版——所以代管的环境必须是受保护的（平台配置 envs 的 protected）。服务范围同 services
    remote_envs: list[str] = Field(default_factory=list)
    listen: ListenConfig = ListenConfig()
    data_dir: str = Field(default_factory=_default_data_dir)
    worker: WorkerConfig = WorkerConfig()
    kernel: KernelConfig = KernelConfig()
    limits: LimitsConfig = LimitsConfig()
    require_sandbox: bool = True               # 没有 bwrap 时拒绝执行模型写的代码；只有开发机可以关
    home_allow: list[str] = Field(default_factory=list)   # 沙箱里额外挂回的 home 下的目录（只读），比如 ~/.local/lib
    otel: OtelConfig = OtelConfig()
    retention: RetentionConfig = RetentionConfig()
    mcp_servers: dict[str, dict] = Field(default_factory=dict)
    hidden_paths: list[str] = Field(default_factory=_default_hidden)   # 存在的才遮蔽；目录整个换成空目录

    @field_validator("remote_envs")
    @classmethod
    def _remote_envs(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(e.strip() for e in v if e and e.strip()))

    @model_validator(mode="after")
    def _remote_not_local(self):
        if self.env and self.env in self.remote_envs:
            raise ValueError(f"remote_envs 里不能有本机自己的环境 {self.env}（本机部署的环境不用代管）")
        return self

    def serves(self, service: str | None, env: str) -> bool:
        """这个服务×环境的运行归不归这个 agent 服务执行（本机的环境，或代管的环境）。平台任务（没有服务）按环境算。"""
        return ((not self.env or env == self.env or env in self.remote_envs)
                and (not self.services or not service or service in self.services))

    def is_local(self, env: str) -> bool:
        """这台是不是 env 的部署主机：是的话日志、主机状况、代码目录都是那个环境线上的；代管的环境不是。
        开发机（env 为空）把没写进 remote_envs 的都当本机的。"""
        return env not in self.remote_envs and (not self.env or env == self.env)

    @property
    def claim_envs(self) -> list[str]:
        """认领哪些环境的运行：本机的 + 代管的；空 = 不限（开发机且没写 remote_envs）。"""
        return [self.env, *self.remote_envs] if self.env else []

    def describe(self) -> str:
        """「test（vision-dagster），代管 prod」：启动日志、check、报错里说这台负责什么。"""
        text = (self.env or "所有环境") + (f"（{'、'.join(self.services)}）" if self.services else "")
        return text + (f"，代管 {'、'.join(self.remote_envs)}" if self.remote_envs else "")

    @property
    def scratch_dir(self) -> str:
        return os.path.join(self.data_dir, "scratch")

    @property
    def assets_dir(self) -> str:
        return os.path.join(self.data_dir, "assets")

    @property
    def agent_conf_dir(self) -> str:
        """给 agent 用的只读版配置（存库，内核启动前写到这里再 bind 到项目读的路径）。700。"""
        return os.path.join(self.data_dir, "agent-conf")

    @property
    def always_hidden(self) -> set[str]:
        """沙箱里总是遮蔽的：hidden_paths、给 agent 的配置落地目录、平台自己的密钥目录、~/.ssh。
        home 本来就换成了空目录，后两个只在有人把它们的上级写进 home_allow 时才起作用。"""
        return {*self.hidden_paths, self.agent_conf_dir,
                os.path.expanduser("~/.config/agent-platform"), os.path.expanduser("~/.ssh")}

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
    if LOCAL_CONF.is_file():
        merged = deep_merge(merged, yaml.safe_load(LOCAL_CONF.read_text(encoding="utf-8")) or {})
    merged["profile"] = profile
    return Settings.model_validate(_interpolate(merged))
