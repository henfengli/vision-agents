"""接入层：FastAPI 应用与 /v1 业务路由。"""

from .app import create_app, make_api_router

__all__ = ["create_app", "make_api_router"]
