"""资产化任务图：节点是产物（artifact），边是依赖——数据流，不是控制流。

设计原点：静态 steps DAG 假设"工作的形状事先已知"，而 agent 任务的核心
特征是未知。所以本模块把动态性收进仅有的两个受控出口，其余全静态：

节点类型（每个节点恰好声明一种物化方式）：
- code  确定性函数（activities.CODE_NODES 里登记的内核函数），不过模型
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
from typing import Any, Awaitable, Callable

from ..domain.graph import GATE_RE, NodeDef, topo_layers

SKIPPED = "__skipped__"   # results 里的跳过哨兵


def gate_holds(when: str, results: dict[str, Any]) -> bool:
    """gate 条件的受限求值：只支持 名字 == "值" / !=（单双引号都行），无任意表达式。"""
    m = GATE_RE.match(when.strip())
    if not m:
        raise ValueError(f"gate.when 只支持 name == \"value\" 形式，收到：{when}")
    name, op, _quote, value = m.groups()
    actual = results.get(name)
    actual = "" if actual in (None, SKIPPED) else str(actual)
    return (actual == value) if op == "==" else (actual != value)


def terminal_nodes(nodes: dict[str, NodeDef]) -> list[str]:
    """终末节点 = 没有被任何节点依赖的节点（run 的最终产出）。"""
    depended = {d for node in nodes.values() for d in node.deps}
    return sorted(n for n in nodes if n not in depended)


async def run_graph(spec: dict, call: Callable[..., Awaitable[Any]]) -> dict:
    """解释执行任务图，返回 {终末节点名: 产物内容}。

    call(activity, *args) 是唯一的 IO 通道；节点产物经 artifacts 表流转，
    这里内存里的 results 只用于依赖接线与 map / gate 判定。
    """
    from . import activities

    nodes = {name: NodeDef.model_validate(nd) for name, nd in (spec.get("graph") or {}).items()}
    if not nodes:
        raise ValueError("任务图没有节点")
    results: dict[str, Any] = {}

    async def skip(name: str, status: str = "skipped") -> None:
        await call(activities.art_mark, spec, name, status)
        results[name] = SKIPPED

    async def materialize(name: str) -> None:
        node = nodes[name]
        if any(results.get(d) in (None, SKIPPED) for d in node.deps):
            return await skip(name)                      # 上游被跳过 → 连带跳过
        deps = {d: results[d] for d in node.deps}
        if node.gate:
            if not gate_holds(node.gate["when"], results):
                return await skip(name)
            if not await call(activities.art_gate, spec, name, node.gate["when"]):
                results[name] = SKIPPED                   # art_gate 已记 rejected
                return
        if node.map:
            source, _, attr = node.map.partition(".")
            items = results.get(source)
            if attr and isinstance(items, dict):
                items = items.get(attr)
            items = list(items or [])
            if not items:
                return await skip(name)
            outs = await asyncio.gather(*(
                call(activities.art_materialize, spec, name, node.model_dump(), {"item": item, "index": i, "deps": deps})
                for i, item in enumerate(items)))
            results[name] = [o["content"] for o in outs]
            return
        # 根节点的输入就是任务输入：放进 payload，任务输入变了指纹才会变
        payload = {"deps": deps} if node.deps else {"deps": deps, "input": spec.get("input")}
        out = await call(activities.art_materialize, spec, name, node.model_dump(), payload)
        results[name] = out["content"]

    for layer in topo_layers(nodes):
        await asyncio.gather(*(materialize(name) for name in layer))

    return {name: results[name] for name in terminal_nodes(nodes) if results.get(name) not in (None, SKIPPED)}
