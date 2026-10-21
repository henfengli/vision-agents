"""平台配置：设置页里"对所有人生效"的那部分，存库、带版本历史。

分五节，每节一份文档（definitions 表 kind=config，name=节名）：

- envs           有哪些环境、默认环境、哪些受保护
- approvals      危险操作审批：哪些命令算危险、哪些环境必审、多久超时
- notifications  通知：渠道（钉钉 / Webhook）+ 规则（什么事件、什么范围、发到哪个渠道）
- memory         记忆默认行为：召回、沉淀、条数
- processes      进程启停：默认租约与上限

"某服务在某环境是否启用"不在这里——那是服务自己的配置（ServiceDef.envs[env].enabled）。
部署级参数（数据库、模型、Temporal…）仍在 conf/ 文件里，不进库。
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# ———————— 环境 ————————

EnvColor = Literal["red", "amber", "blue", "green", "violet", "gray"]
ENV_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,15}$")


class EnvDef(BaseModel):
    name: str
    title: str = ""
    description: str = ""
    protected: bool = False        # 受保护：危险命令、进程启停、命中审批策略的提交都要人放行
    startable: bool = True         # 平台能否在此环境起服务进程（各服务可在 envs[env].startable 覆盖）
    color: EnvColor = "gray"

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not ENV_NAME_RE.match(v):
            raise ValueError(f"环境名不合法：{v!r}（小写字母开头，可含数字与连字符）")
        return v


class EnvsConfig(BaseModel):
    items: list[EnvDef] = Field(default_factory=lambda: [
        EnvDef(name="prod", title="生产", protected=True, startable=False, color="red"),
        EnvDef(name="test", title="测试", color="amber"),
        EnvDef(name="dev", title="开发", color="blue"),
    ])
    default: str = "test"          # 请求不带 env 时用哪个

    @model_validator(mode="after")
    def _consistent(self):
        names = [e.name for e in self.items]
        if not names:
            raise ValueError("至少要有一个环境")
        if len(names) != len(set(names)):
            raise ValueError("环境名重复")
        if self.default not in names:
            raise ValueError(f"默认环境 {self.default} 不在环境列表里")
        return self

    @property
    def names(self) -> list[str]:
        return [e.name for e in self.items]

    def get(self, name: str) -> EnvDef | None:
        return next((e for e in self.items if e.name == name), None)


# ———————— 审批 ————————

class ApprovalsConfig(BaseModel):
    danger_patterns: list[str] = Field(default_factory=lambda: [
        r"\brm\s+-[a-z]*[rf]", r"\bdrop\s+(table|database|schema)\b", r"\btruncate\b", r"\bdelete\s+from\b",
        r"\bkill(all)?\b", r"\bsystemctl\s+(stop|restart|disable)\b", r"\bgit\s+push\b"])
    required_in: Literal["protected", "all"] = "protected"   # 危险命令在哪些环境要审批
    timeout_minutes: int = 30                                # 超时未处理视同拒绝

    @field_validator("danger_patterns")
    @classmethod
    def _compile(cls, v: list[str]) -> list[str]:
        for p in v:
            try:
                re.compile(p)
            except re.error as e:
                raise ValueError(f"正则不合法 {p!r}：{e}") from e
        return v


# ———————— 通知 ————————

NotifyEvent = Literal[
    "run_failed",            # 运行失败
    "run_succeeded",         # 运行成功
    "approval_requested",    # 有人/运行在等审批
    "process_stopped",       # 进程退出（含租约到期、异常退出）
    "feedback_negative",     # 有人对一次运行（或其中一步）点了 👎
]


class Channel(BaseModel):
    type: Literal["dingtalk", "webhook"]
    url: str                         # 钉钉：中继地址；webhook：POST 地址
    token: str = ""                  # 钉钉：机器人 access_token；webhook：作为 Bearer 发送

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            raise ValueError("地址需以 http:// 或 https:// 开头")
        return v


class NotifyRule(BaseModel):
    """事件 × 范围 → 渠道。范围各项为空表示不限，非空项之间是"且"。"""

    name: str
    enabled: bool = True
    events: list[NotifyEvent]
    services: list[str] = Field(default_factory=list)
    envs: list[str] = Field(default_factory=list)
    tasks: list[str] = Field(default_factory=list)          # 父任务名即可覆盖其子任务
    triggers: list[str] = Field(default_factory=list)       # api / chat / schedule / event / web
    channel: str

    def covers(self, event: str, *, service: str | None, env: str | None, task: str | None, trigger: str | None) -> bool:
        if not self.enabled or event not in self.events:
            return False
        base = (task or "").split(":")[0]
        return ((not self.services or (service or "") in self.services)
                and (not self.envs or (env or "") in self.envs)
                and (not self.tasks or task in self.tasks or base in self.tasks)
                and (not self.triggers or (trigger or "") in self.triggers))


class NotificationsConfig(BaseModel):
    channels: dict[str, Channel] = Field(default_factory=dict)
    rules: list[NotifyRule] = Field(default_factory=list)

    @model_validator(mode="after")
    def _channels_exist(self):
        missing = sorted({r.channel for r in self.rules} - set(self.channels))
        if missing:
            raise ValueError(f"规则引用了不存在的渠道：{'、'.join(missing)}")
        return self


# ———————— 记忆 ————————

class MemoryConfig(BaseModel):
    recall: bool = True                # 运行前召回知识/案例/方法
    save: bool = True                  # 运行后沉淀知识/案例
    handoff_summary: bool = True       # 有会话时写交接摘要
    knowledge_limit: int = Field(5, ge=0, le=20)
    asset_limit: int = Field(8, ge=0, le=20)


# ———————— 进程 ————————

class ProcessesConfig(BaseModel):
    default_lease_hours: float = Field(2.0, gt=0)
    max_lease_hours: float = Field(24.0, gt=0)


CONFIG_SECTIONS: dict[str, type[BaseModel]] = {
    "envs": EnvsConfig, "approvals": ApprovalsConfig, "notifications": NotificationsConfig,
    "memory": MemoryConfig, "processes": ProcessesConfig,
}
