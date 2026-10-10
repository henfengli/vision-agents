"""鉴权：固定 bearer token（服务间）+ Viewer cookie（浏览器）。

不做用户体系，只有一个令牌，两种携带方式：
- /v1/* API：Authorization: Bearer <token>；同源浏览器 fetch 自动带 cookie 也可
- Viewer 页面：httponly cookie；无/错 → 307 跳 /login
令牌比较一律 hmac.compare_digest，避免时序侧信道。
"""

from __future__ import annotations

import hmac

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_scheme = HTTPBearer(auto_error=False)

COOKIE_NAME = "agent_token"


def make_auth_dependency(expected_token: str):
    """/v1/* 用：bearer 优先，同源 cookie 兜底（Viewer 页内 JS 调 API 的场景）。"""
    async def verify(request: Request,
                     cred: HTTPAuthorizationCredentials | None = Depends(_scheme)):
        token = cred.credentials if cred is not None else request.cookies.get(COOKIE_NAME)
        if not token or not hmac.compare_digest(token, expected_token):
            raise HTTPException(status_code=401, detail="无效的访问令牌")
    return verify


def make_viewer_auth_dependency(expected_token: str):
    """页面用：未登录跳 /login，而不是吐 JSON 401（浏览器体验）。"""
    async def verify(request: Request):
        token = request.cookies.get(COOKIE_NAME, "")
        if not hmac.compare_digest(token, expected_token):
            raise HTTPException(status_code=307, headers={"Location": "/login"})
    return verify
