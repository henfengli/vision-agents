"""记忆园丁：记忆层的新陈代谢（夜间低频维护）。

当前已实现：漂移巡检——批量校验知识条目 code_ref 的 commit 与代码库是否
一致，不一致标记 expired（比召回时的惰性校验更主动：召回只管被命中的
条目，巡检管全库）。

已预留的扩展点（需求成熟时在此实现，接口已就位）：
- 衰减 decay()：feedback_score 按半衰期衰减，长期未命中条目降权出召回区
- 矛盾检测 find_conflicts()：同域高相似条目结论冲突 → 写一条"待仲裁"
  反馈，复用管理页的升舱提示通道（那是现成的人门）

启用方式：种子任务 memory-gardener 默认不带 schedule（不自动跑）；
要开夜间整理，Admin 把任务定义加上 schedule（如 "0 3 * * *"）即可——
调度机制复用 Temporal Schedule，零新组件。
"""

from __future__ import annotations

import asyncio

from ..store import knowledge as knowledge_store


async def run_gardener(env: str, domains: dict) -> dict:
    """跑一轮园丁。返回各子项的处理统计（写进 run 台账）。"""
    drift = await sweep_code_ref_drift(env, domains)
    return {
        "drift_expired": drift,   # 漂移巡检：本次标记过期的条目数
        "decay": None,            # 口子：feedback_score 半衰期衰减
        "conflicts": None,        # 口子：矛盾条目待仲裁
    }


async def sweep_code_ref_drift(env: str, domains: dict) -> int:
    """漂移巡检：全库 code_ref 批量校验，过期即标记。返回处理条数。"""
    count = 0
    for domain in domains:
        entries = await knowledge_store.list_all(env, domain)
        paths = list(domains[domain].code_paths) if hasattr(
            domains[domain], "code_paths") else []
        for e in entries:
            if e.get("expired") or e.get("superseded") or not e.get("code_ref"):
                continue
            fresh = await asyncio.to_thread(
                knowledge_store.is_entry_fresh, e["code_ref"], paths)
            if not fresh:
                await knowledge_store.mark_expired(e["id"])
                count += 1
    return count
