"""请求体。响应形状见 views.py；前端类型 web/src/api/types.ts 与两者一一对应。
反馈的请求体就是领域模型 domain.Feedback（校验问题类型），不在这里重复定义。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..domain import MemoryOverride


class RunBody(BaseModel):
    """POST /v1/runs"""

    task: str = Field("ask", description="任务名；子任务可写成 父任务:对象，或用 subtask 字段。不填 = 通用入口 ask")
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


class CorrectBody(BaseModel):
    text: str = Field(min_length=1)


class ReplayBody(BaseModel):
    """POST /v1/replays：不给 run_ids 就按条件选被 👎 的 agent 运行。"""

    run_ids: list[str] | None = Field(None, description="直接点名要重放的运行")
    task: str | None = Field(None, description="父任务名即包含其子任务")
    service: str | None = None
    env: str | None = None
    hours: int | None = Field(None, ge=1, description="只看最近多少小时内被 👎 的")
    limit: int = Field(20, ge=1, le=100)
    title: str = ""
    note: str = Field("", description="这次改了什么，方便回看")


class ProcessBody(BaseModel):
    hours: float | None = Field(None, gt=0, description="start：租约时长；renew：续多久。缺省用进程/平台默认")


class SyncBody(BaseModel):
    """POST /v1/services/{s}/sync：立即同步（不等每小时的代码跟踪）。"""

    envs: list[str] | None = Field(None, description="同步哪些环境；不填 = 服务启用的全部环境")
    force: bool = Field(False, description="所有同步步骤都重跑（不管依赖文件变没变；重建了 conda 环境之后用）")


class ConfigWrite(BaseModel):
    """PUT /v1/services/{s}/envs/{env}/config"""

    path: str = Field(description="配置文件：真实路径或固定路径")
    content: str
    sha: str | None = Field(None, description="打开时读到的 sha（新建传空串）；期间文件被改过返回 409。不传则不检查")


class ConfigAck(BaseModel):
    path: str


class KnowledgeCreate(BaseModel):
    """人工记一条记忆。env 空 = 对该服务所有环境成立。教训（lesson）要给报错原文 error，按它算指纹。"""

    service: str
    env: str = ""
    kind: Literal["fact", "lesson"] = "fact"
    key: str = Field("", max_length=200, description="fact 必填；lesson 不填（按报错指纹生成）")
    content: str = Field(min_length=1)
    task: str = ""
    error: str = Field("", description="lesson：报错原文")
    category: str = Field("", description="lesson：code / data / infra / upstream")


class KnowledgePatch(BaseModel):
    content: str | None = None
    status: Literal["active", "expired"] | None = None


class KnowledgePromote(BaseModel):
    """把一条记忆升格进档案：写进服务档案（条目只在某环境成立时写进该环境的覆盖）或任务档案，原条目标为被取代。"""

    target: Literal["service", "task"]
    key: str = Field(min_length=1, max_length=60, description="档案的键，如 conventions / pitfalls / 自定义")
    task: str = Field("", description="target=task 时写进哪个任务；不填用条目的来源任务")
    content: str | None = Field(None, description="写进档案的文字；不填用条目原文")


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
    note: str = ""
    expires_at: str | None = None


class ApiKeyPatch(BaseModel):
    note: str | None = None
    expires_at: str | None = None


class LoginBody(BaseModel):
    token: str
    name: str = Field("", max_length=40, description="操作人姓名：运行发起人、定义修改人里显示")


class ChannelTest(BaseModel):
    channel: str
