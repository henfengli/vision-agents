"""Run Viewer：自托管观测站点（run 详情/审批/对话/管理/记忆）。"""

from .routes import make_viewer_router

__all__ = ["make_viewer_router"]
