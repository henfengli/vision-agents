"""模型层：内部统一模型 API（OpenAI 兼容）的连接池。"""

from .pool import ModelPool, ModelPoolError

__all__ = ["ModelPool", "ModelPoolError"]
