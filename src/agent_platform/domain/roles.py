"""角色：可复用的能力——系统提示 + 工具 + 可委派的子代理。与服务无关。

工具写法：
- 内置工具名（py、bash、sql_query……）或部署配置里 MCP 的工具名
- "*"：全部内置工具 + 全部平台 MCP 工具（通用角色用）
- "mcp:<server>"：某个平台 MCP server 的全部工具（比如 mcp:browser），不用一个个列
服务自己声明的 MCP（服务定义的 mcp）不写在这里：service_tools=true（默认）时，运行在哪个服务上就自动带上哪个服务的。

继承：子角色写了 tools（非空）/ subagents（非 null）/ service_tools（非 null）就整体替换父角色的，没写就跟随；
提示词在父角色之后追加 prompt_append。subagents: [] 表示明确不要子代理。

子代理（subagents）：运行中主角色可以把一个子问题委派给这些角色，子问题用该角色自己的提示词和工具、
独立上下文，结论交回主角色。只委派一层（子代理自己的 subagents 不生效）。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RoleError(ValueError):
    pass


class RoleDef(BaseModel):
    title: str = ""
    description: str = ""                  # 也是委派时给主角色看的"这个子代理擅长什么"
    prompt: str = ""
    tools: list[str] = Field(default_factory=list)      # 空 = 跟随父角色（没有父角色就是没有工具）
    subagents: list[str] | None = None     # None = 跟随父角色（没有父角色就是没有）；[] = 明确不要子代理
    service_tools: bool | None = None      # 自动带上运行所在服务声明的 MCP 工具；None = 跟随父角色（没有父角色就是 true）
    extends: str | None = None
    prompt_append: str = ""


class ResolvedRole(BaseModel):
    name: str
    title: str
    description: str
    prompt: str
    tools: list[str]
    subagents: list[str] = Field(default_factory=list)
    service_tools: bool = True
    lineage: list[str]


def resolve_role(name: str, defs: dict[str, RoleDef]) -> ResolvedRole:
    """沿 extends 链自底向上合并；循环与缺失直接报错。"""
    chain: list[tuple[str, RoleDef]] = []
    seen: set[str] = set()
    cur: str | None = name
    while cur is not None:
        if cur in seen:
            raise RoleError(f"角色继承存在循环：{' → '.join([*seen, cur])}")
        seen.add(cur)
        if cur not in defs:
            raise RoleError(f"角色 {cur} 不存在（解析 {name} 的继承链时）")
        chain.append((cur, defs[cur]))
        cur = defs[cur].extends
    chain.reverse()
    (_, root), *children = chain
    tools, subagents = list(root.tools), list(root.subagents or [])
    service_tools = True if root.service_tools is None else root.service_tools
    parts = [root.prompt] if root.prompt else []
    title, description = root.title, root.description
    for _, child in children:
        if child.tools:
            tools = list(child.tools)
        if child.subagents is not None:
            subagents = list(child.subagents)
        if child.service_tools is not None:
            service_tools = child.service_tools
        if child.prompt_append:
            parts.append(child.prompt_append)
        title = child.title or title
        description = child.description or description
    return ResolvedRole(name=name, title=title or name, description=description, prompt="\n\n".join(parts),
                        tools=tools, subagents=[s for s in subagents if s != name], service_tools=service_tools,
                        lineage=[n for n, _ in chain])
