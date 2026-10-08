"""接入层请求/响应模型。"""

from __future__ import annotations

from pydantic import BaseModel


class AskRequest(BaseModel):
    server: str                      # 业务域（映射 domains.yaml）
    question: str
    role: str | None = None          # 可选：覆盖任务默认角色
    session_id: str | None = None


class TaskSubmitRequest(BaseModel):
    task_type: str
    input: dict
    caller: str | None = None


class ApprovalRequest(BaseModel):
    approved: bool
    decided_by: str = ""


class FeedbackRequest(BaseModel):
    score: int                       # +1 / -1
    comment: str = ""


class DefinitionPutRequest(BaseModel):
    name: str
    definition: dict
    updated_by: str = ""
