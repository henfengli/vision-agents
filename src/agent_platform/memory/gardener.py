"""记忆园丁：记忆层的新陈代谢（内建任务 memory-gardener，按需加定时触发）。

当前实现：漂移巡检——批量校验知识条目 code_ref 引用的文件自记录的 commit 以来是否改过，
改过的标记 expired（召回只惰性校验被命中的条目，巡检管全库）。

扩展点（需求成熟时在此实现）：
- 衰减：长期零召回的条目降权出召回区
- 矛盾检测：同服务高相似条目结论冲突 → 记忆页"冲突"计数（MemoryHealth.conflicts）
"""

from __future__ import annotations

import asyncio

from ..store import knowledge as knowledge_store


async def run_gardener(env: str, code_paths_of: dict[str, list[str]]) -> dict:
    """跑一轮园丁。code_paths_of = {服务: 该环境下的代码目录}。返回处理统计（写进运行输出）。"""
    drift = await sweep_code_ref_drift(env, code_paths_of)
    return {"drift_expired": drift}


async def sweep_code_ref_drift(env: str, code_paths_of: dict[str, list[str]]) -> int:
    count = 0
    for service, paths in code_paths_of.items():
        for e in await knowledge_store.list_all(env, service, with_code_ref=True):
            if e.get("expired") or e.get("superseded") or not e.get("code_ref"):
                continue
            if not await asyncio.to_thread(knowledge_store.is_entry_fresh, e["code_ref"], paths):
                await knowledge_store.mark_expired(e["id"])
                count += 1
    return count
