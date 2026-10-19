"""任务类型注册表：DB 声明 + 进程内缓存 + 热生效。

一切需求归一为任务声明；新增需求 = Admin API 加一条记录，即时生效。
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field

from ..store.definitions import DefinitionStore
from .artgraph import NodeDef

# 对话入口（/v1/chat、/v1/chat/stream）默认路由到的任务类型；
# 与 main.SEED_TASKS 中的种子任务同名，改名需同步。
DEFAULT_CHAT_TASK = "data-qa"


class TaskDef(BaseModel):
    name: str
    role: str = ""                     # 单 agent 任务的角色；artifacts/handler 任务可空
    triggers: list[str] = Field(default_factory=list)
    input_schema: dict[str, str] = Field(default_factory=dict)
    output_channel: str = "caller"           # caller(不投递)/dingtalk/http（平台投递，见 activities.deliver_output）
    output_callback: str | None = None       # output_channel=http 时的回调地址
    dedup_key: str | None = None             # input 中作为去重键的字段（+连接）
    dedup_window_s: int = 600
    schedule: str | None = None              # cron 表达式（Temporal Schedule）
    schedule_input: dict = Field(default_factory=dict)  # 定时触发时的固定输入
    timeout_s: int = 300
    enabled: bool = True                     # 全局开关：False = 拒新提交+暂停调度
    env_gate: list[str] = Field(default_factory=list)  # 空 = 所有环境启用
    # —— 任务形态（三选一，都空 = 单 agent 问答） ——
    artifacts: dict[str, NodeDef] | None = None  # 资产化任务图（见 artgraph.py）
    handler: str | None = None                 # 内建处理器名（如 memory-gardener）
    # —— 继承（子任务）：比任务更细一层的维度 ——
    # 简单场景用通用任务（如 failure-analysis）；某个具体对象（某张表/
    # 某个报表/某条链路）的业务信息很多很重要时，派生子任务挂上去。
    # 子任务名 = "父任务名:对象名"（如 failure-analysis:dwd_trade_order），
    # 只嵌套一层。选用永远是显式的：调用方提交时带 subtask=对象名（或
    # 直接提交完整子任务名），平台不从输入里猜。点名的子任务还不存在
    # 时自动建空桩（只有 extends，全部继承父任务，auto_created 标记），
    # 档案由人事后补。
    extends: str | None = None               # 父任务名（继承其全部未覆盖字段）
    context: dict = Field(default_factory=dict)  # 任务档案：自由键（常见坑/代码位置/口径/禁区/备注…）
    auto_created: bool = False               # 提交时自动建的桩（不参与继承合并）

    def enabled_in(self, env: str) -> bool:
        return self.enabled and (not self.env_gate or env in self.env_gate)

    def compute_dedup_key(self, input_data: dict) -> str:
        """dedup_key 支持 "a+b" 拼接多个输入字段。"""
        if not self.dedup_key:
            return ""
        parts = [str(input_data.get(k.strip(), "")) for k in self.dedup_key.split("+")]
        return "|".join(parts) if any(parts) else ""


# 子任务与父任务合并时的字段规则：dict 字段按键合并（子赢），
# 其余字段以"子任务显式设置过"（model_fields_set）为覆盖依据——
# 存储只落差异（put 用 exclude_defaults），显式置空也能生效
_DICT_MERGE_FIELDS = ("input_schema", "schedule_input", "context")


def merge_task(parent: TaskDef, child: TaskDef) -> TaskDef:
    """父任务 + 子任务差异 → 生效任务定义。子任务显式给的值优先。"""
    data = parent.model_dump(exclude={"name", "extends"})
    set_fields = child.model_fields_set - {"name"}
    child_data = child.model_dump(exclude={"name", "extends"})
    for f in _DICT_MERGE_FIELDS:
        merged = dict(data[f] or {})
        merged.update(child_data[f] or {})
        data[f] = merged
    for f, v in child_data.items():
        if f in _DICT_MERGE_FIELDS:
            continue
        if f in set_fields:
            data[f] = v
    return TaskDef.model_validate({**data, "name": child.name,
                                   "extends": child.extends})


SUBTASK_SEP = ":"
# 对象名：不含分隔符/空白/路径符，长度有限——传错名字最多建出一个
# 一眼可辨的桩，不会建出能伪装成别的任务或嵌套层级的名字
_OBJECT_NAME_RE = re.compile(r"^[^:\s/\\]{1,120}$")


def split_subtask_name(name: str) -> tuple[str, str]:
    """'a:x' → ('a', 'x')；'a' → ('a', '')。只认第一个分隔符。"""
    base, _, obj = name.partition(SUBTASK_SEP)
    return base, obj


def check_object_name(obj: str) -> None:
    if not _OBJECT_NAME_RE.match(obj):
        raise ValueError(
            f"子任务对象名不合法：{obj!r}（不能含冒号/空白/斜杠，≤120 字符）")


# 档案是自由键：没有固定字段，也没有"负责人"这类归属概念（项目共同开发）。
# 这里只给常用键一个中文标签和展示顺序，其余键按字典序跟在后面。
# 内容原则：只记代码和配置里读不出来的东西——agent 能直接读项目，
# 能读出来的写进档案只会过时。
_PROFILE_ORDER = ("conventions", "no_go", "env_notes", "pitfalls",
                  "code_refs", "upstream", "downstream", "runbook")
_PROFILE_LABELS = {"conventions": "口径与术语", "no_go": "禁区",
                   "env_notes": "环境差异", "pitfalls": "常见坑",
                   "code_refs": "代码位置", "upstream": "上游依赖",
                   "downstream": "下游影响", "runbook": "运维备注"}


def profile_lines(definition: dict) -> list[tuple[str, str]]:
    """任务定义里的 context 档案 → [(标签, 文本)] 有序列表（页面/prompt 共用）。

    值可以是字符串、字符串列表或任意标量；列表用顿号连接。
    """
    ctx = definition.get("context") or {}
    if not isinstance(ctx, dict):
        return []
    keys = [k for k in _PROFILE_ORDER if k in ctx]
    keys += sorted(k for k in ctx if k not in _PROFILE_ORDER)
    out: list[tuple[str, str]] = []
    for k in keys:
        v = ctx[k]
        if isinstance(v, list):
            text = "、".join(str(x) for x in v)
        else:
            text = str(v)
        if text.strip():
            out.append((_PROFILE_LABELS.get(k, k), text))
    return out


def render_profile_block(name: str, lines: list[tuple[str, str]]) -> str:
    """档案的 prompt 注入块：逐字保留，置于最前，优先级最高。

    name 带层级前缀（"服务 dagster" / "任务 failure-analysis:x"），
    服务档案与任务档案各出一块，服务在前。"""
    body = "\n".join(f"{label}：{text}" for label, text in lines)
    return (f"[档案——{name}：一手事实，逐字保留，优先级最高]\n"
            f"{body}")


def compose_profile(service: str | None, service_profile: dict | None,
                    task: "TaskDef | None") -> str:
    """服务档案 + 任务档案 → 置顶注入块（两层各一块，服务在前；都空返回空串）。

    task 应是沿继承链合并后的生效定义（子任务 context 已含父任务的键）。"""
    blocks = []
    lines = profile_lines({"context": service_profile or {}})
    if service and lines:
        blocks.append(render_profile_block(f"服务 {service}", lines))
    if task is not None:
        lines = profile_lines({"context": task.context})
        if lines:
            blocks.append(render_profile_block(f"任务 {task.name}", lines))
    return "\n\n".join(blocks)


class TaskRegistry:
    def __init__(self, store: DefinitionStore, env: str):
        self._store = store
        self._env = env

    async def get(self, name: str) -> TaskDef | None:
        raw = await self._store.get_active("task", self._env, name)
        # name 是表字段，不冗余进 definition JSON，读取时回填
        return TaskDef.model_validate({**raw, "name": name}) if raw else None

    async def resolve(self, name: str, _depth: int = 0) -> TaskDef | None:
        """取任务并沿 extends 链合并出生效定义（继承解析的唯一入口）。

        环/超深直接视为不存在——配置错误不该静默吞掉，调用方报 404。
        """
        if _depth > 4:
            return None
        task = await self.get(name)
        if task is None or not task.extends:
            return task
        parent = await self.resolve(task.extends, _depth + 1)
        if parent is None:
            return task  # 父任务被删：子任务裸定义仍可用（字段全在自己身上）
        return merge_task(parent, task)

    async def resolve_for_submit(
            self, task_name: str, subtask: str | None = None,
    ) -> tuple[TaskDef | None, TaskDef | None]:
        """提交入口的任务解析 → (生效定义, 待建的子任务桩 | None)。

        两种等价写法：(task="a", subtask="x") 或 task="a:x"。父任务不存在
        返回 (None, None)（调用方报未知任务）。点名的子任务不存在时不立刻
        落库：返回内存里的桩（只有 extends + auto_created，内容全继承父任务）
        与合并后的生效定义，由提交端过完闸门链、确定受理后再 create_stub——
        被拒的提交不留垃圾定义。平台不从输入里猜子任务，只认这一处入口。
        """
        base, obj = split_subtask_name(task_name)
        if subtask:
            if obj:
                raise ValueError(
                    f"task 已是子任务名（{task_name}），不能再带 subtask")
            obj = subtask.strip()
        if not obj:
            return await self.resolve(base), None
        check_object_name(obj)
        parent = await self.get(base)
        if parent is None:
            return None, None
        if parent.extends:
            raise ValueError(f"{base} 本身是子任务，子任务不能再派生子任务")
        full = f"{base}{SUBTASK_SEP}{obj}"
        if await self.get(full) is not None:
            return await self.resolve(full), None
        stub = TaskDef(name=full, extends=base, auto_created=True)
        return merge_task(await self.resolve(base) or parent, stub), stub

    async def create_stub(self, stub: TaskDef, created_by: str = "") -> None:
        """落库自动建的子任务桩；并发下别人先建了就不重复写版本。"""
        if await self.get(stub.name) is None:
            await self.put(stub, updated_by=created_by or "auto")

    async def list(self) -> list[TaskDef]:
        rows = await self._store.list_active("task", self._env)
        return [TaskDef.model_validate(r) for r in rows]

    async def put(self, task: TaskDef, updated_by: str = "") -> int:
        # 只落差异（exclude_defaults）：继承合并靠 model_fields_set 判断
        # "子任务显式设置过哪些字段"，全量落库会让默认值冒充显式值
        return await self._store.put("task", self._env, task.name,
                                     task.model_dump(exclude={"name"},
                                                     exclude_defaults=True),
                                     updated_by=updated_by)


def question_text(task: TaskDef, input_data: dict) -> str:
    """任务输入 → 给 agent 的 question 文本（提交端与调度端共用，只此一份）。"""
    lines = [f"任务类型：{task.name}"]
    lines += [f"{k}: {v}" for k, v in input_data.items()]
    return "\n".join(lines)
