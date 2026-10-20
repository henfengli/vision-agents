"""RunSpec：一次运行的完整规格，提交端写一次，workflow 与各 activity 只读传递。

Temporal 的参数必须可序列化，所以它是普通 dict 往返的 pydantic 模型；
prepare 阶段补齐的字段（prompt、版本、代码目录…）也在这里，一份结构走到底。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..domain import RunTrigger


class RunSpec(BaseModel):
    # —— 提交时确定 ——
    run_id: str
    session_id: str
    task: str                                  # 生效任务名（子任务含冒号）
    form: str                                  # agent / graph / builtin / rule（规则先行命中，结论已定）
    role: str | None = None
    service: str | None = None
    env: str
    input: dict[str, Any] = Field(default_factory=dict)
    question: str = ""
    trigger: RunTrigger = Field(default_factory=RunTrigger)
    timeout_s: int = 300
    deliver: dict[str, str] | None = None      # {"channel": 名} 或 {"url": 地址}；空 = 只等调用方来取
    recall: bool = True                        # 记忆开关（请求 > 任务 > 平台默认，提交时定好）
    save: bool = True
    graph: dict[str, Any] | None = None        # form=graph：节点定义（提交时冻结）
    handler: str | None = None                 # form=builtin
    rule_output: dict[str, Any] | None = None  # form=rule：命中规则给出的结论
    resume: bool = False                       # 断点续跑：沿用 thread，不重新拼提示
    correction: bool = False                   # 纠正：成功后取代本会话上一轮的沉淀

    # —— prepare 补齐 ——
    prompt: str = ""
    code_paths: list[str] = Field(default_factory=list)

    @property
    def error_text(self) -> str:
        """事件类任务约定把报错放在 input.error：案例召回与沉淀都按它的指纹。"""
        return str(self.input.get("error") or "")

    def to_dict(self) -> dict:
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, raw: dict) -> RunSpec:
        return cls.model_validate(raw)
