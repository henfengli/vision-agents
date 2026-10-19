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
    env_gate: list[str] = Field(default_factory=list)  # 空 = 所有环境启用
    # —— 任务形态（三选一，都空 = 单 agent 问答） ——
    artifacts: dict[str, NodeDef] | None = None  # 资产化任务图（见 artgraph.py）
    handler: str | None = None                 # 内建处理器名（如 memory-gardener）
    # —— 继承（子任务）：比任务更细一层的维度 ——
    # 简单场景用通用任务（如 failure-analysis）；某个具体对象（某张表/
    # 某个报表/某条链路）的业务信息很多很重要时，派生子任务挂上去：
    # 定义只写差异，其余字段从父任务合并，归因/统计天然按子任务名落账。
    extends: str | None = None               # 父任务名（继承其全部未覆盖字段）
    bind: dict[str, str] = Field(default_factory=dict)  # 绑定条件：input 字段精确匹配
    context: dict = Field(default_factory=dict)  # 任务档案：负责人/代码位置/常见坑/上游依赖/备注
    # 自动派生：开启后，输入里 branch_key 字段出现新值时自动建子任务桩
    # （继承本任务全部定义 + 绑定该值，档案留空待人补全）——不用手动开子任务
    auto_branch: bool = False
    branch_key: str = ""                     # 派生依据的 input 字段名（任意字段）

    def enabled_in(self, env: str) -> bool:
        return not self.env_gate or env in self.env_gate

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
    data = parent.model_dump(exclude={"name", "extends", "bind"})
    set_fields = child.model_fields_set - {"name"}
    child_data = child.model_dump(exclude={"name", "extends", "bind"})
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
                                   "extends": child.extends,
                                   "bind": child.bind})


# 档案字段的固定展示顺序（其余自定义键按字典序跟在后面）
_PROFILE_ORDER = ("owner", "code_refs", "pitfalls", "upstream", "downstream",
                  "runbook")
_PROFILE_LABELS = {"owner": "负责人", "code_refs": "代码位置",
                   "pitfalls": "常见坑", "upstream": "上游依赖",
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
    """档案的 prompt 注入块：逐字保留，置于最前，优先级最高。"""
    body = "\n".join(f"{label}：{text}" for label, text in lines)
    return (f"[任务档案——{name} 的一手事实，逐字保留，优先级最高]\n"
            f"{body}")


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

    async def find_bound(self, base_name: str, input_data: dict) -> TaskDef | None:
        """在 base 任务的子任务里找 bind 条件与本次输入精确匹配的那个。

        多个命中时按名字序取第一个（确定性优先于"最特殊优先"的猜谜）。
        """
        candidates: list[TaskDef] = []
        for raw in await self._store.list_active("task", self._env):
            t = TaskDef.model_validate(raw)
            if t.extends == base_name and t.bind:
                if all(str(input_data.get(k, "")) == v
                       for k, v in t.bind.items()):
                    candidates.append(t)
        if not candidates:
            return None
        candidates.sort(key=lambda t: t.name)
        return await self.resolve(candidates[0].name)

    async def auto_branch(self, base: TaskDef,
                          input_data: dict) -> TaskDef | None:
        """父任务开启 auto_branch 时，按 branch_key 的输入值自动建子任务桩。

        桩 = 名字 parent:<值> + extends + bind + 空档案（管理页"自动"徽标，
        待人补全 context）；已存在则直接复用。返回值已合并父任务定义。
        """
        if not base.auto_branch or not base.branch_key:
            return None
        value = str(input_data.get(base.branch_key) or "").strip()
        if not value:
            return None
        safe = re.sub(r"[^A-Za-z0-9_.\-\u4e00-\u9fff]+", "_", value)[:60]
        name = f"{base.name}:{safe}"
        if await self.get(name) is None:
            await self.put(TaskDef(name=name, extends=base.name,
                                   bind={base.branch_key: value}),
                           updated_by="auto-branch")
        return await self.resolve(name)

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
