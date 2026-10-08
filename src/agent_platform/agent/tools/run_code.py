"""run_code：在沙箱子进程里执行 agent 生成的 Python，桩函数经 RPC 调回宿主工具。

进程模型：宿主把代码写入 scratch 临时文件，以 `python3 -c DRIVER <代码文件> <桩名列表>`
启动子进程（bwrap 沙箱包装见 sandbox.py）；子进程内桩函数（driver.py 生成）
把调用按行协议写到 stdout，宿主执行白名单工具后经 stdin 回传结果。

行协议（stdout 一行一消息）：
- 子→宿：`\x00RPC {"id": n, "call": 工具名, "args": [...], "kwargs": {...}}`
- 宿→子（stdin）：`{"id": n, "result": ...}` 或 `{"id": n, "error": "..."}`
- 其余 stdout 行 = 用户 print 输出

健壮性：stderr 与 stdout 并发消费（否则子进程写满 64KB 管道缓冲即死锁）；
输出与 stderr 均设上限，防止打满内存。
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import sandbox
from .driver import DRIVER

_MAX_OUTPUT_CHARS = 200_000   # 用户输出累计上限
_MAX_STDERR_CHARS = 64_000    # stderr 累计上限


async def execute_code(
    code: str,
    host_tools: dict[str, Callable[..., Awaitable[Any]]],
    scratch_dir: str,
    timeout: float = 120.0,
) -> str:
    """执行 code，返回给 agent 的文本（输出 + 调用统计 / 错误）。"""
    with tempfile.NamedTemporaryFile(
            "w", suffix=".py", dir=scratch_dir, delete=False,
            encoding="utf-8") as f:
        f.write(code)
        code_path = f.name

    argv = sandbox.wrap_argv(
        ["python3", "-c", DRIVER, code_path, json.dumps(list(host_tools))],
        scratch_dir)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    output: list[str] = []
    output_chars = 0
    stderr_parts: list[str] = []
    stderr_chars = 0
    calls = 0

    async def _serve() -> None:
        """消费 stdout：RPC 行派发给宿主工具，普通行进输出。读到 EOF 为止。"""
        nonlocal output_chars, calls
        assert proc.stdout is not None and proc.stdin is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = line.decode(errors="replace").rstrip("\n")
            if not text.startswith("\x00RPC "):
                if output_chars < _MAX_OUTPUT_CHARS:
                    output.append(text)
                    output_chars += len(text)
                continue
            calls += 1
            req_id = 0
            try:
                req = json.loads(text[len("\x00RPC "):])
                req_id = req.get("id", 0)
                if req["call"] not in host_tools:  # 协议外调用：明确拒绝
                    raise PermissionError(f"工具 {req['call']} 不在白名单")
                result = await host_tools[req["call"]](
                    *req.get("args", []), **req.get("kwargs", {}))
                resp = {"id": req_id, "result": result}
            except Exception as exc:  # 工具失败回传错误，由 agent 代码决定兜底
                resp = {"id": req_id, "error": str(exc)}
            proc.stdin.write((json.dumps(resp, ensure_ascii=False, default=str)
                              + "\n").encode())
            await proc.stdin.drain()

    async def _drain_stderr() -> None:
        """持续消费 stderr：管道缓冲写满会憋死子进程（64KB 上限的典型坑）。"""
        nonlocal stderr_chars
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(65536)
            if not chunk:
                return
            if stderr_chars < _MAX_STDERR_CHARS:
                piece = chunk.decode(errors="replace")
                piece = piece[: _MAX_STDERR_CHARS - stderr_chars]
                stderr_parts.append(piece)
                stderr_chars += len(piece)

    try:
        await asyncio.wait_for(
            asyncio.gather(_serve(), _drain_stderr(), proc.wait()),
            timeout=timeout)
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        await proc.wait()
        return f"[执行超时（{timeout:.0f}s），进程已终止]\n" + "\n".join(output)
    finally:
        Path(code_path).unlink(missing_ok=True)

    text = "\n".join(output)
    stderr = "".join(stderr_parts).strip()
    if proc.returncode != 0:
        return f"[退出码 {proc.returncode}]\n{stderr}\n{text}".strip()
    if stderr:
        text = f"{text}\n[stderr]\n{stderr}" if text else f"[stderr]\n{stderr}"
    return f"{text}\n\n（工具调用 {calls} 次）" if text else f"（无输出；工具调用 {calls} 次）"
