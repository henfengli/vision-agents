"""RunScope：工具调用时"我在哪个运行里、操作哪个服务的哪个环境"。

agent 实例按角色缓存、跨运行复用，构建时拿不到运行信息；执行前把 RunScope
放进 contextvar，工具从这里取服务与环境——工具签名里没有 service/env 参数，
模型想跨服务、跨环境也做不到。LangGraph 的工具任务继承创建时的 context，
所以只要在 invoke 之前 bind 即可。
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Iterator

from ..domain import ServiceView


@dataclass(frozen=True)
class RunScope:
    run_id: str
    session_id: str
    task: str
    env: str
    protected: bool                      # 目标环境受保护（生产）：配置用只读版、真实配置遮蔽；否则（测试）用真实配置
    service: str | None = None
    view: ServiceView | None = None      # 服务×环境视图（平台任务为空）
    caller: str = ""
    tools: tuple[str, ...] = field(default_factory=tuple)   # 本运行角色的工具白名单（py 内核里可调的平台工具）
    extra_tools: tuple = field(default_factory=tuple)       # 运行所在服务的 MCP 工具（角色带服务工具时），内核里同样可调
    notify_channel: str | None = None                       # notify 工具发往的渠道（任务投递渠道）
    hidden: tuple[str, ...] = field(default_factory=tuple)  # bash 沙箱 / 项目内核里遮蔽的路径（配置文件、docker…）
    allow: tuple[str, ...] = field(default_factory=tuple)   # bash 沙箱里 home 下挂回的目录（各服务的代码目录、方法目录）


_current: ContextVar[RunScope | None] = ContextVar("run_scope", default=None)


def current() -> RunScope:
    s = _current.get()
    if s is None:
        raise RuntimeError("工具在运行上下文之外被调用")
    return s


def maybe_current() -> RunScope | None:
    return _current.get()


@contextmanager
def bind(scope: RunScope) -> Iterator[RunScope]:
    token = _current.set(scope)
    try:
        yield scope
    finally:
        _current.reset(token)
