"""页面共享基础设施：HTML 骨架（顶栏导航）、转义、静态文件、登录页。

样式集中在 static/app.css（设计系统），图渲染在 static/graph.js（cytoscape）。
静态目录走白名单放行，防目录穿越；字体与 cytoscape 已 vendor，内网离线可用。
"""

from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from ...api.auth import COOKIE_NAME

STATIC = Path(__file__).parents[1] / "static"

# 由 routes.py 装配时设置：是否开启令牌登录（决定顶栏显不显示"退出"）
_AUTH_ENABLED = False


def set_auth_enabled(v: bool) -> None:
    global _AUTH_ENABLED
    _AUTH_ENABLED = v


# 雷达 logo：同心圆 + 旋转扫描线（CSS 动画， reduced-motion 时静止）
_LOGO_SVG = """<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
<circle cx="9" cy="9" r="7.5" stroke="#22d3ee" stroke-opacity="0.5"/>
<circle cx="9" cy="9" r="4" stroke="#22d3ee" stroke-opacity="0.8"/>
<circle cx="9" cy="9" r="1.4" fill="#22d3ee"/>
<line x1="9" y1="9" x2="15.5" y2="5" stroke="#22d3ee" stroke-width="1.2"
  stroke-linecap="round"><animateTransform attributeName="transform" type="rotate"
  from="0 9 9" to="360 9 9" dur="4.2s" repeatCount="indefinite"/></line></svg>"""

_NAV = [("/graph", "总览"), ("/chat", "对话"), ("/runs", "Runs"),
        ("/admin", "管理"), ("/memory", "记忆")]

_HEAD = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · agent-platform</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'><circle cx='9' cy='9" r='7' fill='none' stroke='%2322d3ee'/><circle cx='9' cy='9' r='2' fill='%2322d3ee'/></svg>">
</head><body>{body}</body></html>"""


def page(title: str, body: str, active: str = "", nav: bool = True) -> HTMLResponse:
    """统一页面骨架。active 传 nav 路径用于高亮；登录页 nav=False。"""
    if nav:
        links = "".join(
            f'<a href="{href}"{" class=active" if href == active else ""}>{label}</a>'
            for href, label in _NAV)
        logout = '<a href="/logout" class="meta">退出</a>' if _AUTH_ENABLED else ""
        body = f"""
<header class="topbar">
  <a class="brand" href="/graph">{_LOGO_SVG}agent-platform</a>
  <nav class="nav">{links}</nav>
  <span class="meta"><span class="led live"></span>LIVE</span>
  {logout}
</header>
<main class="wrap">{body}</main>"""
    return HTMLResponse(_HEAD.format(title=title, body=body))


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def status_pill(status: str) -> str:
    """运行状态徽章：running/queued 带呼吸灯。"""
    return (f'<span class="pill pill-{status}"><span class="led"></span>'
            f'{status}</span>')


def make_static_router() -> APIRouter:
    router = APIRouter()
    allowed = {"app.css", "graph.js", "cytoscape.min.js", "cytoscape-dagre.min.js"}

    @router.get("/static/{filename}")
    async def static_file(filename: str):
        if filename in allowed:
            return FileResponse(STATIC / filename)
        if filename.startswith("fonts/") and filename.endswith(".woff2") \
                and "/" not in filename[6:]:
            return FileResponse(STATIC / filename)
        raise HTTPException(404)

    return router


_LOGIN_BODY = """
<div class="login-wrap"><div class="login-card">
  <div class="logo">""" + _LOGO_SVG.replace('width="18" height="18"',
                                            'width="34" height="34"') + """</div>
  <h2>agent-platform</h2>
  <span class="meta">内网 Agent 服务 · 输入访问令牌</span>
  <form method="post" action="/login">
    <input type="password" name="token" placeholder="ACCESS TOKEN" autofocus>
    <button type="submit">进入 →</button>
  </form>
  {hint}
</div></div>
"""


def make_login_router(expected_token: str) -> APIRouter:
    """登录/登出：校验令牌写 httponly cookie。此路由自身不挂页面鉴权。"""
    router = APIRouter()

    @router.get("/login", response_class=HTMLResponse)
    async def login_page():
        return page("登录", _LOGIN_BODY.format(hint=""), nav=False)

    @router.post("/login")
    async def login(request: Request):
        form = await request.form()
        token = str(form.get("token", ""))
        if not hmac.compare_digest(token, expected_token):
            return page("登录", _LOGIN_BODY.format(
                hint='<span class="err-hint">令牌不正确</span>'), nav=False)
        resp = RedirectResponse("/graph", status_code=303)
        resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax")
        return resp

    @router.get("/logout")
    async def logout():
        resp = RedirectResponse("/login", status_code=303)
        resp.delete_cookie(COOKIE_NAME)
        return resp

    return router
