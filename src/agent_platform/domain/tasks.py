"""任务：要做的事——目标 + 形态 + 输入 + 触发 + 输出（可声明结构化输出 output_schema）。

归属三选一：service="board"（专属）/ service="*"（通用，调用时指定服务）/
service=None（平台任务，不涉及业务服务）。

子任务 = "父任务:对象名"，只嵌套一层，定义只存差异（model_fields_set 判定显式
覆盖），其余沿 extends 合并。调用方显式带 subtask 选用，平台不从输入里猜。

触发全部声明在任务上：api / chat / schedule（cron × 环境）/ event（来源 × 事件）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal, Union
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

from . import cron

SUBTASK_SEP = ":"
TASK_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,48}$")
OBJECT_NAME_RE = re.compile(r"^[^:\s/\\]{1,120}$")

# ———————— 输入 ————————

InputType = Literal["str", "text", "int", "bool", "json", "enum"]


class InputField(BaseModel):
    type: InputType = "str"
    required: bool = False
    description: str = ""
    default: Any = None
    options: list[str] = Field(default_factory=list)


# ———————— 触发 ————————

class _TriggerBase(BaseModel):
    id: str
    enabled: bool = True


class ApiTrigger(_TriggerBase):
    type: Literal["api"] = "api"


class ChatTrigger(_TriggerBase):
    type: Literal["chat"] = "chat"


class ScheduleTrigger(_TriggerBase):
    type: Literal["schedule"] = "schedule"
    cron: str
    envs: list[str]                               # 每个环境各触发一次
    input: dict[str, Any] = Field(default_factory=dict)
    timezone: str = "Asia/Shanghai"
    service: str | None = None                    # 通用任务（service="*"）的定时触发必须指定服务

    @field_validator("cron")
    @classmethod
    def _cron_valid(cls, v: str) -> str:
        return cron.validate(v)

    @field_validator("timezone")
    @classmethod
    def _tz_valid(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValueError(f"未知时区 {v}") from e
        return v

    def next_fire(self, after: datetime | None = None) -> datetime | None:
        return cron.next_fire(self.cron, self.timezone, after)

    @field_validator("envs")
    @classmethod
    def _envs_non_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("定时触发至少要选一个环境")
        return v


class TriggerRule(BaseModel):
    """规则先行：正则命中事件里的报错即直接给结论，不调模型（仍记一条 run）。"""

    pattern: str
    category: str = "infra"
    conclusion: str
    enabled: bool = True

    @field_validator("pattern")
    @classmethod
    def _compiles(cls, v: str) -> str:
        re.compile(v)
        return v


class EventTrigger(_TriggerBase):
    type: Literal["event"] = "event"
    source: str                                   # dagster / gitlab / webhook…
    event: str                                    # run_failure / deployment / *
    filter: dict[str, str] = Field(default_factory=dict)   # 事件字段 → 正则
    map: dict[str, str] = Field(default_factory=dict)      # 任务输入字段 → 事件字段
    rules: list[TriggerRule] = Field(default_factory=list)
    session: str | None = None                    # 会话命名模板，如 dagster:{asset_key}:{error_class}:{date}
    service: str | None = None                    # 通用任务：固定服务；不填则取事件数据里的 service 字段

    def accepts(self, data: dict[str, Any]) -> bool:
        for field, pattern in self.filter.items():
            if not re.search(pattern, str(data.get(field, "")), re.IGNORECASE):
                return False
        return True

    def input_from(self, data: dict[str, Any]) -> dict[str, Any]:
        """事件数据 → 任务输入。没写映射就整份透传。"""
        if not self.map:
            return dict(data)
        return {k: data.get(v) for k, v in self.map.items() if data.get(v) is not None}


Trigger = Annotated[Union[ApiTrigger, ChatTrigger, ScheduleTrigger, EventTrigger], Field(discriminator="type")]


# ———————— 投递 / 去重 / 记忆 ————————

class Deliver(BaseModel):
    """结果投递：调用方总能用 run_id 取结果；这里声明"另外推到哪"。二选一。"""

    channel: str | None = None     # 通知渠道名（设置 → 通知 → 渠道）
    url: str | None = None         # HTTP 回调：POST {run_id, task, status, output}

    @model_validator(mode="after")
    def _exactly_one(self):
        if bool(self.channel) == bool(self.url):
            raise ValueError("投递需要且只能填渠道或回调地址之一")
        if self.url and not self.url.startswith(("http://", "https://")):
            raise ValueError("回调地址需以 http:// 或 https:// 开头")
        return self


class MemoryOverride(BaseModel):
    """任务级记忆开关：空 = 跟随平台默认（设置 → 记忆）。请求里还能再覆盖一次。"""

    recall: bool | None = None
    save: bool | None = None


class Dedup(BaseModel):
    key: str                       # 输入字段，a+b 拼接
    window_s: int = 600

    def key_of(self, input_data: dict[str, Any]) -> str:
        parts = [str(input_data.get(k.strip(), "")) for k in self.key.split("+")]
        return "|".join(parts) if any(parts) else ""


# ———————— 任务 ————————

TaskForm = Literal["agent", "builtin"]


class TaskDef(BaseModel):
    title: str = ""
    description: str = ""
    service: str | None = None
    role: str | None = None
    form: TaskForm = "agent"
    input: dict[str, InputField] = Field(default_factory=dict)
    envs: list[str] = Field(default_factory=list)
    triggers: list[Trigger] = Field(default_factory=lambda: [ApiTrigger(id="api")])
    deliver: Deliver | None = None
    dedup: Dedup | None = None
    memory: MemoryOverride = Field(default_factory=MemoryOverride)
    timeout_s: int = 300
    enabled: bool = True
    profile: dict[str, str] = Field(default_factory=dict)
    extends: str | None = None
    auto_created: bool = False
    handler: str | None = None
    # 结构化输出（JSON Schema，顶层须是 object）：声明了就要求 agent 最后按它交回结果，
    # 校验通过的放在运行输出的 output.data（answer 照旧是文字结论）。给服务 / 自动化调用方用。
    output_schema: dict[str, Any] | None = None

    @field_validator("timeout_s")
    @classmethod
    def _timeout_bounds(cls, v: int) -> int:
        if not 1 <= v <= 7200:
            raise ValueError("超时须在 1~7200 秒之间")
        return v

    @field_validator("output_schema")
    @classmethod
    def _schema_valid(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        if not v:
            return None
        if v.get("type") != "object":
            raise ValueError("结构化输出的 schema 顶层须是 {\"type\": \"object\", \"properties\": …}")
        import jsonschema
        try:
            jsonschema.Draft202012Validator.check_schema(v)
        except jsonschema.SchemaError as e:
            raise ValueError(f"不是合法的 JSON Schema：{e.message}") from None
        return v

    @field_validator("profile", mode="before")
    @classmethod
    def _profile_str(cls, v: Any) -> dict[str, str]:
        if not isinstance(v, dict):
            return {}
        return {str(k): "、".join(map(str, x)) if isinstance(x, list) else str(x) for k, x in v.items() if str(x).strip()}

    @model_validator(mode="after")
    def _form_consistency(self):
        if self.extends:
            return self   # 子任务只存差异，形态一致性在合并后的生效定义上校验
        if self.form == "agent" and not self.role:
            raise ValueError("单角色任务需要指定角色")
        if self.form == "builtin" and not self.handler:
            raise ValueError("内建任务需要处理器名")
        ids = [t.id for t in self.triggers]
        if len(ids) != len(set(ids)):
            raise ValueError("触发器 id 重复")
        return self

    # —— 查询 ——

    def triggers_of(self, type_: str) -> list[Any]:
        return [t for t in self.triggers if t.type == type_ and t.enabled]

    def allows(self, trigger_type: str | None) -> bool:
        """闸门第 5 环：任务有没有声明这种触发。None（网页/重跑/续跑）总是允许。"""
        return trigger_type is None or bool(self.triggers_of(trigger_type))

    def allows_env(self, env: str) -> bool:
        return not self.envs or env in self.envs

    def trigger(self, trigger_id: str) -> Any | None:
        return next((t for t in self.triggers if t.id == trigger_id), None)

    def validate_input(self, data: dict[str, Any]) -> dict[str, str]:
        """按输入 schema 校验；返回 {字段: 错误}。未声明的字段原样放行（向前兼容）。"""
        errors: dict[str, str] = {}
        for name, f in self.input.items():
            v = data.get(name, f.default)
            if v is None or v == "":
                if f.required:
                    errors[name] = "必填"
                continue
            if f.type == "int" and not (isinstance(v, int) or (isinstance(v, str) and v.lstrip("-").isdigit())):
                errors[name] = "需要整数"
            elif f.type == "bool" and not isinstance(v, bool):
                errors[name] = "需要 true/false"
            elif f.type == "enum" and f.options and v not in f.options:
                errors[name] = f"取值须为 {'/'.join(f.options)}"
            elif f.type == "json" and isinstance(v, str):
                try:
                    json.loads(v)
                except json.JSONDecodeError:
                    errors[name] = "不是合法 JSON"
        return errors

    def with_defaults(self, data: dict[str, Any]) -> dict[str, Any]:
        out = dict(data)
        for name, f in self.input.items():
            if name not in out and f.default is not None:
                out[name] = f.default
        return out


# ———————— 子任务 ————————

def split_subtask_name(name: str) -> tuple[str, str]:
    base, _, obj = name.partition(SUBTASK_SEP)
    return base, obj


def check_task_name(name: str) -> None:
    base, obj = split_subtask_name(name)
    if not TASK_NAME_RE.match(base):
        raise ValueError(f"任务名不合法：{base!r}（小写字母开头，可含数字与连字符）")
    if obj and not OBJECT_NAME_RE.match(obj):
        raise ValueError(f"子任务对象名不合法：{obj!r}（不能含冒号/空白/斜杠，≤120 字符）")


_DICT_MERGE = ("input", "profile")


def merge_task(parent: TaskDef, child: TaskDef) -> TaskDef:
    """父任务 + 子任务差异 → 生效定义。dict 字段按键合并（子赢），其余显式设置才覆盖。"""
    data = parent.model_dump(exclude={"extends", "auto_created"})
    set_fields = child.model_fields_set
    child_data = child.model_dump()
    for f in _DICT_MERGE:
        data[f] = {**(data[f] or {}), **(child_data[f] or {})}
    for f in set_fields - set(_DICT_MERGE) - {"extends", "auto_created"}:
        data[f] = child_data[f]
    data["extends"] = child.extends
    data["auto_created"] = child.auto_created
    return TaskDef.model_validate(data)


# ———————— 档案 / 问题文本 ————————

_PROFILE_ORDER = ("conventions", "no_go", "env_notes", "pitfalls", "code_refs", "upstream", "downstream", "runbook")
PROFILE_LABELS = {"conventions": "口径与术语", "no_go": "禁区", "env_notes": "环境差异", "pitfalls": "常见坑",
                  "code_refs": "代码位置", "upstream": "上游依赖", "downstream": "下游影响", "runbook": "运维备注"}


def profile_lines(ctx: dict[str, str]) -> list[tuple[str, str]]:
    keys = [k for k in _PROFILE_ORDER if k in ctx] + sorted(k for k in ctx if k not in _PROFILE_ORDER)
    return [(PROFILE_LABELS.get(k, k), ctx[k]) for k in keys if str(ctx[k]).strip()]


def _block(name: str, lines: list[tuple[str, str]]) -> str:
    return f"[档案——{name}：一手事实，逐字保留，优先级最高]\n" + "\n".join(f"{k}：{v}" for k, v in lines)


def compose_profile(service: str | None, service_profile: dict[str, str], task_name: str, task_profile: dict[str, str]) -> str:
    """服务档案 + 任务档案 → 置顶注入块（服务在前；都空返回空串）。"""
    blocks = []
    if service and (lines := profile_lines(service_profile)):
        blocks.append(_block(f"服务 {service}", lines))
    if lines := profile_lines(task_profile):
        blocks.append(_block(f"任务 {task_name}", lines))
    return "\n\n".join(blocks)


def question_text(task_name: str, task: TaskDef, input_data: dict[str, Any]) -> str:
    """任务输入 → 给 agent 的任务描述（提交端与调度端共用，只此一份）。"""
    lines = [f"[任务] {task.title or task_name}（{task_name}）"]
    if task.description:
        lines.append(task.description)
    question = input_data.get("question")
    rest = {k: v for k, v in input_data.items() if k != "question"}
    if rest:
        lines.append("输入：")
        lines += [f"- {k}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}" for k, v in rest.items()]
    if question:
        lines.append(f"\n问题：{question}")
    return "\n".join(lines)
