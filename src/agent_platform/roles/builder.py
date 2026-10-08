"""ResolvedRole → DeepAgents subagents 装配。

DeepAgents 仅作执行引擎：它的 API 变更风险被隔离在本文件内。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..tools.registry import ToolRegistry
    from .loader import ResolvedRole


def build_subagents(roles: list["ResolvedRole"],
                    tool_registry: "ToolRegistry") -> list[dict]:
    """组装 DeepAgents 的 subagents 参数。

    0.6.x 的 SubAgent spec 必填 name/description/system_prompt，
    可选 tools/interrupt_on。
    """
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


def build_system_prompt(roles: list["ResolvedRole"]) -> str:
    """主控 agent 的系统提示：按角色描述委派。"""
    lines = ["你是主控 agent。根据用户请求委派给最合适的子角色，"
             "没有合适角色时自己处理。可用子角色："]
    lines += [f"- {r.name}: {r.description}" for r in roles]
    return "\n".join(lines)
