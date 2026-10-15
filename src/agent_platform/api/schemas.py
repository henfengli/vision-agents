"""接入层请求/响应模型。"""

from __future__ import annotations

from pydantic import BaseModel


class TaskSubmitRequest(BaseModel):
    task_type: str
    input: dict
    caller: str | None = None
    role: str | None = None          # 可选：覆盖任务默认角色（与 /v1/chat 对齐）
    env: str | None = None           # 目标业务环境（缺省 = 实例默认）
    # 调用方幂等键走 Idempotency-Key 请求头，不进 body（Stripe 同款）


class ApprovalRequest(BaseModel):
    approved: bool
    decided_by: str = ""


class CancelRequest(BaseModel):
    by: str = ""                     # 操作人留痕


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


class StepFeedbackRequest(BaseModel):
    """单步（节点级）反馈：时间线某一步的 👍👎。"""
    score: int                       # +1 / -1
    comment: str = ""


class KnowledgeCreateRequest(BaseModel):
    """手动/API 写入知识条目（upsert：同 env+domain+key 整替换）。"""
    domain: str
    key: str
    content: str


class KnowledgeUpdateRequest(BaseModel):
    content: str


class AssetCreateRequest(BaseModel):
    """登记文本类资产（文件类由 run 内 save_asset 收编，不走这里）。"""
    domain: str
    task: str = ""
    kind: str                        # procedure/script/query/baseline
    name: str
    summary: str = ""
    content: str


class AssetUpdateRequest(BaseModel):
    summary: str
    content: str
