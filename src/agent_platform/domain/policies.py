"""提交策略：闸门链最后一环（开关之后），只对新提交生效。"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class PolicyScope(BaseModel):
    """作用范围：三项都空 = 所有提交；非空的项之间是"且"。"""

    tasks: list[str] = Field(default_factory=list)
    services: list[str] = Field(default_factory=list)
    envs: list[str] = Field(default_factory=list)

    def covers(self, task: str, service: str | None, env: str) -> bool:
        base = task.split(":")[0]
        if self.tasks and task not in self.tasks and base not in self.tasks:
            return False
        if self.services and (service or "") not in self.services:
            return False
        return not (self.envs and env not in self.envs)


class PolicyDef(BaseModel):
    description: str = ""
    order: int = 100
    applies_to: PolicyScope = Field(default_factory=PolicyScope)
    match_regex: str
    action: Literal["deny", "require_approval"] = "deny"
    message: str = ""
    enabled: bool = True

    @field_validator("match_regex")
    @classmethod
    def _regex_compiles(cls, v: str) -> str:
        try:
            re.compile(v)
        except re.error as e:
            raise ValueError(f"正则不合法：{e}") from e
        return v

    def matches(self, text: str) -> bool:
        return re.search(self.match_regex, text, re.IGNORECASE | re.DOTALL) is not None
