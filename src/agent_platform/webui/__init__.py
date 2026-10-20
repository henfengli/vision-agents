"""控制台托管：web/ 构建出的单页应用（dist/）。

/assets/* 是带内容哈希的静态文件（长缓存）；其余非接口路径一律回 index.html，由前端路由接管。
没构建过前端时给一个说明页，接口照常可用。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>agent-platform</title>
<body style="font:14px system-ui;margin:48px;color:#333">
<h3>控制台尚未构建</h3><p>在仓库的 web/ 目录执行 <code>npm ci && npm run build</code>，产物输出到
<code>src/agent_platform/webui/dist</code>。接口文档：<a href="/v1/docs">/v1/docs</a></p>"""

_API_PREFIXES = ("v1/", "auth/", "healthz")


def mount_console(app: FastAPI, dist: Path) -> None:
    index = dist / "index.html"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def console(path: str):
        if path.startswith(_API_PREFIXES):
            return JSONResponse({"error": {"code": "not_found", "message": f"/{path} 不存在", "detail": None}},
                                status_code=404)
        static = dist / path
        if path and static.is_file() and static.resolve().is_relative_to(dist.resolve()):
            return FileResponse(static)
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return HTMLResponse(_NOT_BUILT)
