"""执行中的进度：bash / py 跑得久时，每几秒把输出尾部写进 runs.progress，运行详情的"执行中"显示它。

一次工具调用一个键（同一条消息里并发的几个调用各占一个）。结束时先等已经发出去的写入落完再删键，
免得迟到的写入把刚删的键又写回来；运行结束时 set_status 整列清空，兜底。
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from ...store import runs

log = logging.getLogger(__name__)


class Progress:
    def __init__(self, run_id: str, tool: str, title: str = "") -> None:
        self._run_id = run_id
        self._key = f"{tool}-{uuid.uuid4().hex[:8]}"
        self._tool = tool
        self._title = title[:200]
        self._loop = asyncio.get_running_loop()
        self._pending: list = []
        self._lock = asyncio.Lock()     # 按发出的顺序写：旧的尾部不会盖掉新的

    async def update(self, output: str, ms: int) -> None:
        """在事件循环里调用（py 内核的进度回调）。"""
        try:
            async with self._lock:
                await runs.set_progress(self._run_id, self._key, self._payload(output, ms))
        except Exception:  # noqa: BLE001 —— 进度写不进去不影响执行
            log.debug("进度写入失败", exc_info=True)

    def push(self, output: str, ms: int) -> None:
        """在别的线程里调用（bash 的等待循环）：丢给事件循环去写。"""
        fut = asyncio.run_coroutine_threadsafe(self.update(output, ms), self._loop)
        self._pending.append(fut)

    async def done(self) -> None:
        if self._pending:
            await asyncio.gather(*(asyncio.wrap_future(f) for f in self._pending), return_exceptions=True)
        try:
            await runs.clear_progress(self._run_id, self._key)
        except Exception:  # noqa: BLE001
            log.debug("进度清理失败", exc_info=True)

    def _payload(self, output: str, ms: int) -> dict:
        return {"tool": self._tool, "title": self._title, "output": output[-2000:], "ms": ms}
