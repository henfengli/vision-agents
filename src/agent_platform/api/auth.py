"""鉴权：固定 bearer token（服务间与 SPA 共用）。

不做用户体系，只有一个令牌：Authorization: Bearer <token>。
SPA 登录页输入令牌存 localStorage，之后每个 /v1 请求都带上。
令牌比较用 hmac.compare_digest，避免时序侧信道。
"""

from __future__ import annotations

import hmac

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_scheme = HTTPBearer(auto_error=False)


def make_auth_dependency(expected_token: str):
    """/v1/* 统一鉴权：bearer token 不匹配即 401。"""
    async def verify(cred: HTTPAuthorizationCredentials | None = Depends(_scheme)):
        token = cred.credentials if cred is not None else ""
        if not token or not hmac.compare_digest(token, expected_token):
            raise HTTPException(status_code=401, detail="无效的访问令牌")
    return verify
