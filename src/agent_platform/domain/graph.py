"""任务图的声明：节点是产物、边是依赖（数据流，不是控制流）。

节点恰好声明一种物化方式：code（内核登记的确定性函数）/ agent（角色 + 产出契约）/
route（受限枚举选一）；修饰：map（对上游 list 逐项扇出）/ gate（条件命中需审批）。
解释执行见 orchestration/artgraph.py。
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, model_validator

GATE_RE = re.compile(r"""^(\w+)\s*(==|!=)\s*(["'])(.*)\3$""")   # name == "value" / name != 'value'


class NodeDef(BaseModel):
    """一个产物节点。code/agent/route 三选一；map 与 gate 是可选修饰。"""

    code: str | None = None          # CODE_NODES 注册表里的函数名
    agent: dict | None = None        # {role, contract?}
    route: dict | None = None        # {choices: [...], by: role}
    map: str | None = None           # "上游节点" 或 "上游节点.attr"：逐项扇出
    deps: list[str] = Field(default_factory=list)
    gate: dict | None = None         # {when: 'name == "value"' 或 'name != "value"'}

    @model_validator(mode="after")
    def _exactly_one_materializer(self):
        kinds = [k for k in ("code", "agent", "route")
                 if getattr(self, k) is not None]
        if len(kinds) != 1:
            raise ValueError("节点必须且只能声明 code/agent/route 之一")
        if self.map and self.route:
            raise ValueError("route 节点不支持 map 扇出")
        if self.map and self.map.partition(".")[0] not in self.deps:
            raise ValueError("map 扇出的上游节点必须同时声明在 deps 里")
        if self.gate and not GATE_RE.match(str(self.gate.get("when", "")).strip()):
            raise ValueError('gate.when 只支持 name == "value" 或 name != "value"')
        return self


def topo_layers(nodes: dict[str, NodeDef]) -> list[list[str]]:
    """Kahn 拓扑分层；环/未知依赖直接报错（声明期错误，不进执行期）。"""
    for name, node in nodes.items():
        for d in node.deps:
            if d not in nodes:
                raise ValueError(f"节点 {name} 依赖不存在的节点 {d}")
    remaining = dict(nodes)
    layers: list[list[str]] = []
    done: set[str] = set()
    while remaining:
        ready = sorted(n for n, node in remaining.items()
                       if all(d in done for d in node.deps))
        if not ready:
            raise ValueError(f"资产图存在环：{sorted(remaining)}")
        layers.append(ready)
        done.update(ready)
        for n in ready:
            remaining.pop(n)
    return layers
