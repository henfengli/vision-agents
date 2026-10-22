"""项目内核：每个 会话×服务×环境 一个常驻 Python 进程，agent 用 py 工具往里发代码。

和起进程用同一份"按环境就位"的规格（ProcessController.env_spec）：
- 解释器是该环境的（ServiceDef.python，可按环境覆盖），工作目录是该环境的部署目录
- 该环境的配置文件只读 bind 到项目读的固定路径，其他环境的配置与平台密钥遮蔽——
  项目代码按原样读配置、连库，import 项目模块、调项目自己的函数（口径函数、ORM、dagster 资产…）
- 变量跨调用保留：同一会话里上一轮加载的 DataFrame 下一轮还在；restart 清空
- 驱动脚本只用标准库，业务 venv 里不用额外装东西
- 文件系统只读，scratch（和 bash 共用的工作区）可写，/tmp 是独立 tmpfs；网络照常（要连库）
- 空闲超时回收；同时存在的内核有上限，超了先回收最久没用的

协议（驱动在子进程里把 fd 0/1 挪走，业务代码和子进程的输出不会混进协议）：
- 宿 → 内核（原 stdin）：一行 JSON {"id", "code", "timeout"}
- 内核 → 宿（原 stdout）：一行 JSON {"id", "out", "value", "error", "ms"}
- 直接写 fd 1/2 的输出（C 扩展、子进程）都进 stderr 管道，宿主收集后附在这次结果后面
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
from dataclasses import dataclass, field

from ..agent.tools.bash import build_safe_env
from ..agent.tools.sandbox import has_bwrap
from .svcrun import mask_args

log = logging.getLogger(__name__)

MAX_RESULT_CHARS = 20_000

DRIVER = r'''
import ast, io, json, os, signal, sys, time, traceback

_pin = os.fdopen(os.dup(0), "rb")
_pout = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.dup2(2, 1)
sys.stdin = io.StringIO("")
_LIMIT = 50000
G = {"__name__": "__main__", "__builtins__": __builtins__}


class CellTimeout(BaseException):
    pass


def _alarm(*_):
    raise CellTimeout()


def _repr(v):
    try:
        text = repr(v)
    except Exception as e:  # noqa
        text = "<repr 失败：%s>" % e
    return text if len(text) <= _LIMIT else text[:_LIMIT] + "…[截断]"


def _run(code):
    tree = ast.parse(code, "<py>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<py>", "exec"), G)
    if last is not None:
        v = eval(compile(last, "<py>", "eval"), G)
        if v is not None:
            G["_"] = v
            return _repr(v)
    return None


def _input(*_a, **_k):
    raise RuntimeError("内核里不能交互输入")


def _tb():
    """只留用户代码的栈帧：驱动自己的帧（文件名 <string>）对 agent 没用。"""
    et, ev, tb = sys.exc_info()
    while tb is not None and tb.tb_frame.f_code.co_filename == "<string>":
        tb = tb.tb_next
    return "".join(traceback.format_exception(et, ev, tb, limit=8))


import builtins
builtins.input = _input
for _p in os.environ.get("AGENT_METHOD_PATHS", "").split(os.pathsep):
    if _p and _p not in sys.path:
        sys.path.append(_p)
if hasattr(signal, "SIGALRM"):
    signal.signal(signal.SIGALRM, _alarm)

while True:
    line = _pin.readline()
    if not line:
        break
    req = json.loads(line)
    buf = io.StringIO()
    old = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    value = error = None
    t0 = time.monotonic()
    if hasattr(signal, "setitimer"):
        signal.setitimer(signal.ITIMER_REAL, float(req.get("timeout") or 120))
    try:
        value = _run(req["code"])
    except CellTimeout:
        error = "执行超时（%ss），已中断；变量保留" % req.get("timeout")
    except KeyboardInterrupt:
        error = "被中断"
    except BaseException:  # noqa —— SystemExit 也不能把内核带走
        error = _tb()
    finally:
        if hasattr(signal, "setitimer"):
            signal.setitimer(signal.ITIMER_REAL, 0)
        sys.stdout, sys.stderr = old
    out = buf.getvalue()
    if len(out) > _LIMIT:
        out = out[:_LIMIT // 2] + "\n…[输出截断，共 %d 字符]…\n" % len(out) + out[-_LIMIT // 2:]
    _pout.write(json.dumps({"id": req["id"], "out": out, "value": value, "error": error,
                            "ms": int((time.monotonic() - t0) * 1000)}, ensure_ascii=False) + "\n")
    _pout.flush()
'''


@dataclass
class _Kernel:
    key: str
    proc: asyncio.subprocess.Process
    service: str
    env: str
    python: str
    started_at: float
    last_used: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    stray: list[str] = field(default_factory=list)
    seq: int = 0
    drain: asyncio.Task | None = None

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None


class KernelManager:
    def __init__(self, scratch_dir: str, idle_minutes: float = 30, max_kernels: int = 8):
        self._scratch = scratch_dir
        self._idle_s = idle_minutes * 60
        self._max = max_kernels
        self._kernels: dict[str, _Kernel] = {}
        self._reaper: asyncio.Task | None = None

    # —— 对外 ——

    async def execute(self, key: str, spec: dict, code: str, *, timeout: float = 120,
                      hidden: tuple[str, ...] = (), restart: bool = False) -> str:
        """spec：ProcessController.runtime_spec() 的结果（service/env/python/workdir/binds/masks/env_vars）。"""
        if restart:
            await self.shutdown(key)
        k = self._kernels.get(key)
        if k is None or not k.alive:
            k = await self._start(key, spec, hidden)
        async with k.lock:
            k.last_used = time.monotonic()
            k.seq += 1
            k.stray.clear()
            assert k.proc.stdin is not None and k.proc.stdout is not None
            k.proc.stdin.write((json.dumps({"id": k.seq, "code": code, "timeout": timeout}) + "\n").encode())
            await k.proc.stdin.drain()
            try:
                line = await asyncio.wait_for(k.proc.stdout.readline(), timeout + 15)
            except (TimeoutError, asyncio.TimeoutError):
                await self.shutdown(key)
                return f"[内核无响应] 超过 {int(timeout) + 15}s 没有返回，已结束内核（变量清空，下次调用自动重启）"
            await asyncio.sleep(0.05)                 # 让 stderr 里紧跟着的输出落进来
            if not line:
                code_ = await k.proc.wait()
                self._kernels.pop(key, None)
                tail = "".join(k.stray)[-4000:]
                return f"[内核已退出] 退出码 {code_}（变量清空，下次调用自动重启）\n{tail}".strip()
            k.last_used = time.monotonic()
            return _format(json.loads(line), "".join(k.stray))

    def alive(self, key: str) -> bool:
        k = self._kernels.get(key)
        return k is not None and k.alive

    async def shutdown(self, key: str) -> None:
        k = self._kernels.pop(key, None)
        if k is not None:
            await _kill(k)

    async def close(self) -> None:
        for key in list(self._kernels):
            await self.shutdown(key)
        if self._reaper is not None:
            self._reaper.cancel()

    def listing(self) -> list[dict]:
        now = time.monotonic()
        return [{"key": k.key, "service": k.service, "env": k.env, "python": k.python, "alive": k.alive,
                 "age_s": int(now - k.started_at), "idle_s": int(now - k.last_used)} for k in self._kernels.values()]

    # —— 内部 ——

    async def _start(self, key: str, spec: dict, hidden: tuple[str, ...]) -> _Kernel:
        python = spec["python"]
        if not (shutil.which(python) or os.path.isfile(python)):
            raise KernelError(f"找不到 {spec['service']} 在 {spec['env']} 的解释器 {python}（服务定义 → python）")
        await self._make_room()
        os.makedirs(self._scratch, exist_ok=True)
        env = {**build_safe_env(), **spec.get("env_vars", {}), "SVC_ENV": spec["env"], "SVC_NAME": spec["service"],
               "SCRATCH": self._scratch, "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
               "AGENT_METHOD_PATHS": os.pathsep.join(spec.get("method_paths") or [])}
        argv = [python, "-u", "-c", DRIVER]
        workdir = spec.get("workdir") or None
        if workdir and not os.path.isdir(workdir):
            raise KernelError(f"{spec['service']} 在 {spec['env']} 的部署目录 {workdir} 不存在（先同步代码）")
        if has_bwrap():
            argv = _sandbox(argv, spec, hidden, self._scratch, workdir)
        else:
            log.warning("bubblewrap 不可用：项目内核直接在宿主上跑，配置文件不会按环境就位")
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=workdir, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024)
        now = time.monotonic()
        k = _Kernel(key, proc, spec["service"], spec["env"], python, now, now)
        k.drain = asyncio.ensure_future(_drain(k))
        self._kernels[key] = k
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.ensure_future(self._reap_forever())
        log.info("项目内核已启动 %s（%s，pid %s）", key, python, proc.pid)
        return k

    async def _make_room(self) -> None:
        while len(self._kernels) >= self._max:
            oldest = min(self._kernels.values(), key=lambda k: k.last_used)
            log.info("内核数到上限 %d，回收最久没用的 %s", self._max, oldest.key)
            await self.shutdown(oldest.key)

    async def _reap_forever(self) -> None:
        while self._kernels:
            await asyncio.sleep(60)
            now = time.monotonic()
            for k in list(self._kernels.values()):
                if not k.alive or (now - k.last_used > self._idle_s and not k.lock.locked()):
                    log.info("回收空闲内核 %s", k.key)
                    await self.shutdown(k.key)


class KernelError(RuntimeError):
    pass


def kernel_key(session_id: str, service: str, env: str) -> str:
    return f"{session_id}@{service}:{env}"


def _sandbox(argv: list[str], spec: dict, hidden: tuple[str, ...], scratch: str, workdir: str | None) -> list[str]:
    """全盘只读 + 遮蔽（别的服务、别的环境的配置，平台密钥）+ 本环境配置 bind 到固定路径 + scratch 可写。"""
    selected = {p for pair in spec["binds"] for p in pair}
    masks = sorted((set(hidden) | set(spec["masks"])) - selected)
    args = ["bwrap", "--ro-bind", "/", "/", *mask_args(masks)]
    for src, dst in spec["binds"]:
        args += ["--ro-bind", src, dst]
    args += ["--bind", scratch, scratch, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
             "--unshare-pid", "--die-with-parent", "--new-session"]
    if workdir:
        args += ["--chdir", workdir]
    return args + ["--", *argv]


async def _drain(k: _Kernel) -> None:
    assert k.proc.stderr is not None
    total = 0
    while True:
        chunk = await k.proc.stderr.read(65536)
        if not chunk:
            return
        if total < 200_000:
            text = chunk.decode(errors="replace")
            k.stray.append(text)
            total += len(text)
        if len(k.stray) > 200:
            k.stray[:] = ["".join(k.stray)[-100_000:]]


async def _kill(k: _Kernel) -> None:
    if k.alive:
        k.proc.kill()
        try:
            await asyncio.wait_for(k.proc.wait(), 5)
        except (TimeoutError, asyncio.TimeoutError):
            pass
    if k.drain is not None:
        k.drain.cancel()


_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _format(resp: dict, stray: str) -> str:
    parts = []
    if resp.get("out"):
        parts.append(resp["out"].rstrip("\n"))
    if stray.strip():
        parts.append("[直接输出 / stderr]\n" + _ANSI.sub("", stray).rstrip("\n")[-6000:])
    if resp.get("value") is not None:
        parts.append(f"[值] {resp['value']}")
    if resp.get("error"):
        parts.append(f"[错误]\n{resp['error'].rstrip()}")
    text = "\n".join(parts) or "（无输出）"
    if len(text) > MAX_RESULT_CHARS:
        half = MAX_RESULT_CHARS // 2
        text = text[:half] + f"\n…[截断，共 {len(text)} 字符]…\n" + text[-half:]
    return f"{text}\n（{resp.get('ms', 0)} ms）"
