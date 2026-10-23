"""鉴权：每个请求解析出一个 Caller（谁在调用）。只认身份，不分权限：有效凭据都能做全部操作。

凭据三种，任选其一：
- Authorization: Bearer <密钥>      项目 / 脚本 / SDK
- X-Gitlab-Token: <密钥>            GitLab Webhook 只能这样带
- Cookie ap_session                 控制台登录（POST /auth/session 用密钥换取，带上操作人姓名）

密钥是设置 → API 密钥里建的（库里只存哈希），或部署配置里的 root_token（引导用：第一次登录、建第一把密钥）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

from fastapi import Request

from ..domain import Caller, Rejected
from ..store import api_keys

COOKIE = "ap_session"
COOKIE_MAX_AGE = 14 * 24 * 3600


async def caller_for_token(request: Request, token: str, person: str | None = None) -> Caller | None:
    rt = request.app.state.rt
    token_digest = api_keys.digest(token)
    return await _caller_for_digest(rt, token_digest, person)


async def _caller_for_digest(rt, token_digest: str, person: str | None) -> Caller | None:
    if hmac.compare_digest(token_digest, api_keys.digest(rt.settings.root_token)):
        return Caller(name=person or "root", kind="user" if person else "root")
    key = await api_keys.authenticate(token_digest)
    if key is None:
        return None
    return Caller(name=person or key["name"], kind="user" if person else "key")


async def current_caller(request: Request) -> Caller:
    rt = request.app.state.rt
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else request.headers.get("x-gitlab-token")
    if token:
        who = await caller_for_token(request, token)
        if who is None:
            raise Rejected("unauthorized", "密钥无效、已吊销或已过期", 401)
        return who
    session = read_session(rt.settings.root_token, request.cookies.get(COOKIE, ""))
    if session:
        who = await _caller_for_digest(rt, session["t"], session["n"])
        if who is not None:
            return who
    raise Rejected("unauthorized", "需要登录或提供 API 密钥（Authorization: Bearer …）", 401)


# —— 控制台会话 cookie：{t: 密钥摘要, n: 操作人}，用 root_token 做 HMAC 签名 ——

def make_session(secret: str, token: str, person: str) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"t": api_keys.digest(token), "n": person}).encode()).decode()
    return f"{body}.{_sign(secret, body)}"


def read_session(secret: str, value: str) -> dict | None:
    body, _, sig = value.partition(".")
    if not body or not hmac.compare_digest(sig, _sign(secret, body)):
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(body))
    except ValueError:
        return None


def _sign(secret: str, body: str) -> str:
    return hmac.new(hashlib.sha256(secret.encode()).digest(), body.encode(), hashlib.sha256).hexdigest()[:32]
