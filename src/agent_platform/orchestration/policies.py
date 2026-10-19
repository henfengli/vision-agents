"""提交路径闸门链：所有"放行 / 拒绝 / 需审批"判断的唯一入口与测试面。

链序（evaluate_submit 内按序短路），每一环拒绝都带原因码 code：
1. 开关（check_switches，内置）——"为什么没跑"只在这一处判：
   env_disabled（目标环境停用）→ service_disabled（服务停用）→
   task_disabled（任务停用）→ env_gate（任务未在该目标环境启用）
2. input_guard（DB 声明）：definitions 表 kind="policy" 的记录，按 order 升序；
   正则作用于 任务名 + 输入 JSON + 拼接后的 question，命中即按 action 处理
   （code=policy）

开关这一环也被续跑/重跑/纠正/审批放行/规则先行的 webhook 单独调用——
这些路径不过输入策略（已经过过或不是新需求），但停用了就是停用了。

为什么 dedup 不在链里：去重不是闸门决策（不是 allow/deny），而是"合并到
已有 run"，留在 Submitter；执行期危险命令审批（agent/approvals.py 的
review hook）是工具级防线，与本链互补——一个管"这个任务该不该发起"，
一个管"执行中这条命令该不该跑"。

策略和角色/任务一样：DB 声明、版本化、写后即时生效，Admin API 管理。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from ..store import runs
from ..store.definitions import DefinitionStore
from .tasks import TaskDef

# 任务级审批的 approvals.command 前缀标记：approve 后据此识别"放行即启动"
SUBMIT_GATE_PREFIX = "任务提交审批"

PolicyAction = Literal["deny", "require_approval"]


class PolicyDef(BaseModel):
    """一条提交闸门：正则命中 input/question 的任务按 action 处理。"""

    name: str
    order: int = 100                       # 链内执行顺序，小的先判
    applies_to: list[str] = Field(default_factory=list)  # 空 = 所有任务
    envs: list[str] = Field(default_factory=list)        # 空 = 所有目标环境
    match_regex: str                       # 作用于 任务名+输入+question 的正则
    action: PolicyAction = "deny"
    message: str = ""                      # 给调用方/审批人看的理由
    enabled: bool = True


@dataclass
class Verdict:
    action: Literal["allow", "deny", "require_approval"]
    policy: str = ""                       # 命中的策略名（allow 时为空）
    message: str = ""
    code: str = ""                         # 拒绝原因码（allow 时为空）


class Switches(Protocol):
    """启停开关的读取面（实现见 domains.Switches）。"""

    async def env_enabled(self, target_env: str) -> bool: ...

    async def domain_enabled(self, domain: str) -> bool: ...


async def check_switches(task: TaskDef | None, target_env: str,
                         domain: str | None,
                         switches: Switches | None) -> Verdict | None:
    """启停三级 + 任务环境门禁；命中返回 deny Verdict，全部放行返回 None。

    task 可空：规则先行的 webhook 不建 run，只问"环境/服务还开着吗"。
    """
    if switches is not None and target_env \
            and not await switches.env_enabled(target_env):
        return Verdict("deny", "", f"目标环境 {target_env} 已停用",
                       "env_disabled")
    if switches is not None and domain \
            and not await switches.domain_enabled(domain):
        return Verdict("deny", "", f"服务 {domain} 已停用", "service_disabled")
    if task is None:
        return None
    if not task.enabled:
        return Verdict("deny", "", f"任务 {task.name} 已停用", "task_disabled")
    if task.env_gate and target_env not in task.env_gate:
        return Verdict("deny", "env_gate",
                       f"任务 {task.name} 未在目标环境（{target_env}）启用",
                       "env_gate")
    return None


async def evaluate_submit(task: TaskDef, target_env: str, instance_env: str,
                          input_data: dict, question: str,
                          defs: DefinitionStore | None,
                          switches: Switches | None = None,
                          domain: str | None = None) -> Verdict:
    """提交前过闸门链；任一环节命中即短路返回。

    target_env 是 run 操作的业务环境（开关、env_gate 与策略 envs 都按它判）；
    instance_env 是本部署实例标签（策略定义按它存取——一套部署一套定义）。
    """
    switched = await check_switches(task, target_env, domain, switches)
    if switched is not None:
        return switched
    if defs is None:
        return Verdict("allow")

    text = "\n".join([task.name, question,
                      json.dumps(input_data, ensure_ascii=False, default=str)])
    rows = await defs.list_active("policy", instance_env)
    policies = sorted(
        (PolicyDef.model_validate(r) for r in rows if r.get("enabled", True)),
        key=lambda p: p.order)
    for p in policies:
        if p.applies_to and task.name not in p.applies_to:
            continue
        if p.envs and target_env not in p.envs:
            continue
        if re.search(p.match_regex, text, re.IGNORECASE | re.DOTALL):
            return Verdict(p.action, p.name,
                           p.message or f"命中提交策略 {p.name}", "policy")
    return Verdict("allow")


def gate_summary(task_name: str, verdict: Verdict) -> str:
    """审批单上给人看的摘要（带标记前缀）。"""
    return (f"{SUBMIT_GATE_PREFIX}｜任务 {task_name}｜策略 {verdict.policy}\n"
            f"{verdict.message}")


async def settle_submit_gate(run_id: str, approved: bool, submitter) -> bool:
    """审批决定后收口任务级闸门：放行→启动 workflow；拒绝→run 置失败。

    返回 True 表示该 run 确实是提交闸门挂起的（已处理）；False 表示
    是普通工具级审批，调用方无需后续动作。识别依据：run 处于 queued 且
    审批单带 SUBMIT_GATE_PREFIX 标记（工具级审批发生时 run 早已 running）。
    """
    run = await runs.get(run_id)
    if run is None or run["status"] != "queued":
        return False
    # 提交门挂起时 Submitter 已留一条 submit_gate 备注；除此之外还有事件
    # 说明 prepare 已跑、工作流已启动，就不是闸门挂起的排队了
    events = await runs.get_events(run_id)
    if any(not (e["kind"] == "note" and e["payload"].get("stage") == "submit_gate")
           for e in events):
        return False
    if approved:
        await submitter.approve_start(run_id)
    else:
        await runs.log_event(run_id, "note",
                             {"stage": "submit_gate", "decision": "rejected"})
        await runs.set_status(run_id, "failed",
                              output={"error": "提交审批被拒绝，任务未执行"})
    return True
