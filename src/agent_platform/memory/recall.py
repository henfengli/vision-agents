"""运行前召回：把过去沉淀的东西拼成一段文字，放进本次运行的提示里。

自上而下三层：
1. 前序会话交接摘要——同一类事件的上一个会话结论（会话名形如 dagster:<asset>:<错误类>:<日期>，
   去掉最后一段就是"同一类"）
2. 历史知识——混合检索（pg_trgm + pgvector，RRF 融合，反馈加权）；code_ref 对不上当前代码的
   当场标为过期、不再使用；本任务谱系沉淀的排前面
3. 同类案例——按报错指纹精确匹配

命中的知识写 recall_hits（记忆页的"30 天命中"、零召回统计都来自它）。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from ..store import cases as cases_store
from ..store import knowledge as knowledge_store


@dataclass
class Recalled:
    text: str = ""
    knowledge: list[dict] = field(default_factory=list)    # [{id, key, rank}]
    case_id: int | None = None


async def recall(*, env: str, service: str, task: str, query: str, error_text: str = "",
                 code_paths: list[str], session_id: str | None, run_id: str | None,
                 limit: int = 5, embedder=None, source: str = "recall") -> Recalled:
    """source="playground" 表示控制台试检索，不计入命中统计。"""
    sections: list[str] = []
    out = Recalled()

    if session_id and session_id.count(":") >= 2:
        summaries = await knowledge_store.latest_session_summaries(env, session_id.rsplit(":", 1)[0])
        if summaries:
            sections.append("[前序会话交接摘要]\n" + "\n\n".join(s["content"] for s in summaries))

    if limit:
        fresh = []
        for e in await knowledge_store.search(env, service, query, limit=limit, embedder=embedder):
            if await asyncio.to_thread(knowledge_store.is_entry_fresh, e["code_ref"], code_paths):
                fresh.append(e)
            else:
                await knowledge_store.mark_expired(e["id"])
        if fresh:
            base = task.split(":")[0]
            mine = [e for e in fresh if e.get("task") in ("", task, base)]
            others = [e for e in fresh if e not in mine]          # 兄弟子任务的结论：排后并标来源
            ordered = mine + others
            out.knowledge = [{"id": e["id"], "key": e["key"], "rank": i + 1} for i, e in enumerate(ordered)]
            if run_id or source != "recall":
                await knowledge_store.record_hits(env, service, ordered, run_id=run_id, source=source)
            lines = ["[历史知识——过去运行沉淀，可能过时；与代码或数据矛盾时以实际为准]"]
            for e in ordered:
                origin = f"，沉淀自任务 {e['task']}" if e in others else ""
                lines.append(f"- {e['key']}: {e['content']}（来源运行 {e['source_run'] or '人工录入'}{origin}）")
            sections.append("\n".join(lines))

    if error_text:
        case = await cases_store.search_by_error(env, service, error_text)
        if case:
            out.case_id = case["id"]
            sections.append(f"[同类案例]\n- {case['date'][:10]} 的同类报错结论（{case['category']}，"
                            f"👍×{case['thumbs_up']}）：{case['conclusion']}")

    out.text = "\n\n".join(sections)
    return out
