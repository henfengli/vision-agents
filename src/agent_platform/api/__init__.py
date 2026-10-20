"""/v1 接口。app 装配应用；routes/ 按资源分文件；schemas 是请求体，views 是响应形状。

接口总览与参数说明见 docs/外部接口文档.md；运行时的 OpenAPI 在 /v1/docs。
"""

from .app import create_app

__all__ = ["create_app"]
