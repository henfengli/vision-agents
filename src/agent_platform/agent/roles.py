"""角色：定义、继承解析、DeepAgents 装配——一个文件看全角色的完整生命周期。

继承规则（防提权是核心约束）：
- domains / tools：与父角色取交集——子角色只能收敛，不能扩张
- prompt：父 prompt + prompt_append 拼接
- description / interrupt_on：子角色可覆盖
- 允许多级继承；加载时校验循环与父角色存在性
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from .tools.registry import ToolRegistry


class RoleError(ValueError):
    pass


class RoleDef(BaseModel):
    """DB/Langfuse 里的角色原始定义。"""

    name: str
    description: str = ""
    domains: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    prompt: str = ""
    extends: str | None = None
    prompt_append: str = ""
    interrupt_on: dict[str, bool] | None = None


class ResolvedRole(BaseModel):
    """继承链解析后的最终形态，可直接装配进 DeepAgents。"""

    name: str
    description: str
    domains: list[str]
    tools: list[str]
    prompt: str
    interrupt_on: dict[str, bool] | None = None
    lineage: list[str] = Field(default_factory=list)  # 继承链，便于审计


def parse_defs(raw_list: list[dict]) -> dict[str, RoleDef]:
    """DB list_active 的原始 dict → RoleDef 字典，带校验。"""
    defs = {}
    for raw in raw_list:
        role = RoleDef.model_validate(raw)
        defs[role.name] = role
    return defs


def resolve(role_name: str, defs: dict[str, RoleDef]) -> ResolvedRole:
    """沿 extends 链自底向上合并。defs 为当前环境全部生效角色。"""
    chain: list[RoleDef] = []
    seen: set[str] = set()
    name: str | None = role_name
    while name is not None:
        if name in seen:
            raise RoleError(f"角色继承存在循环：{' -> '.join([*seen, name])}")
        seen.add(name)
        if name not in defs:
            raise RoleError(f"角色 {name} 不存在（解析 {role_name} 的继承链时）")
        chain.append(defs[name])
        name = defs[name].extends

    chain.reverse()  # 基座在前
    root, *children = chain
    domains, tools = set(root.domains), set(root.tools)
    prompt_parts = [root.prompt] if root.prompt else []
    description = root.description
    interrupt_on = root.interrupt_on

    for child in children:
        # 交集收敛：子角色声明超出父级的部分直接丢弃（收敛而非提权）
        if child.domains:
            domains &= set(child.domains)
        if child.tools:
            tools &= set(child.tools)
        if child.prompt_append:
            prompt_parts.append(child.prompt_append)
        if child.description:
            description = child.description
        if child.interrupt_on is not None:
            interrupt_on = child.interrupt_on

    return ResolvedRole(
        name=role_name,
        description=description,
        domains=sorted(domains),
        tools=sorted(tools),
        prompt="\n\n".join(prompt_parts),
        interrupt_on=interrupt_on,
        lineage=[r.name for r in chain],
    )


def resolve_all(defs: dict[str, RoleDef]) -> dict[str, ResolvedRole]:
    return {name: resolve(name, defs) for name in defs}


# ---- ResolvedRole → DeepAgents 装配（框架 API 变更风险隔离在这两个函数） ----

def build_subagents(roles: list[ResolvedRole],
                    tool_registry: "ToolRegistry") -> list[dict]:
    """DeepAgents 0.6.x SubAgent spec：必填 name/description/system_prompt。"""
    subagents = []
    for role in roles:
        subagent = {
            "name": role.name,
            "description": role.description,
            "system_prompt": role.prompt,
            "tools": tool_registry.resolve(role.tools),
        }
        if role.interrupt_on:
            subagent["interrupt_on"] = role.interrupt_on
        subagents.append(subagent)
    return subagents


def build_system_prompt(roles: list[ResolvedRole]) -> str:
    """主控 agent 的系统提示：按角色描述委派。"""
    lines = ["你是主控 agent。根据用户请求委派给最合适的子角色，"
             "没有合适角色时自己处理。可用子角色："]
    lines += [f"- {r.name}: {r.description}" for r in roles]
    return "\n".join(lines)
