"""对话触发：CLI 与 Web 对话页共用。

session_id 是会话唯一标识——同一 session 自动续上下文，跨进程可恢复。

/v1/chat/stream 是 SSE 流式版：run 由后台 worker 执行、每步事件落台账，
本端点按 seq 增量轮询台账转发为 SSE——跨进程可靠，worker 与 HTTP
不在同一事件循环也不受影响。
"""

from __future__ import annotations

import asyncio
import json
import uuid

from pydantic import BaseModel

from ..store import runs

_SSE_TIMEOUT_S = 300
_POLL_S = 0.3


class ChatRequest(BaseModel):
    server: str                    # 业务域
    role: str
    question: str
    session_id: str | None = None


def make_router(submitter):
    from fastapi import APIRouter

    router = APIRouter()

    @router.post("/v1/chat")
    async def chat(req: ChatRequest):
        session_id = req.session_id or uuid.uuid4().hex[:12]
        result = await submitter.run_sync(
            "data-qa",
            {"server": req.server, "question": req.question},
            trigger_source="cli", session_id=session_id, role=req.role)
        return {**result, "session_id": session_id}

    @router.post("/v1/chat/stream")
    async def chat_stream(req: ChatRequest):
        from fastapi.responses import StreamingResponse

        session_id = req.session_id or uuid.uuid4().hex[:12]
        submitted = await submitter.submit(
            "data-qa",
            {"server": req.server, "question": req.question},
            trigger_source="web_chat", session_id=session_id, role=req.role)

        async def events():
            yield _sse({"type": "run", "run_id": submitted["run_id"],
                        "session_id": session_id})
            last_seq, waited = 0, 0.0
            while waited < _SSE_TIMEOUT_S:
                new = [e for e in await runs.get_events(submitted["run_id"])
                       if e["seq"] > last_seq]
                for e in new:
                    last_seq = e["seq"]
                    yield _sse({"type": e["kind"], **e["payload"]})
                run = await runs.get(submitted["run_id"])
                if run and run["status"] in ("success", "failed"):
                    yield _sse({"type": "final", "status": run["status"],
                                "output": run.get("output")})
                    return
                await asyncio.sleep(_POLL_S)
                waited += _POLL_S
            yield _sse({"type": "timeout", "run_id": submitted["run_id"]})

        return StreamingResponse(events(), media_type="text/event-stream")

    return router


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
