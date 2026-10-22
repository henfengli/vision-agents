"""记忆层：运行前召回、运行后沉淀、定期整理。

- recall    运行前：交接摘要 → 历史知识 → 同类案例
- distill   运行后：一次轻量模型调用提炼知识与案例；有会话时写交接摘要
- gardener  定期：code_ref 漂移巡检

全部按 服务×环境 分区；连续性由记忆承载，不靠无限拉长的对话 thread。
"""

from .distill import distill
from .recall import Recalled, recall

__all__ = ["Recalled", "distill", "recall"]
