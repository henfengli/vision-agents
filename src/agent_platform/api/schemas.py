"""请求体。响应形状见 views.py；前端类型 web/src/api/types.ts 与两者一一对应。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..domain import MemoryOverride


class RunBody(BaseModel):
    """POST /v1/runs"""

    task: str = Field(description="任务名；子任务可写成 父任务:对象，或用 subtask 字段")
    subtask: str | None = Field(None, description="子任务对象名；不存在则按父任务自动创建")
    service: str | None = Field(None, description="通用任务必填；专属任务可省略")
    env: str | None = Field(None, description="缺省为平台默认环境")
    input: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = Field(None, description="续进已有会话")
    memory: MemoryOverride = Field(default_factory=MemoryOverride, description="本次的记忆开关 {recall, save}")
    wait: float = Field(0, ge=0, le=300, description="同步等待秒数；到了还没结束就返回当前状态")


class ChatBody(BaseModel):
    """POST /v1/chat"""

    message: str = Field(min_length=1)
    session_id: str | None = None
    service: str | None = None
    env: str | None = None
    task: str | None = Field(None, description="缺省用该服务的对话任务")
    subtask: str | None = None
    input: dict[str, Any] = Field(default_factory=dict, description="任务的其它输入字段")
    memory: MemoryOverride = Field(default_factory=MemoryOverride)
    stream: bool = Field(True, description="false 时等结束后一次性返回 JSON")


class SubtaskBody(BaseModel):
    """POST /v1/tasks/{name}/subtasks：对象名必填，其余是相对父任务的覆盖。"""

    object: str = Field(min_length=1, max_length=120)
    title: str | None = None
    description: str | None = None
    profile: dict[str, str] | None = None
    input: dict[str, Any] | None = None
    envs: list[str] | None = None
    enabled: bool | None = None


class FeedbackBody(BaseModel):
    score: Literal[1, -1]
    comment: str = ""


class StepFeedbackBody(BaseModel):
    score: Literal[1, -1, 0] = Field(description="0 = 撤销")


class CorrectBody(BaseModel):
    text: str = Field(min_length=1)


class DecisionBody(BaseModel):
    comment: str = ""


class ProcessBody(BaseModel):
    hours: float | None = Field(None, gt=0, description="start：租约时长；renew：续多久。缺省用进程/平台默认")


class KnowledgeCreate(BaseModel):
    service: str
    env: str
    key: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1)
    task: str = ""


class KnowledgePatch(BaseModel):
    content: str | None = None
    status: Literal["active", "expired"] | None = None


class KnowledgeSearch(BaseModel):
    query: str = Field(min_length=1)
    service: str
    env: str
    task: str = ""


class AssetCreate(BaseModel):
    service: str
    env: str
    kind: Literal["procedure", "script", "query", "baseline"]
    name: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1)
    content: str = Field(min_length=1)
    task: str = ""


class AssetPatch(BaseModel):
    summary: str | None = None
    content: str | None = None
    status: Literal["active", "superseded"] | None = None


class ApiKeyCreate(BaseModel):
    name: str = Field(pattern=r"^[\w.-]{2,40}$", description="调用方身份，写进运行记录")
    scope: Literal["run", "admin"] = "run"
    services: list[str] = Field(default_factory=list)
    envs: list[str] = Field(default_factory=list)
    note: str = ""
    expires_at: str | None = None


class ApiKeyPatch(BaseModel):
    services: list[str] | None = None
    envs: list[str] | None = None
    note: str | None = None
    expires_at: str | None = None


class LoginBody(BaseModel):
    token: str
    name: str = Field("", max_length=40, description="操作人姓名：审批记录、运行发起人里显示")


class ChannelTest(BaseModel):
    channel: str
