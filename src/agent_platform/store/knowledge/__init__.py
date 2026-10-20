"""知识库：统一出口。子模块按职责拆分：
- crud       写入/读取/网页编辑
- retrieval  混合检索（trgm+vector RRF）与 code_ref 新鲜度
- temporal   时序化（supersede / expire）
- listing    列表与健康度（控制台读口）
- profiles   会话交接摘要
"""

from .crud import (by_source_run, service_stats, evolution_chain,
                   get_entry, list_all,
                   list_by_service, list_content_history, restore,
                   restore_content, similar_pairs, update_content, upsert)
from .listing import entry, find, health, list_entries
from .profiles import latest_session_summaries
from .retrieval import code_base, current_commit, is_entry_fresh, search
from .temporal import mark_expired, supersede_by_runs, supersede_keys
from .usage import hits_for_run, record_hits, recent_hits, usage_map

__all__ = [
    "by_source_run", "entry", "find", "health", "list_entries",
    "upsert", "get_entry", "update_content", "list_by_service", "list_all",
    "search", "current_commit", "is_entry_fresh", "code_base",
    "supersede_by_runs", "supersede_keys", "mark_expired",
    "latest_session_summaries",
    "service_stats", "evolution_chain", "similar_pairs", "restore",
    "list_content_history", "restore_content",
    "hits_for_run", "record_hits", "recent_hits", "usage_map",
]
