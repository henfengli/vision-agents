"""页面共享基础设施：HTML 骨架、转义、静态文件。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

STATIC = Path(__file__).parents[1] / "static"

_PAGE = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>{title} - agent-platform</title>
<style>
body {{ font-family: -apple-system, "PingFang SC", monospace; max-width: 1100px;
       margin: 24px auto; padding: 0 16px; color: #222; }}
.card {{ border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin: 12px 0; }}
pre {{ background: #f6f8fa; padding: 12px; border-radius: 6px;
      overflow-x: auto; white-space: pre-wrap; word-break: break-all; }}
.status-success {{ color: #1a7f37; }} .status-failed {{ color: #cf222e; }}
.status-running, .status-queued {{ color: #9a6700; }}
button {{ padding: 6px 16px; margin-right: 8px; cursor: pointer; }}
input, textarea, select {{ padding: 6px; margin: 4px 0; width: 100%; box-sizing: border-box; }}
.meta {{ color: #666; font-size: 13px; }}
.step {{ border-left: 3px solid #ddd; padding: 8px 12px; margin: 8px 0;
        border-radius: 0 6px 6px 0; background: #fafafa; }}
.step-thought {{ border-color: #8250df; }}
.step-tool_call {{ border-color: #9a6700; }}
.step-tool_result {{ border-color: #1a7f37; }}
.step-final, .step-llm {{ border-color: #0550ae; background: #ddf4ff; }}
.step-note {{ border-color: #ccc; color: #666; }}
.tag {{ display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px;
       background: #eaeef2; margin-right: 6px; }}
details summary {{ cursor: pointer; color: #0550ae; }}
#graph {{ overflow-x: auto; }}
.gnode {{ cursor: pointer; }}
.gnode rect {{ fill: #f6f8fa; stroke: #bbb; rx: 6; }}
.gnode.executed rect {{ fill: #bbf7d0; stroke: #16a34a; }}
.gnode.active rect {{ fill: #fef3c7; stroke: #d97706; stroke-width: 2; }}
.gnode.failed rect {{ fill: #fecaca; stroke: #dc2626; stroke-width: 2; }}
.gnode text {{ font-size: 12px; }}
.gedge {{ stroke: #999; fill: none; marker-end: url(#arrow); }}
</style></head><body>{body}</body></html>"""


def page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(_PAGE.format(title=title, body=body))


def esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def make_static_router() -> APIRouter:
    router = APIRouter()

    @router.get("/static/{filename}")
    async def static_file(filename: str):
        if filename not in ("dagre.min.js", "graph.js"):
            raise HTTPException(404)
        return FileResponse(STATIC / filename)

    return router
