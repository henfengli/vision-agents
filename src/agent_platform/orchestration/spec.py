"""RunSpec：一次运行的完整规格。worker 认领运行时从台账行建出来，各步骤之间传的就是它。

prepare 阶段补齐的字段（prompt、代码目录…）也在这里，一份结构走到底。
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..domain import RunTrigger


class RunSpec(BaseModel):
    # —— 从台账行确定 ——
    run_id: str
    session_id: str
    task: str                                  # 生效任务名（子任务含冒号）
    form: str                                  # agent / builtin / rule（规则先行命中，结论已定）
    role: str | None = None
    service: str | None = None
    env: str
    input: dict[str, Any] = Field(default_factory=dict)
    question: str = ""
    trigger: RunTrigger = Field(default_factory=RunTrigger)
    timeout_s: int = 300
    approval_budget_s: int = 0                 # 等人工审批的时间不算进 timeout_s（按一次审批的超时预留）
    deliver: dict[str, str] | None = None      # {"channel": 名} 或 {"url": 地址}；空 = 只等调用方来取
    recall: bool = True                        # 记忆开关（请求 > 任务 > 平台默认）
    save: bool = True
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

    @property
    def thread_id(self) -> str:
        """会话的 LangGraph thread 按 服务×环境 分开：同一个会话键（比如事件模板 dagster:{asset_key}:…）
        在 prod 和 test 各有各的上下文，一次运行只看得到自己服务×环境的对话历史。项目内核也用这个键。"""
        return f"{self.session_id}@{self.service or '-'}:{self.env}"
