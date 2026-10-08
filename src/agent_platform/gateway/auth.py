"""固定 bearer token 鉴权：服务间调用只有一个令牌，不做用户体系。"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_scheme = HTTPBearer(auto_error=False)


def make_auth_dependency(expected_token: str):
    async def verify(cred: HTTPAuthorizationCredentials | None = Depends(_scheme)):
        if cred is None or cred.credentials != expected_token:
            raise HTTPException(status_code=401, detail="无效的访问令牌")
    return verify
