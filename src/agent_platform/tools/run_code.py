"""run_code：CodeAct 编排层——agent 写一段 Python 一次编排多个工具。

协议：子进程（bwrap 沙箱内）执行 agent 代码；代码里调用桩函数时，
子进程通过 stdout 发 JSON 行（\\x00RPC 前缀）请求 host 执行真实工具，
host 审查/鉴权/审计后执行并把结果写回子进程 stdin。
中间数据留在沙箱，只有 print 输出回模型上下文——多轮往返压成一次。
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Awaitable, Callable

from .bash import truncate
from .sandbox import wrap_argv

RPC_PREFIX = "\x00RPC "

# 子进程驱动脚本：注入桩函数 + RPC 客户端；agent 代码由 __main__ 段读文件执行
_DRIVER = r'''
import asyncio, json, sys

RPC_PREFIX = "\x00RPC "
_req_id = 0

def _call(name, *args, **kwargs):
    """桩函数统一入口：向 host 发 RPC，同步等待结果。"""
    global _req_id
    _req_id += 1
    sys.stdout.write(RPC_PREFIX + json.dumps(
        {"id": _req_id, "call": name,
         "args": list(args), "kwargs": kwargs}) + "\n")
    sys.stdout.flush()
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("host 连接中断")
        resp = json.loads(line)
        if resp.get("id") == _req_id:
            if "error" in resp:
                raise RuntimeError(f"{name}: {resp['error']}")
            return resp.get("result")

def _make_stub(name):
    def stub(*args, **kwargs):
        return _call(name, *args, **kwargs)
    stub.__name__ = name
    stub.__doc__ = "host 工具桩：%s" % name
    return stub

for _name in json.loads(sys.argv[2]):
    globals()[_name] = _make_stub(_name)

with open(sys.argv[1], encoding="utf-8") as _f:
    _code = _f.read()
exec(compile(_code, "<agent>", "exec"), globals())
'''


async def execute_code(
    code: str,
    tools: dict[str, Callable[..., Awaitable[Any]]],
    scratch_dir: str,
    timeout: int = 120,
    allow_net: bool = False,
) -> str:
    """沙箱内执行 agent 代码；tools 为可调用的 host 工具（async）。

    返回模型可见文本：print 输出 + 工具调用摘要（截断）。异常以可读文本返回。
    """
    import tempfile
    with tempfile.NamedTemporaryFile(
            "w", suffix=".py", dir=scratch_dir, delete=False,
            encoding="utf-8") as f:
        f.write(code)
        code_path = f.name

    argv = wrap_argv(
        [sys.executable, "-c", _DRIVER, code_path, json.dumps(list(tools))],
        scratch_dir, allow_net=allow_net)
    proc = await asyncio.create_subprocess_exec(
        *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, cwd=scratch_dir)

    output_lines: list[str] = []
    calls: list[str] = []

    async def _serve() -> None:
        assert proc.stdout and proc.stdin
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\n")
            if text.startswith(RPC_PREFIX):
                req = json.loads(text[len(RPC_PREFIX):])
                resp = await _dispatch(req, tools, calls)
                proc.stdin.write((json.dumps(resp, ensure_ascii=False) + "\n")
                                 .encode())
                await proc.stdin.drain()
            else:
                output_lines.append(text)

    try:
        await asyncio.wait_for(_serve(), timeout)
        await proc.wait()
    except (asyncio.TimeoutError, TimeoutError):
        proc.kill()
        await proc.wait()
        return f"[超时] 代码超过 {timeout}s 被终止\n" + "\n".join(output_lines)
    finally:
        import os
        try:
            os.unlink(code_path)
        except OSError:
            pass

    stderr = (await proc.stderr.read()).decode("utf-8", "replace") \
        if proc.stderr else ""
    out = "\n".join(output_lines)
    if proc.returncode:
        out += f"\n[exit {proc.returncode}]\n{stderr[-2000:]}"
    if calls:
        out += f"\n\n[工具调用 {len(calls)} 次：{'、'.join(calls)}]"
    text, truncated = truncate(out)
    return text + ("\n[输出已截断]" if truncated else "")


async def _dispatch(req: dict, tools: dict, calls: list[str]) -> dict:
    name = req.get("call", "")
    calls.append(name)
    fn = tools.get(name)
    if fn is None:
        return {"id": req.get("id"), "error": f"未知工具 {name}"}
    try:
        result = fn(*(req.get("args") or []), **(req.get("kwargs") or {}))
        if asyncio.iscoroutine(result):
            result = await result
        return {"id": req.get("id"), "result": result}
    except Exception as e:  # noqa: BLE001 —— 工具异常回给 agent 代码处理
        return {"id": req.get("id"), "error": str(e)[:1000]}
