"""知识库：统一出口。子模块按职责拆分：
- crud       写入/读取/网页编辑
- retrieval  混合检索（trgm+vector RRF）与 code_ref 新鲜度
- temporal   时序化（supersede / expire）
- profiles   资产档案与 session 交接摘要
"""

from .crud import (by_source_run, domain_stats, evolution_chain,
                   get_entry, list_all,
                   list_by_domain, list_content_history, restore,
                   restore_content, similar_pairs, update_content, upsert)
from .profiles import latest_session_summaries
from .retrieval import code_base, current_commit, is_entry_fresh, search
from .temporal import mark_expired, supersede_by_runs, supersede_keys
from .usage import hits_for_run, record_hits, recent_hits, usage_map

__all__ = [
    "by_source_run",
    "upsert", "get_entry", "update_content", "list_by_domain", "list_all",
    "search", "current_commit", "is_entry_fresh", "code_base",
    "supersede_by_runs", "supersede_keys", "mark_expired",
    "latest_session_summaries",
    "domain_stats", "evolution_chain", "similar_pairs", "restore",
    "list_content_history", "restore_content",
    "hits_for_run", "record_hits", "recent_hits", "usage_map",
]
