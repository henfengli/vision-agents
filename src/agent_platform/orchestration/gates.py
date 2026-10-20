"""闸门链：一个请求能不能办，只在这里判断。拒绝带稳定原因码（Rejected.code）。

顺序（先粗后细，命中即停）：
1. service_disabled      服务停用
2. service_env_disabled  服务在这个环境停用（服务 → 环境覆盖 → 启用）
3. task_disabled         任务停用（子任务停用或其父任务停用）
4. env_not_allowed       任务的 envs 不含该环境
5. trigger_not_allowed   任务没有声明这种触发
6. policy                提交策略：deny 直接拒；require_approval 先审批

续跑 / 重跑 / 审批放行 / 定时触发只过 1–4（check_switches）；新提交过全部（admit）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from ..domain import Rejected, TaskDef
from ..registry import Registry


@dataclass
class Admission:
    """放行结论。approval_policy 非空 = 命中 require_approval 策略，先审批再执行。"""

    approval_policy: str | None = None
    approval_message: str = ""


async def check_switches(reg: Registry, *, task_name: str, task: TaskDef, service: str | None, env: str) -> None:
    if service:
        s = await reg.service(service)
        if s is None:
            raise Rejected("unknown_service", f"服务 {service} 不存在")
        if not s.spec.enabled:
            raise Rejected("service_disabled", f"服务 {service} 已停用")
        if not s.spec.view(service, env).enabled:
            raise Rejected("service_env_disabled", f"服务 {service} 在 {env} 环境已停用")
    if not task.enabled:
        raise Rejected("task_disabled", f"任务 {task_name} 已停用")
    if task.extends:
        parent = await reg.task_raw(task.extends)
        if parent is not None and not parent.spec.enabled:
            raise Rejected("task_disabled", f"父任务 {task.extends} 已停用")
    if not task.allows_env(env):
        raise Rejected("env_not_allowed", f"任务 {task_name} 不能在 {env} 运行（允许：{'、'.join(task.envs)}）")


async def admit(reg: Registry, *, task_name: str, task: TaskDef, service: str | None, env: str,
                trigger_type: str | None, input_data: dict) -> Admission:
    """全部 6 环。trigger_type=None：控制台手动运行，人点的，不受任务触发声明约束。"""
    await check_switches(reg, task_name=task_name, task=task, service=service, env=env)
    if not task.allows(trigger_type):
        declared = "、".join(sorted({t.type for t in task.triggers if t.enabled})) or "无"
        raise Rejected("trigger_not_allowed", f"任务 {task_name} 没有声明 {trigger_type} 触发（已声明：{declared}）")

    text = json.dumps(input_data, ensure_ascii=False, default=str)
    needs_approval = None
    for p in await reg.policies():
        if not (p.spec.enabled and p.spec.applies_to.covers(task_name, service, env) and p.spec.matches(text)):
            continue
        if p.spec.action == "deny":
            raise Rejected("policy", p.spec.message or f"命中提交策略 {p.name}", detail={"policy": p.name})
        needs_approval = needs_approval or p          # 多条 require_approval 时按 order 取第一条
    if needs_approval:
        return Admission(needs_approval.name, needs_approval.spec.message or f"命中策略 {needs_approval.name}，需人工放行")
    return Admission()
