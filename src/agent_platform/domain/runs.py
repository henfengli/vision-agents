"""运行的取值空间与提交请求。

状态机：queued → running → success | failed | cancelled。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from .tasks import MemoryOverride

RunStatus = Literal["queued", "running", "success", "failed", "cancelled"]
RUN_STATUSES: tuple[str, ...] = ("queued", "running", "success", "failed", "cancelled")
TERMINAL = frozenset({"success", "failed", "cancelled"})
ACTIVE = frozenset({"queued", "running"})

# 怎么结束的：agent 执行 / 内建处理器 / 规则先行命中
Resolution = Literal["agent", "builtin", "rule"]
RESOLUTIONS: tuple[str, ...] = ("agent", "builtin", "rule")

# 触发类型：任务上可声明的四种 + 平台内部产生的几种（replay = 回归重放）
TriggerType = Literal["api", "chat", "schedule", "event", "after", "web", "rerun", "resume", "correction", "replay"]
DECLARABLE = frozenset({"api", "chat", "schedule", "event", "after"})
# 自动触发（没有人在等结果）：服务在某环境「暂停自动触发」时拦的就是这几种；排队时也排在人发起的后面
AUTOMATIC = frozenset({"schedule", "event", "after"})

# 排队优先级（小的先认领）：人在等的（对话、控制台、纠正）> 程序调用 > 自动触发和回归重放
PRIORITY = {"chat": 0, "web": 0, "correction": 0, "api": 1, "rerun": 1, "resume": 1,
            "schedule": 2, "event": 2, "after": 2, "replay": 2}


class RunTrigger(BaseModel):
    """谁、从哪启动了这次运行。caller 是身份（API 密钥名 / 控制台用户 / schedule），type/source 是通道。"""

    type: TriggerType = "api"
    id: str | None = None          # 任务上的触发器 id（schedule / event / after）；纠正 / 重放时是原运行
    source: str | None = None      # 事件来源（dagster / gitlab / webhook…）；after 时是触发它的上游运行 id
    caller: str = ""

    def declared_type(self) -> str | None:
        """闸门第 5 环查的触发类型。控制台手动运行、重跑、续跑、纠正不受任务的触发声明约束。"""
        return self.type if self.type in DECLARABLE else None


class Caller(BaseModel):
    """发起方身份。API 密钥、控制台用户、平台自身（定时 / 事件 / 维护）都是 Caller。只标识是谁，不分权限。"""

    name: str                                   # 写进 runs.caller
    kind: Literal["key", "user", "root", "system"] = "system"


SYSTEM = Caller(name="platform", kind="system")


class RunRequest(BaseModel):
    """一次运行请求。API / SDK / 控制台 / 定时 / 事件全部归一成它；角色由任务决定，调用方不传。"""

    task: str
    subtask: str | None = None     # 子任务对象名；不存在则按父任务自动创建
    service: str | None = None     # 通用任务（service="*"）必填；专属任务可省略
    env: str | None = None         # 缺省 = 平台默认环境
    input: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None  # 续同一会话（对话的多轮、纠正）
    memory: MemoryOverride = Field(default_factory=MemoryOverride)
    # 等这些运行都成功了再执行（排着队等）；其中任何一个失败或取消，这次运行不执行、落 failed / upstream_failed
    after: list[str] = Field(default_factory=list, max_length=20)
