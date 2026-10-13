"""页面共享基础设施：Jinja2 渲染、静态文件白名单、登录/登出。

模板集中在 templates/（base.html 骨架 + 一页一模板），样式在
static/app.css（设计系统），图渲染在 static/graph.js（cytoscape）。
静态目录走白名单放行，防目录穿越；字体与 cytoscape 已 vendor，内网离线可用。
"""

from __future__ import annotations

import hmac
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

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


def _parse_ts(t) -> datetime | None:
    """接受 datetime 或 ISO 字符串；解析不了返回 None（模板显示 '-'）。"""
    if t is None or t == "":
        return None
    if isinstance(t, datetime):
        return t
    try:
        return datetime.fromisoformat(str(t).replace("Z", "+00:00"))
    except ValueError:
        return None


def _reltime(t) -> str:
    """相对时间（全站时间显示的唯一口径）：刚刚/N 分钟前/N 小时前/N 天前/日期。"""
    dt = _parse_ts(t)
    if dt is None:
        return "-"
    now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
    secs = max(0.0, (now - dt).total_seconds())
    if secs < 90:
        return "刚刚"
    if secs < 3600:
        return f"{int(secs // 60)} 分钟前"
    if secs < 86400:
        return f"{int(secs // 3600)} 小时前"
    if secs < 7 * 86400:
        return f"{int(secs // 86400)} 天前"
    return dt.strftime("%Y-%m-%d")


def _abstime(t) -> str:
    dt = _parse_ts(t)
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else ""


def _dur(ms) -> str:
    """毫秒 → 人类可读时长（820ms / 2.3s / 3.2 min / 1.2 h）。"""
    if ms is None:
        return "-"
    ms = int(ms)
    if ms < 1000:
        return f"{ms}ms"
    secs = ms / 1000
    if secs < 60:
        return f"{secs:.1f}s"
    if secs < 3600:
        return f"{secs / 60:.1f} min"
    return f"{secs / 3600:.1f} h"


_env.filters.update({"reltime": _reltime, "abstime": _abstime, "dur": _dur})


def page_url(request: Request, **over) -> str:
    """列表页「URL 即状态」助手：当前 query + 覆盖项（空值=删除该参数）。

    过滤/排序变化由调用方传 cursor 清空（c="" / p=""），分页则带上光标。
    模板里以 u(...) 调用（handler 里 functools.partial(page_url, request)）。
    """
    params = dict(request.query_params)
    params.update(over)
    params = {k: v for k, v in params.items() if v not in ("", None)}
    qs = urlencode(params)
    return request.url.path + ("?" + qs if qs else "")

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
        ("/approvals", "审批"), ("/admin", "管理"), ("/memory", "记忆"),
        ("/assets", "资产")]


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
    allowed = {"app.css", "graph.js", "admin.js", "memory.js", "assets.js",
               "ts.js", "cytoscape.min.js",
               "cytoscape-dagre.min.js", "marked.min.js", "dompurify.min.js"}

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
