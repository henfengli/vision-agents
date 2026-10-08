"""记忆层：run 前后的记忆读写。

- recall   运行前召回（档案 → 交接摘要 → 历史知识 → 同类案例）
- distill  运行后沉淀（知识/案例入库 + session 交接摘要）

连续性由记忆层承载，不靠无限拉长的对话 thread：
session 是 episode（一次一个问题），跨 episode 靠召回接起来。
"""

from .distill import distill
from .recall import recall_block

__all__ = ["distill", "recall_block"]
