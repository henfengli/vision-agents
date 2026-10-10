"""SPA 静态托管：web/dist（React+Vite 构建产物）挂到 /。

构建只在有 node 的机器上做（开发机/打包机），运行机不需要 node——
dist 目录存在才挂载，不存在时 / 返回一行说明（API 照常可用）。
旧 viewer 的深链（钉钉卡片里的 /runs/{id}、/approvals/{id} 等）301 到
hash 路由，收藏夹与历史通知不死链。
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, RedirectResponse

log = logging.getLogger(__name__)

# 包内文件定位仓库根：src/agent_platform/web_static.py → 上三级
_DEFAULT_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

# 旧 viewer 路径 → SPA hash 路由（{id} 段保留）
_LEGACY = {"/runs": "/#/runs", "/approvals": "/#/approvals",
           "/graph": "/#/graph", "/chat": "/#/chat", "/memory": "/#/memory",
           "/admin": "/#/admin", "/login": "/"}


def mount_spa(app: FastAPI, dist: Path | None = None) -> None:
    dist = dist or _DEFAULT_DIST

    @app.get("/runs/{run_id}", include_in_schema=False)
    async def _legacy_run(run_id: str):
        return RedirectResponse(f"/#/runs/{run_id}", status_code=301)

    @app.get("/approvals/{run_id}", include_in_schema=False)
    async def _legacy_approval(run_id: str):
        return RedirectResponse(f"/#/approvals/{run_id}", status_code=301)

    for old, new in _LEGACY.items():
        async def _redir(_new=new):
            return RedirectResponse(_new, status_code=301)
        app.add_api_route(old, _redir, include_in_schema=False)

    if not dist.is_dir():
        log.warning("web/dist 不存在：SPA 未构建，仅 API 可用（web/ 下 npm run build)")

        @app.get("/", include_in_schema=False)
        async def _no_spa():
            return PlainTextResponse(
                "SPA 未构建：在 web/ 目录执行 npm install && npm run build",
                status_code=503)
        return

    from fastapi.staticfiles import StaticFiles
    app.mount("/", StaticFiles(directory=dist, html=True), name="spa")
    log.info("SPA 已托管：%s", dist)
