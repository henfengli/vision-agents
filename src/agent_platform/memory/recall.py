"""运行前召回：知识库 + 案例库命中结果注入角色 prompt。

知识条目带 code_ref：召回时校验其 commit 与当前代码是否一致，
不一致即弃用（标记 expired），避免拿过期口径答问题。
"""

from __future__ import annotations

from ..store import cases as cases_store
from ..store import knowledge as knowledge_store


async def recall_block(env: str, domain: str | None, query: str,
                       error_text: str | None = None,
                       domain_code_paths: list[str] | None = None,
                       embedder=None, session_id: str | None = None) -> str:
    """拼召回文本块；无命中返回空串。

    层次（自上而下）：资产档案（逐字保留，永不摘要）→ 前序 episode
    交接摘要（同资产同故障类的最近摘要，连续性由记忆而非 thread 承载）
    → 历史知识（混合检索 + commit 校验）→ 同类案例。
    """
    sections: list[str] = []

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
            if knowledge_store.is_entry_fresh(e["code_ref"], domain_code_paths or []):
                fresh.append(e)
            else:
                await knowledge_store.mark_expired(e["id"])
        if fresh:
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
