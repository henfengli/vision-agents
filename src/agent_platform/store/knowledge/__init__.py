"""知识库：统一出口。子模块按职责拆分：
- crud       写入/读取/网页编辑
- retrieval  混合检索（trgm+vector RRF）与 code_ref 新鲜度
- temporal   时序化（supersede / expire）
- listing    列表与健康度（控制台读口）
- profiles   会话交接摘要
"""

from .crud import (
                   by_source_run,
                   evolution_chain,
                   get_entry,
                   list_all,
                   list_by_service,
                   list_content_history,
                   restore,
                   restore_content,
                   service_stats,
                   similar_pairs,
                   update_content,
                   upsert,
)
from .listing import entry, find, health, list_entries
from .profiles import latest_session_summaries
from .retrieval import code_base, current_commit, is_entry_fresh, search
from .temporal import mark_expired, supersede_by_runs, supersede_keys
from .usage import hits_for_run, recent_hits, record_hits, usage_map

__all__ = [
                   "by_source_run",
                   "code_base",
                   "current_commit",
                   "entry",
                   "evolution_chain",
                   "find",
                   "get_entry",
                   "health",
                   "hits_for_run",
                   "is_entry_fresh",
                   "latest_session_summaries",
                   "list_all",
                   "list_by_service",
                   "list_content_history",
                   "list_entries",
                   "mark_expired",
                   "recent_hits",
                   "record_hits",
                   "restore",
                   "restore_content",
                   "search",
                   "service_stats",
                   "similar_pairs",
                   "supersede_by_runs",
                   "supersede_keys",
                   "update_content",
                   "upsert",
                   "usage_map",
]
