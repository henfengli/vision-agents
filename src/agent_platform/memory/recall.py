"""运行前召回：知识库 + 案例库命中结果注入角色 prompt。

知识条目带 code_ref：召回时校验其 commit 与当前代码是否一致，
不一致即弃用（标记 expired），避免拿过期口径答问题。
"""

from __future__ import annotations

import asyncio

from ..store import cases as cases_store
from ..store import knowledge as knowledge_store


async def recall_block(env: str, domain: str | None, query: str,
                       error_text: str | None = None,
                       domain_code_paths: list[str] | None = None,
                       embedder=None, session_id: str | None = None,
                       run_id: str | None = None,
                       asset_key: str | None = None,
                       source: str = "recall") -> str:
    """拼召回文本块；无命中返回空串。

    层次（自上而下）：资产目录档案（按 asset_key 确定性挂载，逐字保留，
    优先级最高）→ 资产档案知识条目（query 提及即命中）→ 前序 episode
    交接摘要（同资产同故障类的最近摘要，连续性由记忆而非 thread 承载）
    → 历史知识（混合检索 + commit 校验）→ 同类案例。

    副作用：最终命中的知识条目写 recall_hits 埋点（记忆运营数据源）；
    run_id 为空（页面试用）时 source 传 playground，不算真实使用。
    """
    sections: list[str] = []

    if domain and asset_key:
        # 资产目录：run 明确针对某资产时整段置顶——归因不靠检索运气
        from ..store import catalog as catalog_store
        entry = await catalog_store.get(env, domain, asset_key)
        if entry is not None and (entry["runbook"] or entry["owner"]
                                  or entry["code_refs"]):
            sections.append(catalog_store.render_block(entry))

    if domain:
        profiles = await knowledge_store.asset_profiles(env, domain, query)
        if profiles:
            sections.append(
                "[资产档案——逐字保留的事实，优先级最高]\n" + "\n".join(
                    f"- {p['key']}: {p['content']}" for p in profiles))

    if session_id and ":" in session_id:
        prefix = session_id.rsplit(":", 1)[0]  # 去掉 episode 段
        summaries = await knowledge_store.latest_session_summaries(env, prefix)
        if summaries:
            sections.append("[前序会话交接摘要]\n" + "\n\n".join(
                s["content"] for s in summaries))

    if domain:
        entries = await knowledge_store.search(env, domain, query, embedder=embedder)
        fresh = []
        for e in entries:
            # is_entry_fresh 里跑 git subprocess，to_thread 避免阻塞事件循环
            if await asyncio.to_thread(
                    knowledge_store.is_entry_fresh, e["code_ref"],
                    domain_code_paths or []):
                fresh.append(e)
            else:
                await knowledge_store.mark_expired(e["id"])
        if fresh:
            await knowledge_store.record_hits(env, domain, fresh,
                                              run_id=run_id, source=source)
            lines = ["[历史知识]"] + [
                f"- {e['key']}: {e['content']}（来源 run {e['source_run'] or '未知'}）"
                for e in fresh]
            sections.append("\n".join(lines))

    if error_text:
        case = await cases_store.search_by_error(env, error_text)
        if case:
            sections.append(
                "[同类案例]\n"
                f"- {case['date'][:10]} 同类报错结论（{case['category']}，"
                f"👍×{case['thumbs_up']}）：{case['conclusion']}")

    return "\n\n".join(sections)
