"""项目内核：每个 会话×服务×环境 一个常驻 Python 进程，agent 用 py 工具往里发代码。

规格来自 services/envspec.py（runtime_spec）：
- 解释器是该环境线上用的那个（ServiceDef.python，可按环境覆盖），工作目录是线上的代码目录
- 给 agent 的只读配置 bind 到项目读配置的路径，线上真实配置被盖住；别的环境的配置遮蔽——
  项目代码按原样读配置、连库（只读账号），import 项目模块、调项目自己的函数（口径函数、ORM、dagster 资产…）
- 沙箱里 home 是空的，只挂回代码目录、conda 环境、方法目录；看不到 docker、systemd 用户总线、同用户的其他进程
- 每个内核一个 systemd 用户 scope（部署配置 limits）：内存、进程数有上限，超了只杀这个内核
- 变量跨调用保留：同一会话里上一轮加载的 DataFrame 下一轮还在；restart 清空
- 驱动脚本只用标准库，业务环境里不用额外装东西
- 文件系统只读，scratch（和 bash 共用的工作区）可写，/tmp 是独立 tmpfs；网络照常（要连库）
- 空闲超时回收；同时存在的内核有上限，超了先回收最久没用的
- 规格的 digest（解释器、配置版本、环境变量）变了就重启：配置是在控制台上改的（可能由另一台主机上的 agent 服务回答）

协议（驱动在子进程里把 fd 0/1 挪走，业务代码和子进程的输出不会混进协议）：
- 宿 → 内核（原 stdin）：一行 JSON {"id", "code", "timeout", "tools"}
- 内核 → 宿（原 stdout）：一行 JSON {"id", "out", "value", "error", "ms"}
- 直接写 fd 1/2 的输出（C 扩展、子进程）都进 stderr 管道，宿主收集后附在这次结果后面

平台工具（RPC）：请求里 tools 列出的工具名在内核里是同名函数（db_query(...)、service_info(...)、MCP 工具…），
调用时内核写一行 {"rpc", "call", "args", "kwargs"}，宿主在本次运行的上下文里执行该工具，回一行 {"rpc", "result"|"error"}。
要循环 / 批量调工具时一段 py 搞定，中间结果不进模型上下文。
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
from typing import Any, Awaitable, Callable

from ..agent.tools.bash import build_safe_env
from ..agent.tools import outputs
from ..agent.tools.sandbox import bwrap_argv, has_bwrap, limit_argv, scope_env, work_dir
from ..config import LimitsConfig

log = logging.getLogger(__name__)

MAX_RESULT_CHARS = 20_000
ROOM_WAIT_S = 120              # 内核数到上限且都在执行时，新会话的 py 调用最多等这么久

DRIVER = r'''
import ast, io, json, os, signal, sys, threading, time, traceback

_pin = os.fdopen(os.dup(0), "rb")
_pout = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
os.dup2(2, 1)
sys.stdin = io.StringIO("")
_LIMIT = 50000
_SPILL = 20000                       # 输出超过这么多字：全文存进 $SCRATCH/outputs/，返回里给路径
_PROGRESS_S = 3                      # 执行中每隔几秒把输出尾部发给宿主（时间线上看进度）
G = {"__name__": "__main__", "__builtins__": __builtins__}
_wlock = threading.Lock()            # 结果、RPC 请求、进度从不同线程写同一条管道


def _send(obj):
    line = json.dumps(obj, ensure_ascii=False, default=str) + "\n"
    with _wlock:
        _pout.write(line)
        _pout.flush()


def _spill(rid, text):
    try:
        d = os.path.join(os.environ.get("SCRATCH") or "/tmp", "outputs")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "py-%s-%d.txt" % (time.strftime("%m%d-%H%M%S"), rid))
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path
    except OSError:
        return None


class _Buf(io.StringIO):
    """收集输出，顺带记总长和最后 2000 字：进度线程只读这两个，不用每次把整份输出复制一遍。"""

    def __init__(self):
        super().__init__()
        self.n = 0
        self.tail = ""

    def write(self, s):
        self.n += len(s)
        self.tail = (self.tail + s)[-2000:]
        return super().write(s)


def _progress(rid, buf, stop, t0):
    """执行中的进度：输出有变化就把尾部发出去。宿主只认当前这次调用的 id。"""
    last = -1
    while not stop.wait(_PROGRESS_S):
        if buf.n != last:
            last = buf.n
            _send({"progress": rid, "out": buf.tail, "ms": int((time.monotonic() - t0) * 1000)})


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


_rpc_seq = [0]


def _rpc(name, args, kwargs):
    """平台工具调用：写一行请求给宿主，等同号的回复（超时中断后迟到的旧回复直接丢掉）。"""
    _rpc_seq[0] += 1
    rid = _rpc_seq[0]
    _send({"rpc": rid, "call": name, "args": args, "kwargs": kwargs})
    while True:
        line = _pin.readline()
        if not line:
            raise RuntimeError("宿主连接中断")
        resp = json.loads(line)
        if resp.get("rpc") != rid:
            continue
        if "error" in resp:
            raise RuntimeError("%s：%s" % (name, resp["error"]))
        return resp.get("result")


def _stub(name):
    def tool(*args, **kwargs):
        return _rpc(name, list(args), kwargs)
    tool.__name__ = name
    tool.__doc__ = "平台工具 %s：在宿主上按本次运行的服务×环境执行，返回文本" % name
    tool._platform_tool = True
    return tool


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
    if "code" not in req:
        continue                      # 迟到的 RPC 回复（那次调用已超时中断）
    for _n in req.get("tools") or ():
        if _n not in G or getattr(G[_n], "_platform_tool", False):
            G[_n] = _stub(_n)         # 用户自己定义了同名变量就不覆盖
    buf = _Buf()
    old = sys.stdout, sys.stderr
    sys.stdout = sys.stderr = buf
    value = error = None
    t0 = time.monotonic()
    stop = threading.Event()
    threading.Thread(target=_progress, args=(req["id"], buf, stop, t0), daemon=True).start()
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
        stop.set()
        sys.stdout, sys.stderr = old
    out = buf.getvalue()
    spilled = None
    if len(out) + len(value or "") + len(error or "") > _SPILL:
        spilled = _spill(req["id"], out + ("\n[值] %s\n" % value if value is not None else "")
                         + ("\n[错误]\n%s\n" % error if error else ""))
    if len(out) > _LIMIT:
        out = out[:_LIMIT // 2] + "\n…[输出截断，共 %d 字符]…\n" % len(out) + out[-_LIMIT // 2:]
    if error and len(error) > _LIMIT:
        error = error[:_LIMIT // 2] + "\n…[截断]…\n" + error[-_LIMIT // 2:]
    _send({"id": req["id"], "out": out, "value": value, "error": error, "spilled": spilled,
           "ms": int((time.monotonic() - t0) * 1000)})
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
    digest: str = ""                       # 起它时的规格摘要（解释器、配置版本、环境变量）

    @property
    def alive(self) -> bool:
        return self.proc.returncode is None


class KernelManager:
    def __init__(self, scratch_dir: str, idle_minutes: float = 30, max_kernels: int = 3, *,
                 limits: LimitsConfig | None = None, require_sandbox: bool = True):
        self._scratch = scratch_dir
        self._idle_s = idle_minutes * 60
        self._max = max_kernels
        self._limits = limits
        self._require = require_sandbox
        self._kernels: dict[str, _Kernel] = {}
        self._reaper: asyncio.Task | None = None
        # 查找 / 启动内核串行：同一条消息里的几个 py 调用是并发的，不能各起一个（多出来的那个没人管、占着内存）
        self._starting = asyncio.Lock()

    # —— 对外 ——

    async def execute(self, key: str, spec: dict, code: str, *, timeout: float = 120,
                      hidden: tuple[str, ...] = (), restart: bool = False,
                      tools: dict[str, Callable[..., Awaitable[Any]]] | None = None,
                      progress: Callable[[str, int], Awaitable[None]] | None = None) -> str:
        """spec：envspec.runtime_spec() 的结果（service/env/python/workdir/binds/hidden/allow/env_vars/digest）。
        hidden：本运行 bash 沙箱的遮蔽（所有服务的配置），和 spec 的合并。
        tools：内核里可调用的平台工具（名字 → async 实现），在调用方的上下文（RunScope）里执行。
        progress：执行中每隔几秒拿到输出尾部和已用毫秒（时间线上的"执行中"）。

        调用被取消（运行被取消、任务超时、worker 停机）时结束这个内核：里面那段代码还在跑，留着它，
        下一次调用会先读到它迟到的结果。结果按请求 id 对号，对不上的旧结果丢掉。"""
        notice = ""
        waited = 0.0
        while True:
            async with self._starting:
                if restart:
                    await self.shutdown(key)
                    restart = False
                k = self._kernels.get(key)
                if k is not None and k.alive and k.digest != spec.get("digest", "") and not k.lock.locked():
                    await self.shutdown(key)                # 配置 / 解释器换了：import 过的还是旧的，重启
                    k = None
                    notice = "[内核已重启：本环境的配置、解释器或可见范围变了，之前的变量已清空]\n"
                if k is None or not k.alive:
                    k = await self._start(key, spec, hidden) if await self._make_room() else None
            if k is not None:
                break
            # 内核数到上限且都在执行代码：不打断别人，在锁外等一个空位（别的会话的 py 调用照常进出）
            if waited >= ROOM_WAIT_S:
                raise KernelError(f"项目内核已满（{self._max} 个都在执行代码），等了 {int(waited)}s 还没有空位，稍后再试")
            await asyncio.sleep(2)
            waited += 2
        if waited:
            notice += f"[等了 {int(waited)}s 内核空位]\n"
        tools = tools or {}
        async with k.lock:
            k.last_used = time.monotonic()
            k.seq += 1
            k.stray.clear()
            assert k.proc.stdin is not None and k.proc.stdout is not None
            deadline = time.monotonic() + timeout + 15
            calls = 0
            line = b""
            try:
                k.proc.stdin.write((json.dumps({"id": k.seq, "code": code, "timeout": timeout,
                                                "tools": sorted(tools)}) + "\n").encode())
                await k.proc.stdin.drain()
                while True:
                    try:
                        line = await asyncio.wait_for(k.proc.stdout.readline(), max(1.0, deadline - time.monotonic()))
                    except (TimeoutError, asyncio.TimeoutError):
                        await self._drop(key, k)
                        return f"[内核无响应] 超过 {int(timeout) + 15}s 没有返回，已结束内核（变量清空，下次调用自动重启）"
                    if not line:
                        break
                    msg = json.loads(line)
                    if "progress" in msg:
                        if progress is not None and msg["progress"] == k.seq:
                            try:
                                await progress(msg.get("out") or "", int(msg.get("ms") or 0))
                            except Exception:  # noqa: BLE001 —— 进度只是给人看的，写不进去不影响执行
                                log.debug("内核进度回调失败", exc_info=True)
                        continue
                    if "rpc" in msg:
                        calls += 1
                        reply = await _serve_rpc(msg, tools)
                        k.proc.stdin.write((json.dumps(reply, ensure_ascii=False, default=str) + "\n").encode())
                        await k.proc.stdin.drain()
                        continue
                    if msg.get("id") != k.seq:
                        continue                            # 不是这次的结果（不该发生：被取消的调用会结束内核）
                    break
            except asyncio.CancelledError:
                # 运行被取消 / 超时：内核里的代码还在跑，结束它，别让下一次调用读到迟到的结果
                await asyncio.shield(self._drop(key, k))
                raise
            except (BrokenPipeError, ConnectionResetError, ValueError) as e:
                # 内核起不来（bwrap / systemd-run 报错）或协议乱了（超长的一行、不是 JSON）：结束它，把 stderr 交给 agent
                await asyncio.sleep(0.2)
                await self._drop(key, k)
                tail = "".join(k.stray)[-4000:]
                return f"[内核出错] {type(e).__name__}: {str(e)[:300]}（变量清空，下次调用自动重启）\n{tail}".strip()
            await asyncio.sleep(0.05)                 # 让 stderr 里紧跟着的输出落进来
            if not line:
                code_ = await k.proc.wait()
                if self._kernels.get(key) is k:
                    self._kernels.pop(key, None)
                tail = "".join(k.stray)[-4000:]
                return f"[内核已退出] 退出码 {code_}（变量清空，下次调用自动重启）\n{tail}".strip()
            k.last_used = time.monotonic()
            return notice + _format(msg, "".join(k.stray), calls, spill_dir=work_dir(self._scratch, key))

    def alive(self, key: str, digest: str | None = None) -> bool:
        k = self._kernels.get(key)
        return k is not None and k.alive and (digest is None or k.digest == digest)

    async def shutdown(self, key: str) -> None:
        k = self._kernels.pop(key, None)
        if k is not None:
            await _kill(k)

    async def _drop(self, key: str, k: _Kernel) -> None:
        """结束这一个内核（池子里已经换成别的同键内核时只杀它自己，不动新的）。"""
        if self._kernels.get(key) is k:
            self._kernels.pop(key, None)
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
        work = work_dir(self._scratch, key)          # 本会话的工作目录，和 bash 共用；scratch 整个可写
        os.makedirs(work, exist_ok=True)
        env = {**build_safe_env(), **spec.get("env_vars", {}), "SVC_ENV": spec["env"], "SVC_NAME": spec["service"],
               "SCRATCH": work, "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
               "AGENT_METHOD_PATHS": os.pathsep.join(spec.get("method_paths") or [])}
        argv = [python, "-u", "-c", DRIVER]
        workdir = spec.get("workdir") or None
        if workdir and not os.path.isdir(workdir):
            raise KernelError(f"{spec['service']} 在 {spec['env']} 的代码目录 {workdir} 在本机不存在（服务定义 → root）")
        if has_bwrap():
            binds = [tuple(b) for b in spec.get("binds") or []]
            masks = (set(hidden) | set(spec.get("hidden") or [])) - {dst for _, dst in binds}
            argv = bwrap_argv(argv, scratch=self._scratch, hidden=sorted(masks), allow=spec.get("allow") or (),
                              binds=binds, sinks=spec.get("sinks") or (), workdir=workdir)
            lim = self._limits
            argv = limit_argv(argv, lim, memory=lim.kernel_memory if lim else "")
            env = scope_env(env, lim)
        elif self._require:
            raise KernelError("没有 bwrap（bubblewrap），按部署配置 require_sandbox 不起项目内核")
        else:
            log.warning("bubblewrap 不可用：项目内核直接在宿主上跑，给 agent 的配置不会就位（只适合开发机）")
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=workdir, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024)
        now = time.monotonic()
        k = _Kernel(key, proc, spec["service"], spec["env"], python, now, now, digest=spec.get("digest", ""))
        k.drain = asyncio.ensure_future(_drain(k))
        self._kernels[key] = k
        if self._reaper is None or self._reaper.done():
            self._reaper = asyncio.ensure_future(self._reap_forever())
        log.info("项目内核已启动 %s（%s，pid %s）", key, python, proc.pid)
        return k

    async def _make_room(self) -> bool:
        """到上限时回收最久没用的空闲内核。都在执行代码时不打断别人，返回 False（调用方等一会儿再来）。"""
        while len(self._kernels) >= self._max:
            idle = [k for k in self._kernels.values() if not k.lock.locked()]
            if not idle:
                return False
            oldest = min(idle, key=lambda k: k.last_used)
            log.info("内核数到上限 %d，回收最久没用的 %s", self._max, oldest.key)
            await self.shutdown(oldest.key)
        return True

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


async def _drain(k: _Kernel) -> None:
    assert k.proc.stderr is not None
    while True:
        chunk = await k.proc.stderr.read(65536)
        if not chunk:
            return
        k.stray.append(chunk.decode(errors="replace"))   # 每次调用前清空；这里只限住单次调用里的量
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


async def _serve_rpc(msg: dict, tools: dict[str, Callable[..., Awaitable[Any]]]) -> dict:
    """内核里调平台工具：在宿主上执行，结果（文本）或错误回给内核。"""
    rid, name = msg.get("rpc"), msg.get("call")
    fn = tools.get(name or "")
    if fn is None:
        return {"rpc": rid, "error": f"工具 {name} 不在本角色的工具里（可用：{'、'.join(sorted(tools)) or '无'}）"}
    try:
        return {"rpc": rid, "result": await fn(*(msg.get("args") or []), **(msg.get("kwargs") or {}))}
    except Exception as e:  # noqa: BLE001 —— 工具失败回传错误，由内核里的代码决定怎么兜底
        return {"rpc": rid, "error": f"{type(e).__name__}: {str(e)[:1000]}"}


def _format(resp: dict, stray: str, calls: int = 0, spill_dir: str | None = None) -> str:
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
        # 全文：内核里已经存了的（输出很长时）用它的，否则这里存；模型拿到路径，用 read / grep 看要的部分
        path = resp.get("spilled")
        if path and stray.strip():           # 内核存的文件里没有直接写到 fd 的输出：补在后面
            try:
                with open(path, "a", encoding="utf-8") as f:
                    f.write("\n[直接输出 / stderr]\n" + _ANSI.sub("", stray))
            except OSError:
                pass
        path = path or (outputs.spill(spill_dir, "py", text) if spill_dir else None)
        text = outputs.clip(text, MAX_RESULT_CHARS, path)
    return f"{text}\n（{resp.get('ms', 0)} ms" + (f"，平台工具调用 {calls} 次）" if calls else "）")
