"""任务：要做的事——目标 + 形态 + 输入 + 触发 + 输出（可声明结构化输出 output_schema）。

归属三选一：service="board"（专属）/ service="*"（通用，调用时指定服务）/
service=None（平台任务，不涉及业务服务）。

子任务 = "父任务:对象名"，只嵌套一层，定义只存差异（model_fields_set 判定显式
覆盖），其余沿 extends 合并。调用方显式带 subtask 选用；任务声明了 object_input
（比如失败分析的 asset_key）时，这个输入字段的值就是对象名，两边互相补齐，不用填两遍。

触发全部声明在任务上：api / chat / schedule（cron × 环境）/ event（来源 × 事件）。
"""

from __future__ import annotations

import json
import re
import string
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
        try:
            re.compile(v)
        except re.error as e:
            raise ValueError(f"规则的正则不合法：{e}") from None
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

    def problem(self) -> str | None:
        """写入时的检查（读库时不查：老定义照样能用）。不合法的过滤正则、会话模板要在保存时拦下，
        到收事件时才炸的话整个事件入口（所有任务）都会失败。"""
        for field, pattern in self.filter.items():
            try:
                re.compile(pattern)
            except re.error as e:
                return f"事件 {self.id} 的过滤 {field} 正则不合法：{e}"
        if self.session:
            try:
                names = [f for _, f, _, _ in string.Formatter().parse(self.session) if f is not None]
            except ValueError as e:
                return f"事件 {self.id} 的会话命名模板不合法：{e}（字面花括号写成 {{{{ }}}}）"
            if any(not n or not n.isidentifier() for n in names):
                return f"事件 {self.id} 的会话命名模板里，占位要是字段名，如 {{asset_key}}、{{date}}"
        for r in self.rules:
            # 空正则匹配任何报错：所有事件都会被这条规则截下、不再交给 agent
            if not r.pattern.strip():
                return f"事件 {self.id} 有一条规则的正则是空的（会匹配所有报错）"
            if not r.conclusion.strip():
                return f"事件 {self.id} 的规则 {r.pattern} 没写结论"
        return None

    def accepts(self, data: dict[str, Any]) -> bool:
        for field, pattern in self.filter.items():
            try:
                if not re.search(pattern, str(data.get(field, "")), re.IGNORECASE):
                    return False
            except re.error:
                return False                      # 老定义里不合法的正则：当作不匹配，别让整个事件入口失败
        return True

    def input_from(self, data: dict[str, Any]) -> dict[str, Any]:
        """事件数据 → 任务输入。没写映射就整份透传。"""
        if not self.map:
            return dict(data)
        return {k: data.get(v) for k, v in self.map.items() if data.get(v) is not None}


AFTER_STATUSES = ("success", "failed")
# 上游运行能被引用的字段（映射 / 过滤）：顶层几项 + input.<字段> + output.answer + output.data.<路径>
_AFTER_TOP = ("run_id", "task", "env", "service", "status", "caller", "error", "error_code")
_AFTER_PATH = re.compile(r"^(?:[a-z][a-z0-9-]{1,48}(?::[^:\s/\\.]+)?\.)?"
                         r"(?:run_id|task|env|service|status|caller|error|error_code|output\.answer"
                         r"|input\.[A-Za-z_]\w*|output\.data(?:\.[A-Za-z_]\w*)+)$")


