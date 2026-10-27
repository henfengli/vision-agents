"""运行前召回：把过去记下的东西拼成一段文字，放进本次运行的提示里（档案另起一块，不走召回）。

自上而下三层：
1. 前序会话交接摘要——同一类事件的上一个会话结论（会话名形如 dagster:<asset>:<错误类>:<日期>，
   去掉最后一段就是"同一类"）
2. 同类报错的教训——按报错指纹精确命中（有报错输入时）
3. 记忆检索——事实与教训一起混合检索（pg_trgm + pgvector，RRF 融合，👎 扣分）；
   本环境的 + 所有环境通用的；code_ref 对不上当前代码的当场标为过期、不再使用；本任务谱系沉淀的排前面

命中的条目写 recall_hits（记忆页的"30 天命中"、零召回、可升格统计都来自它；运行被 👎 时也据此给召回的条目扣分）。

回归重放（exclude_run = 被重放的原运行）：三层都去掉原运行自己沉淀的；交接摘要不含原会话自己的那条，
也只要原运行之前就有的（before）；只读——不记命中、不标过期（过期的照样不用）。
同一个 key 后来被别的运行改写过的，按最后写入者算，不再当作原运行的沉淀。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from ..store import knowledge as knowledge_store


@dataclass
class Recalled:
    text: str = ""
    knowledge: list[dict] = field(default_factory=list)    # [{id, key, kind, rank}]
    case_id: int | None = None                             # 精确命中的那条教训


async def recall(*, env: str, service: str, task: str, query: str, error_text: str = "",
                 code_paths: list[str], session_id: str | None, run_id: str | None,
                 limit: int = 5, embedder=None, exclude_run: str | None = None,
                 before: str | None = None) -> Recalled:
    """exclude_run：回归重放的原运行（见模块说明）；before：原运行的创建时间，交接摘要只要那之前就有的。"""
    sections: list[str] = []
    out = Recalled()
    readonly = exclude_run is not None

    if session_id and session_id.count(":") >= 2:
        summaries = await knowledge_store.latest_session_summaries(
            env, service, session_id.rsplit(":", 1)[0], exclude_session=session_id if readonly else None,
            before=before if readonly else None)
        if summaries:
            sections.append("[前序会话交接摘要]\n" + "\n\n".join(s["content"] for s in summaries))

    lesson = (await knowledge_store.lessons.search_by_error(env, service, error_text, exclude_run=exclude_run)
              if error_text else None)
    if lesson:
        out.case_id = lesson["id"]
        sections.append(f"[同类报错的教训——{lesson['date'][:10]} 记下，类别 {lesson['category'] or '—'}；"
                        f"先验证是否同一原因再下结论]\n{lesson['conclusion']}")

    hits: list[dict] = [{"id": lesson["id"], "key": lesson["key"]}] if lesson else []
    if limit:
        fresh = []
        for e in await knowledge_store.search(env, service, query, limit=limit, embedder=embedder,
                                              exclude_run=exclude_run):
            if lesson and e["id"] == lesson["id"]:
                continue
            if await asyncio.to_thread(knowledge_store.is_entry_fresh, e["code_ref"], code_paths):
                fresh.append(e)
            elif not readonly:
                await knowledge_store.mark_expired(e["id"])
        if fresh:
            base = task.split(":")[0]
            mine = [e for e in fresh if e.get("task") in ("", task, base)]
            others = [e for e in fresh if e not in mine]          # 兄弟子任务的结论：排后并标来源
            ordered = mine + others
            hits += ordered
            lines = ["[记忆——过去运行记下的，可能过时；与代码或数据矛盾时以实际为准并指出]"]
            for e in ordered:
                notes = [f"来源运行 {e['source_run']}" if e["source_run"] else "人工录入"]
                if e.get("kind") == "lesson":
                    notes.insert(0, "报错教训")
                if e.get("env"):
                    notes.append(f"仅 {e['env']} 环境")
                if e in others:
                    notes.append(f"记自任务 {e['task']}")
                lines.append(f"- {e['key']}: {e['content']}（{'，'.join(notes)}）")
            sections.append("\n".join(lines))

    out.knowledge = [{"id": e["id"], "key": e["key"], "kind": e.get("kind", "lesson"), "rank": i + 1}
                     for i, e in enumerate(hits)]
    if hits and run_id and not readonly:
        await knowledge_store.record_hits(env, service, hits, run_id=run_id)
    out.text = "\n\n".join(sections)
    return out
