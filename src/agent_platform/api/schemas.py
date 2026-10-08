"""接入层请求/响应模型。"""

from __future__ import annotations

from pydantic import BaseModel


class AskRequest(BaseModel):
    server: str                      # 业务域（映射 domains 配置）
    question: str
    role: str | None = None          # 可选：覆盖任务默认角色
    session_id: str | None = None
    env: str | None = None           # 目标业务环境（缺省 = 实例默认）


class TaskSubmitRequest(BaseModel):
    task_type: str
    input: dict
    caller: str | None = None
    env: str | None = None           # 目标业务环境（缺省 = 实例默认）


class ApprovalRequest(BaseModel):
    approved: bool
    decided_by: str = ""


class FeedbackRequest(BaseModel):
    score: int                       # +1 / -1
    comment: str = ""


class SessionFeedbackRequest(BaseModel):
    """纠正式反馈：给出具体纠正内容，同 session 重新判断并沉淀新记忆。"""
    correction: str
    by: str = ""


class DefinitionPutRequest(BaseModel):
    name: str
    definition: dict
    updated_by: str = ""
