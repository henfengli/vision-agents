"""路由共用的依赖：Runtime 与调用方身份。"""

from __future__ import annotations

from fastapi import Depends, Request

from ..domain import Caller
from ..runtime import Runtime
from .auth import admin_caller, current_caller


def get_runtime(request: Request) -> Runtime:
    return request.app.state.rt


RT = Depends(get_runtime)
WHO = Depends(current_caller)        # 任何有效凭据
ADMIN = Depends(admin_caller)        # admin 范围的密钥 / 控制台管理员

__all__ = ["ADMIN", "Caller", "RT", "Runtime", "WHO"]