class AfterTrigger(_TriggerBase):
    """上游任务结束后：上游（任务或它的子任务）的一次运行落到 on 里的状态时，在同一个环境里跑这个任务。

    mode=any：任一上游结束就触发；mode=all：每个上游都在窗口内（且在这个触发器上一次触发之后）结束过才触发，
    由最后结束的那个触发。映射 / 过滤引用上游运行的字段（run_id、input.<字段>、output.answer、output.data.<路径>…）；
    all 模式下可以写成「上游任务名.字段」取某一个上游的值，不带前缀的取刚结束的那一个。
    """

    type: Literal["after"] = "after"
    tasks: list[str] = Field(min_length=1)        # 上游任务名（父任务 = 它和它的子任务；也可以写子任务全名）
    mode: Literal["any", "all"] = "any"
    on: list[Literal["success", "failed"]] = Field(default_factory=lambda: ["success"])
    filter: dict[str, str] = Field(default_factory=dict)   # 上游字段 → 正则
    map: dict[str, str] = Field(default_factory=dict)      # 下游输入字段 → 上游字段；不写 = 上游输入里同名的字段带过来
    window_s: int = 86400                         # all 模式：多久以内结束的上游才算数
    service: str | None = None                    # 下游是通用任务时固定服务；不写 = 沿用上游运行的服务

    @field_validator("window_s")
    @classmethod
    def _window(cls, v: int) -> int:
        if not 60 <= v <= 7 * 86400:
            raise ValueError("等待窗口须在 1 分钟 ~ 7 天之间")
        return v

    def problem(self) -> str | None:
        """写入时的检查：上游不重复、至少一个状态、过滤正则能编译、引用的字段写法对。"""
        if len(set(self.tasks)) != len(self.tasks):
            return f"联动 {self.id} 的上游任务重复"
        if not self.on:
            return f"联动 {self.id} 至少要选一种上游结束状态（成功 / 失败）"
        for field, pattern in self.filter.items():
            if not _AFTER_PATH.match(field):
                return f"联动 {self.id} 的过滤字段 {field} 写法不对（如 status、input.asset_key、output.data.category）"
            try:
                re.compile(pattern)
            except re.error as e:
                return f"联动 {self.id} 的过滤 {field} 正则不合法：{e}"
        for k, path in self.map.items():
            if not _AFTER_PATH.match(path):
                return f"联动 {self.id} 的映射 {k} ← {path} 写法不对（如 run_id、input.version、output.answer）"
        return None

    def accepts(self, fields: dict[str, Any]) -> bool:
        for field, pattern in self.filter.items():
            try:
                if not re.search(pattern, str(fields.get(field, "")), re.IGNORECASE):
                    return False
            except re.error:
                return False
        return True

    def watches(self, task_name: str) -> bool:
        """这个上游运行（任务名可能是子任务）是不是在 tasks 里。"""
        base = task_name.partition(SUBTASK_SEP)[0]
        return task_name in self.tasks or base in self.tasks


def _upstream_of(path: str) -> str:
    """「上游任务名.字段」里的上游任务名；不带前缀的返回空串。"""
    head = path.split(".", 1)[0]
    return "" if head in (*_AFTER_TOP, "input", "output") or "." not in path else head


