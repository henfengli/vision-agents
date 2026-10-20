"""反馈：人对一次运行（或其中一步）的评价。

一个人对同一次运行的同一步只有一条反馈，改主意就是覆盖、撤回就是删除——
所以 "👎 点两下" 不会把记忆权重扣两次。

评价 = 分数（1 有用 / -1 有问题）+ 问题类型（可多选，下表）+ 文字说明。
整次运行的评价会改变它沉淀的知识、案例、方法的召回权重；单步评价只留档，
供排查与改进角色提示词时回看。想让 agent 按意见重答，用"纠正"（另开一轮）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

# 问题类型：值写库，标签给人看（控制台从 /v1/meta 取）
FEEDBACK_REASONS: dict[str, str] = {
    "wrong_conclusion": "结论不对",
    "wrong_definition": "口径 / 业务理解不对",
    "wrong_data": "取数或查询有误",
    "incomplete": "没答全",
    "off_topic": "答非所问",
    "wrong_tool": "工具或命令用错",
    "detour": "绕远路 / 太慢",
    "unsafe": "操作有风险",
    "other": "其他",
}

WHOLE_RUN = 0          # step_seq = 0 表示评价整次运行；>0 是时间线上的某一步


class Feedback(BaseModel):
    score: Literal[1, -1]
    reasons: list[str] = Field(default_factory=list)
    comment: str = Field("", max_length=2000)

    @field_validator("reasons")
    @classmethod
    def _known_reasons(cls, v: list[str]) -> list[str]:
        unknown = [r for r in v if r not in FEEDBACK_REASONS]
        if unknown:
            raise ValueError(f"未知的问题类型：{'、'.join(unknown)}（可选：{'、'.join(FEEDBACK_REASONS)}）")
        return list(dict.fromkeys(v))          # 去重保序
