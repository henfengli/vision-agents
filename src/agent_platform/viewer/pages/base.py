"""页面共享基础设施：Jinja2 渲染、静态文件白名单、登录/登出。

模板集中在 templates/（base.html 骨架 + 一页一模板），样式在
static/app.css（设计系统），图渲染在 static/graph.js（cytoscape）。
静态目录走白名单放行，防目录穿越；字体与 cytoscape 已 vendor，内网离线可用。
"""

from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape

from ...api.auth import COOKIE_NAME

_DIR = Path(__file__).parents[1]
STATIC = _DIR / "static"

_env = Environment(
    loader=FileSystemLoader(_DIR / "templates"),
    autoescape=select_autoescape(("html",)),
    trim_blocks=True, lstrip_blocks=True)

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

_NAV = [("/", "总览"), ("/chat", "对话"), ("/runs", "Runs"),
        ("/approvals", "审批"), ("/admin", "管理"), ("/memory", "记忆")]


def render(template: str, title: str, active: str = "", nav: bool = True,
           **ctx) -> HTMLResponse:
    """统一渲染入口：骨架（顶栏导航/角标脚本）在 base.html，页面只给内容块。"""
    return HTMLResponse(_env.get_template(template).render(
        title=title, active=active, nav=nav, logo=_LOGO_SVG,
        nav_links=_NAV, auth_enabled=_AUTH_ENABLED, **ctx))


def esc(text: str) -> str:
    """给 JS 内嵌片段等模板外的角落用；模板里交给 autoescape，别手动调。"""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def make_static_router() -> APIRouter:
    router = APIRouter()
    allowed = {"app.css", "graph.js", "cytoscape.min.js", "cytoscape-dagre.min.js"}

    # filename:path 才能匹配 fonts/ 子目录（默认 path converter 不吃斜杠，字体曾因此 404）
    @router.get("/static/{filename:path}")
    async def static_file(filename: str):
        if filename in allowed:
            return FileResponse(STATIC / filename)
        if filename.startswith("fonts/") and filename.endswith(".woff2") \
                and "/" not in filename[6:]:
            return FileResponse(STATIC / filename)
        raise HTTPException(404)

    return router


def make_login_router(expected_token: str) -> APIRouter:
    """登录/登出：校验令牌写 httponly cookie。此路由自身不挂页面鉴权。"""
    router = APIRouter()

    @router.get("/login", response_class=HTMLResponse)
    async def login_page():
        return render("login.html", "登录", nav=False,
                      logo_big=_LOGO_SVG.replace('width="18" height="18"',
                                                 'width="34" height="34"'),
                      bad_token=False)

    @router.post("/login")
    async def login(request: Request):
        form = await request.form()
        token = str(form.get("token", ""))
        if not hmac.compare_digest(token, expected_token):
            return render("login.html", "登录", nav=False,
                          logo_big=_LOGO_SVG.replace('width="18" height="18"',
                                                     'width="34" height="34"'),
                          bad_token=True)
        resp = RedirectResponse("/", status_code=303)
        resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax")
        return resp

    @router.get("/logout")
    async def logout():
        resp = RedirectResponse("/login", status_code=303)
        resp.delete_cookie(COOKIE_NAME)
        return resp

    return router
