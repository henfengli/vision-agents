"""任务类型注册表：DB 声明 + 进程内缓存 + 热生效。

一切需求归一为任务声明；新增需求 = Admin API 加一条记录，即时生效。
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..store.definitions import DefinitionStore
from .artgraph import NodeDef

# 对话入口（/v1/ask、/v1/chat*）默认路由到的任务类型；
# 与 main.SEED_TASKS 中的种子任务同名，改名需同步。
DEFAULT_CHAT_TASK = "data-qa"


class TaskDef(BaseModel):
    name: str
    role: str = ""                     # 单 agent 任务的角色；artifacts/handler 任务可空
    triggers: list[str] = Field(default_factory=list)
    input_schema: dict[str, str] = Field(default_factory=dict)
    output_channel: str = "caller"           # caller/dingtalk/http
    output_callback: str | None = None       # output_channel=http 时的回调地址
    dedup_key: str | None = None             # input 中作为去重键的字段（+连接）
    dedup_window_s: int = 600
    schedule: str | None = None              # cron 表达式（Temporal Schedule）
    schedule_input: dict = Field(default_factory=dict)  # 定时触发时的固定输入
    timeout_s: int = 300
    env_gate: list[str] = Field(default_factory=list)  # 空 = 所有环境启用
    # —— 任务形态（三选一，都空 = 单 agent 问答） ——
    artifacts: dict[str, NodeDef] | None = None  # 资产化任务图（见 artgraph.py）
    handler: str | None = None                 # 内建处理器名（如 memory-gardener）

    def enabled_in(self, env: str) -> bool:
        return not self.env_gate or env in self.env_gate

    def compute_dedup_key(self, input_data: dict) -> str:
        """dedup_key 支持 "a+b" 拼接多个输入字段。"""
        if not self.dedup_key:
            return ""
        parts = [str(input_data.get(k.strip(), "")) for k in self.dedup_key.split("+")]
        return "|".join(parts) if any(parts) else ""


class TaskRegistry:
    def __init__(self, store: DefinitionStore, env: str):
        self._store = store
        self._env = env

    async def get(self, name: str) -> TaskDef | None:
        raw = await self._store.get_active("task", self._env, name)
        # name 是表字段，不冗余进 definition JSON，读取时回填
        return TaskDef.model_validate({**raw, "name": name}) if raw else None

    async def list(self) -> list[TaskDef]:
        rows = await self._store.list_active("task", self._env)
        return [TaskDef.model_validate(r) for r in rows]

    async def put(self, task: TaskDef, updated_by: str = "") -> int:
        return await self._store.put("task", self._env, task.name,
                                     task.model_dump(exclude={"name"}),
                                     updated_by=updated_by)
