"""FastAPI 应用：挂路由、统一错误体、托管控制台。

错误一律是 {"error": {"code", "message", "detail"}}；code 是稳定的原因码（见 domain/errors.py）。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from .. import __version__
from ..config import Settings
from ..domain import Rejected
from ..runtime import assemble
from ..webui import mount_console
from .routes import approvals, chat, definitions, feedback, memory, meta, runs, services, settings, tasks

log = logging.getLogger(__name__)


def error(status: int, code: str, message: str, detail=None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "detail": detail}}, status_code=status)


def create_app(cfg: Settings, *, worker: bool = True) -> FastAPI:
    """worker=True：本进程同时跑 Temporal Worker 与维护循环（单机部署的默认方式）。"""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        rt = await assemble(cfg)
        if worker:
            await rt.start_worker()
        app.state.rt = rt
        try:
            yield
        finally:
            await rt.close()

    app = FastAPI(title="agent-platform", version=__version__, lifespan=lifespan,
                  docs_url="/v1/docs", openapi_url="/v1/openapi.json", redoc_url=None)

    @app.exception_handler(Rejected)
    async def on_rejected(_: Request, e: Rejected):
        return error(e.status, e.code, e.message, e.detail)

    @app.exception_handler(RequestValidationError)
    async def on_invalid(_: Request, e: RequestValidationError):
        fields = {".".join(str(x) for x in err["loc"][1:]): err["msg"] for err in e.errors()}
        return error(422, "invalid_request", "请求参数不合法：" + "；".join(f"{k} {v}" for k, v in fields.items()), fields)

    @app.exception_handler(HTTPException)
    async def on_http(_: Request, e: HTTPException):
        return error(e.status_code, "not_found" if e.status_code == 404 else f"http_{e.status_code}", str(e.detail))

    @app.exception_handler(Exception)
    async def on_crash(request: Request, e: Exception):
        log.exception("%s %s 出错", request.method, request.url.path)
        return error(500, "internal", f"服务内部错误：{type(e).__name__}")

    @app.get("/healthz")
    async def healthz():
        return {"ok": True, "version": __version__, "profile": cfg.profile}

    for r in (meta, definitions, tasks, services, runs, feedback, chat, approvals, memory, settings):
        app.include_router(r.router)
    mount_console(app, cfg.webui_dist)
    return app
