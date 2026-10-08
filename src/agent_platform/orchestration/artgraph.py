"""资产化任务图：节点是产物（artifact），边是依赖——数据流，不是控制流。

设计原点：静态 steps DAG 假设"工作的形状事先已知"，而 agent 任务的核心
特征是未知。所以本模块把动态性收进仅有的两个受控出口，其余全静态：

节点类型（每个节点恰好声明一种物化方式）：
- code  确定性函数（activities.CODE_NODES 注册表里的内核函数），不过模型
- agent 角色 + contract（产出契约描述）；prompt 注入的是依赖产物清单
        （名字+摘要），大产物由 agent 用 read_artifact 工具按需读取
- route 受限枚举选一，模型不能乱飞（动态性出口①）

修饰：
- map   对上游 list 产物逐项扇出，运行时才知道扇出几个（动态性出口②）
- gate  条件 `when`（如 'verdict == "escalate"'）命中 → 人工审批通过才物化；
        不命中或审批拒绝 → 节点跳过，下游连带跳过

执行语义：拓扑分层 + 层内并行（并行度是依赖关系的推论，不用声明）；
重跑 = 输入 hash 未变的节点直接复用旧产物（本 run 优先，跨 run 取最新）。
本模块是纯逻辑：不碰 DB/Temporal——IO 全部通过 call(fn, *args) 注入，
prod 里 call = workflow.execute_activity，测试里 call = 直接 await。
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field, model_validator

SKIPPED = "__skipped__"   # results 里的跳过哨兵


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


_GATE_RE = re.compile(r"""^(\w+)\s*(==|!=)\s*"([^"]*)"$""")


def gate_holds(when: str, results: dict[str, Any]) -> bool:
    """gate 条件的受限求值：只支持 名字 == "值" / !=，无任意表达式。"""
    m = _GATE_RE.match(when.strip())
    if not m:
        raise ValueError(f"gate.when 只支持 name == \"value\" 形式，收到：{when}")
    name, op, value = m.groups()
    actual = results.get(name)
    actual = "" if actual in (None, SKIPPED) else str(actual)
    return (actual == value) if op == "==" else (actual != value)


def terminal_nodes(nodes: dict[str, NodeDef]) -> list[str]:
    """终末节点 = 没有被任何节点依赖的节点（run 的最终产出）。"""
    depended = {d for node in nodes.values() for d in node.deps}
    return sorted(n for n in nodes if n not in depended)


async def run_graph(
    spec: dict,
    call: Callable[..., Awaitable[Any]],
) -> dict:
    """解释执行资产图，返回 {终末节点名: 产物内容}。

    call(activity_fn, *args) 是唯一 IO 通道；节点产物经 artifacts 表流转，
    本函数内存里的 results 只用于依赖接线与 map/gate 判定。
    """
    from . import activities  # 延迟导入：本模块被 tasks.py 引用，不能顶层环

    nodes = {name: NodeDef.model_validate(nd)
             for name, nd in (spec.get("artifacts") or {}).items()}
    if not nodes:
        raise ValueError("artifacts 为空，不是资产图任务")
    layers = topo_layers(nodes)
    results: dict[str, Any] = {}
    run_id = spec["run_id"]

    async def materialize_one(name: str) -> None:
        node = nodes[name]
        missing = [d for d in node.deps if results.get(d) in (None, SKIPPED)]
        if missing:  # 上游被跳过 → 连带跳过
            await call(activities.art_mark, run_id, spec["task_type"],
                       name, "skipped", spec.get("target_env", ""))
            results[name] = SKIPPED
            return
        deps = {d: results[d] for d in node.deps}
        if node.gate:
            if not gate_holds(node.gate["when"], results):
                await call(activities.art_mark, run_id, spec["task_type"],
                           name, "skipped", spec.get("target_env", ""))
                results[name] = SKIPPED
                return
            approved = await call(activities.art_gate, run_id, name,
                                  f"产物 {name} 等待人工放行（"
                                  f"{node.gate['when']}）")
            if not approved:
                results[name] = SKIPPED  # art_gate 内部已记 rejected
                return
        if node.map:
            src, _, attr = node.map.partition(".")
            seq = results.get(src)
            if attr and isinstance(seq, dict):
                seq = seq.get(attr)
            items = list(seq or [])
            if not items:
                await call(activities.art_mark, run_id, spec["task_type"],
                           name, "skipped", spec.get("target_env", ""))
                results[name] = SKIPPED
                return
            mapped = await asyncio.gather(*(
                call(activities.art_materialize, spec, name,
                     node.model_dump(),
                     {"item": item, "index": i, "deps": deps})
                for i, item in enumerate(items)))
            results[name] = [m["content"] for m in mapped]
            return
        payload = {"deps": deps}
        if not node.deps:
            # 根节点的"输入"就是任务输入本身——不进 payload 的话 hash 恒定，
            # 任务输入变了也会误复用旧产物
            payload["input"] = spec.get("input")
        out = await call(activities.art_materialize, spec, name,
                         node.model_dump(), payload)
        results[name] = out["content"]

    for layer in layers:
        await asyncio.gather(*(materialize_one(name) for name in layer))

    return {name: results[name] for name in terminal_nodes(nodes)
            if results.get(name) not in (None, SKIPPED)}
