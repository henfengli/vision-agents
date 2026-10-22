"""记忆：agent 记下的东西（人写的是档案，在定义里；可执行的做法是方法，在 assets）。

一张表三种 kind：fact 事实 / lesson 报错教训（带指纹）/ handoff 会话交接摘要。
env='' 的条目对该服务所有环境成立。子模块按职责拆分：
- crud       写入/读取/网页编辑
- lessons    教训：报错指纹与同类报错命中
- retrieval  混合检索（trgm+vector RRF）与 code_ref 新鲜度
- temporal   时序化（supersede / expire）
- listing    列表、健康度、可升格的记忆（控制台读口）
- profiles   会话交接摘要
"""

from . import lessons
from .crud import (by_source_run, evolution_chain, get_entry, list_all, list_by_service, list_content_history,
                   restore, restore_content, service_stats, similar_pairs, supersede_entry, update_content, upsert)
from .listing import entry, find, health, list_entries, promotable
from .profiles import latest_session_summaries
from .retrieval import code_base, current_commit, is_entry_fresh, search
from .temporal import mark_expired, supersede_by_runs, supersede_keys
from .usage import hits_for_run, record_hits, recent_hits, usage_map

__all__ = [
    "by_source_run", "entry", "find", "health", "list_entries", "promotable", "lessons",
    "upsert", "get_entry", "update_content", "list_by_service", "list_all", "supersede_entry",
    "search", "current_commit", "is_entry_fresh", "code_base",
    "supersede_by_runs", "supersede_keys", "mark_expired",
    "latest_session_summaries",
    "service_stats", "evolution_chain", "similar_pairs", "restore",
    "list_content_history", "restore_content",
    "hits_for_run", "record_hits", "recent_hits", "usage_map",
]
