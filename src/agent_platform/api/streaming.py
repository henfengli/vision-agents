"""运行事件推流（SSE）：先补发已有事件，再跟着 pg_notify('run_events') 推新的，运行结束即收尾。

运行详情页（GET /v1/runs/{id}/stream）与对话（POST /v1/chat）共用。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from ..domain import TERMINAL
from ..store import db, runs

KEEPALIVE_S = 15.0


def sse(data: dict) -> str:
    return f"data: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def tail(run_id: str, after: int = 0) -> AsyncIterator[dict]:
    """依次产出 {"kind": "event", "event": …}，最后产出 {"kind": "done", "run": 台账行}。
    空闲时产出 {"kind": "keepalive"}，调用方据此写 SSE 注释保活。"""
    import psycopg

    try:
        listener = await psycopg.AsyncConnection.connect(db.dsn(), autocommit=True)
        await listener.execute("LISTEN run_events")
    except Exception:  # noqa: BLE001 —— 建不起监听就轮询
        listener = None
    seq = after
    try:
        while True:
            for e in await runs.events(run_id, after_seq=seq):
                seq = e["seq"]
                yield {"kind": "event", "event": e}
            run = await runs.get(run_id)
            if run is None or run["status"] in TERMINAL:
                for e in await runs.events(run_id, after_seq=seq):     # 收尾前最后补一次
                    seq = e["seq"]
                    yield {"kind": "event", "event": e}
                yield {"kind": "done", "run": run}
                return
            if await _wait(listener, run_id):
                continue
            yield {"kind": "keepalive"}
    finally:
        if listener is not None:
            await listener.close()


async def _wait(listener, run_id: str) -> bool:
    """等这个运行的新事件；有返回 True，超时返回 False。没有监听时每秒轮询一次。"""
    if listener is None:
        await asyncio.sleep(1.0)
        return True
    deadline = asyncio.get_running_loop().time() + KEEPALIVE_S
    while (left := deadline - asyncio.get_running_loop().time()) > 0:
        async for n in listener.notifies(timeout=left, stop_after=1):
            if n.payload == run_id:
                return True
        # 别的运行的通知或超时：继续等到截止
    return False
