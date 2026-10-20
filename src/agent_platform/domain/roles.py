"""角色：可复用的能力——系统提示 + 工具白名单。与服务无关。

继承只收敛不扩张：子角色的工具与父角色取交集，提示词在父角色之后追加。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class RoleError(ValueError):
    pass


class RoleDef(BaseModel):
    title: str = ""
    description: str = ""
    prompt: str = ""
    tools: list[str] = Field(default_factory=list)
    extends: str | None = None
    prompt_append: str = ""


class ResolvedRole(BaseModel):
    name: str
    title: str
    description: str
    prompt: str
    tools: list[str]
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
    (root_name, root), *children = chain
    tools = list(root.tools)
    parts = [root.prompt] if root.prompt else []
    title, description = root.title, root.description
    for _, child in children:
        if child.tools:
            tools = [t for t in tools if t in child.tools]
        if child.prompt_append:
            parts.append(child.prompt_append)
        title = child.title or title
        description = child.description or description
    return ResolvedRole(name=name, title=title or name, description=description,
                        prompt="\n\n".join(parts), tools=tools, lineage=[n for n, _ in chain])
