"""运行的取值空间与提交请求。

状态机：queued → running →（awaiting_approval ⇄ running）→ success | failed | cancelled。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .tasks import MemoryOverride

RunStatus = Literal["queued", "awaiting_approval", "running", "success", "failed", "cancelled"]
RUN_STATUSES: tuple[str, ...] = ("queued", "awaiting_approval", "running", "success", "failed", "cancelled")
TERMINAL = frozenset({"success", "failed", "cancelled"})
ACTIVE = frozenset({"queued", "awaiting_approval", "running"})

# 怎么结束的：agent 执行 / 内建处理器 / 规则先行命中
Resolution = Literal["agent", "builtin", "rule"]
RESOLUTIONS: tuple[str, ...] = ("agent", "builtin", "rule")

# 触发类型：任务上可声明的四种 + 平台内部产生的几种（replay = 回归重放）
TriggerType = Literal["api", "chat", "schedule", "event", "web", "rerun", "resume", "correction", "replay"]
DECLARABLE = frozenset({"api", "chat", "schedule", "event"})


class RunTrigger(BaseModel):
    """谁、从哪启动了这次运行。caller 是身份（API 密钥名 / 控制台用户 / schedule），type/source 是通道。"""

    type: TriggerType = "api"
    id: str | None = None          # 任务上的触发器 id（schedule / event）
    source: str | None = None      # 事件来源（dagster / gitlab / webhook…）
    caller: str = ""

    def declared_type(self) -> str | None:
        """闸门第 5 环查的触发类型。控制台手动运行、重跑、续跑、纠正不受任务的触发声明约束。"""
        return self.type if self.type in DECLARABLE else None


class Caller(BaseModel):
    """发起方身份。API 密钥、控制台用户、平台自身（定时 / 事件 / 维护）都是 Caller。"""

    name: str                                   # 写进 runs.caller
    kind: Literal["key", "user", "root", "system"] = "system"
    admin: bool = False                         # 能改定义、改设置、审批
    services: list[str] = Field(default_factory=list)   # 空 = 不限
    envs: list[str] = Field(default_factory=list)

    def may_run(self, service: str | None, env: str) -> str | None:
        """不允许时返回原因。"""
        if self.services and (service or "") not in self.services:
            return f"{self.name} 只能调用服务 {'、'.join(self.services)}"
        if self.envs and env not in self.envs:
            return f"{self.name} 只能调用环境 {'、'.join(self.envs)}"
        return None


SYSTEM = Caller(name="platform", kind="system", admin=True)


class RunRequest(BaseModel):
    """一次运行请求。API / SDK / 控制台 / 定时 / 事件全部归一成它；角色由任务决定，调用方不传。"""

    task: str
    subtask: str | None = None     # 子任务对象名；不存在则按父任务自动创建
    service: str | None = None     # 通用任务（service="*"）必填；专属任务可省略
    env: str | None = None         # 缺省 = 平台默认环境
    input: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None  # 续同一会话（对话的多轮、纠正）
    memory: MemoryOverride = Field(default_factory=MemoryOverride)