def run_fields(run: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    """一次运行 → 联动可引用的扁平字段（映射 / 过滤用）。"""
    output = run.get("output") or {}
    out: dict[str, Any] = {k: run.get(k) for k in ("run_id", "task", "env", "service", "status", "error_code")}
    out["caller"] = (run.get("trigger") or {}).get("caller") or run.get("caller")
    out["error"] = output.get("error")
    out["output.answer"] = output.get("answer")
    for k, v in (run.get("input") or {}).items():
        out[f"input.{k}"] = v

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{path}.{k}")
        else:
            out[path] = node
    if isinstance(output.get("data"), dict):
        walk(output["data"], "output.data")
    return {f"{prefix}{k}": v for k, v in out.items() if v is not None}


Trigger = Annotated[Union[ApiTrigger, ChatTrigger, ScheduleTrigger, EventTrigger, AfterTrigger], Field(discriminator="type")]


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

    @field_validator("window_s")
    @classmethod
    def _window(cls, v: int) -> int:
        if not 1 <= v <= 7 * 86400:
            raise ValueError("去重窗口须在 1 秒 ~ 7 天之间")
        return v

    @property
    def fields(self) -> list[str]:
        return [k.strip() for k in self.key.split("+") if k.strip()]

    def key_of(self, input_data: dict[str, Any]) -> str:
        parts = [str(input_data.get(k, "")) for k in self.fields]
        return "|".join(parts) if any(parts) else ""


# 自动重试只管临时性的失败：模型 / 工具 / 框架抛的异常（429、网络）、执行进程被杀、主机重启打断。
# 超时、结构化结果交不出、配置没填、落错主机这些再跑一遍结果也一样，不重试
RETRYABLE_CODES = frozenset({"error", "orphaned", "interrupted"})


class Retry(BaseModel):
    """失败自动重试：走续跑（同一个运行从断点接着走），最多 max 次，每次等 delay_s 秒。只对 agent 任务。"""

    max: int = 2
    delay_s: int = 60

    @field_validator("max")
    @classmethod
    def _max(cls, v: int) -> int:
        if not 1 <= v <= 5:
            raise ValueError("自动重试次数须在 1~5 之间")
        return v

    @field_validator("delay_s")
    @classmethod
    def _delay(cls, v: int) -> int:
        if not 10 <= v <= 3600:
            raise ValueError("重试间隔须在 10 秒 ~ 1 小时之间")
        return v


# 内建处理器（form=builtin 的 handler）：实现在 orchestration/pipeline.py 的 BUILTINS，名字在这里登记，保存时就能校验
BUILTIN_HANDLERS = ("memory-gardener",)


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
    # 对象字段：子任务的对象名就是这个输入字段的值（失败分析的 asset_key）。选了对象就自动填上这个输入；
    # 只给了这个输入、没点名子任务时，按它的值找（没有就建）对应的子任务——事件、API、定时都一样
    object_input: str | None = None
    retry: Retry | None = None                # 失败自动重试；空 = 不重试（人去点续跑）
    # 同一个环境里最多同时执行几个（连同子任务一起算）；空 = 不单独限制，只受主机的总并发约束。
    # 一下涌进来几十条 Dagster 失败时，别把主机的执行名额全占了
    concurrency: int | None = None

    @field_validator("concurrency")
    @classmethod
    def _concurrency(cls, v: int | None) -> int | None:
        if v is not None and not 1 <= v <= 50:
            raise ValueError("同时执行上限须在 1~50 之间")
        return v

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
        # 读库时也查的基本一致性；更细的检查只在写入时做（consistency_error），老定义不会因此读不出来
        if self.extends:
            return self   # 子任务只存差异，一致性在合并后的生效定义上校验
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


def consistency_error(t: TaskDef, *, triggers: bool = True) -> str | None:
    """写入时检查一份（生效）定义是否自洽；不自洽返回原因。父任务查它自己，子任务查和父任务合并之后的。
    triggers=False：不查触发器——子任务没写自己的触发时，合并来的是父任务的，定时和事件都不会按子任务触发
    （调度、事件路由跳过它们），拿子任务收窄的环境、改过的输入去对父任务的定时没有意义，父任务那边已经查过。"""
    if t.form == "agent" and not t.role:
        return "单角色任务需要指定角色"
    if t.form == "builtin":
        if not t.handler:
            return "内建任务需要处理器名"
        if t.handler not in BUILTIN_HANDLERS:
            return f"未知的内建处理器 {t.handler}（可用：{'、'.join(BUILTIN_HANDLERS)}）"
        if t.retry:
            return "内建任务不支持自动重试（自动重试走续跑，内建任务没有断点）"
    for name in t.input:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name):
            return f"输入字段名 {name!r} 不合法（字母、数字、下划线，字母或下划线开头）"
    for name, f in t.input.items():
        if f.type == "enum" and not f.options:
            return f"输入字段 {name} 是枚举，至少要有一个选项"
    if t.object_input and t.object_input not in t.input:
        return f"对象字段 {t.object_input} 不在输入字段里"
    if t.dedup:
        if not t.dedup.fields:
            return "去重要写按哪个输入字段（a+b 拼接多个）"
        missing = [k for k in t.dedup.fields if k not in t.input]
        if missing:
            return f"去重字段不在输入里：{'、'.join(missing)}"
    if not triggers:
        return None
    ids = [tr.id for tr in t.triggers]
    if len(ids) != len(set(ids)):
        return "触发器 id 重复"
    for tr in t.triggers:
        if tr.type in ("event", "after") and (why := tr.problem()):
            return why
        if tr.type == "after":
            missing = [k for k in tr.map if k not in t.input]
            if missing:
                return f"联动 {tr.id} 映射的 {'、'.join(missing)} 不是输入字段"
            refs = [*tr.map.values(), *tr.filter]
            if tr.mode == "any" and (prefixed := [p for p in refs if _upstream_of(p)]):
                return f"联动 {tr.id} 是「任一上游结束」，引用不用带上游任务名：{'、'.join(prefixed)}"
            if tr.mode == "all" and (alien := [p for p in refs if _upstream_of(p) and _upstream_of(p) not in tr.tasks]):
                return f"联动 {tr.id} 引用了不在上游里的任务：{'、'.join(alien)}"
            continue
        if tr.type != "schedule":
            continue
        if t.envs and (outside := [e for e in tr.envs if e not in t.envs]):
            return f"定时 {tr.id} 的环境 {'、'.join(outside)} 不在任务允许的环境里"
        if errors := t.validate_input(t.with_defaults(tr.input)):
            return f"定时 {tr.id} 的固定输入不合法：" + "；".join(f"{k} {v}" for k, v in errors.items())
    return None


def object_value(t: TaskDef, input_data: dict[str, Any]) -> str:
    """对象字段的值（能当子任务对象名的才算；Dagster 的多段 asset key 这类带斜杠的不算，运行落在父任务上）。"""
    if not t.object_input:
        return ""
    v = input_data.get(t.object_input)
    v = str(v).strip() if isinstance(v, (str, int)) and not isinstance(v, bool) else ""
    return v if v and OBJECT_NAME_RE.match(v) else ""


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
