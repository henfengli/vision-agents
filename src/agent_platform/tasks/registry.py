"""任务类型注册表：DB 声明 + 进程内缓存 + 热生效。

一切需求归一为任务声明；新增需求 = Admin API 加一条记录，即时生效。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class TaskDef(BaseModel):
    name: str
    role: str
    triggers: list[str] = Field(default_factory=list)
    input_schema: dict[str, str] = Field(default_factory=dict)
    output_channel: str = "caller"           # caller/dingtalk/gitlab_comment/http
    output_callback: str | None = None       # output_channel=http 时的回调地址
    dedup_key: str | None = None             # input 中作为去重键的字段（+连接）
    dedup_window_s: int = 600
    schedule: str | None = None              # cron 表达式（pg_cron），如 "0 8 * * *"
    schedule_input: dict = Field(default_factory=dict)  # 定时触发时的固定输入
    timeout_s: int = 300
    env_gate: list[str] = Field(default_factory=list)  # 空 = 所有环境启用

    def enabled_in(self, env: str) -> bool:
        return not self.env_gate or env in self.env_gate

    def compute_dedup_key(self, input_data: dict) -> str | None:
        """dedup_key 支持 "a+b" 拼接多个输入字段。"""
        if not self.dedup_key:
            return None
        parts = [str(input_data.get(k.strip(), "")) for k in self.dedup_key.split("+")]
        return "|".join(parts) if any(parts) else None


class TaskRegistry:
    def __init__(self, store, env: str):
        self._store = store      # DefinitionStore
        self._env = env

    @staticmethod
    def _parse(raw: dict) -> TaskDef:
        # name 是表字段，不冗余进 definition JSON，读取时由调用方回填
        return TaskDef.model_validate(raw)

    async def get(self, name: str) -> TaskDef | None:
        raw = await self._store.get_active("task", self._env, name)
        return self._parse({**raw, "name": name}) if raw else None

    async def list(self) -> list[TaskDef]:
        rows = await self._store.list_active("task", self._env)
        return [self._parse(dict(r)) for r in rows]

    async def put(self, task: TaskDef, updated_by: str = "") -> int:
        return await self._store.put("task", self._env, task.name,
                                     task.model_dump(exclude={"name"}),
                                     updated_by=updated_by)
