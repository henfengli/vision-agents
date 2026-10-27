"""bash 工具：执行 shell 命令。

隔离由 bwrap 沙箱保证（agent/tools/sandbox.py：home 白名单、配置与 docker 遮蔽、命令即 init），
资源由 systemd 用户 scope 限制（部署配置 limits）。本层只负责：环境变量白名单
（secrets.env 注入的密钥不进子进程）、超时与取消、输出截断与全文落盘、执行中的进度。

输出边读边丢：内存里只留开头和结尾各一段，命令输出再多（比如 yes、cat 大文件）平台进程的内存也不涨；
超过上限时全文同时写进会话工作目录的 outputs/（最多 200MB），给模型的是预览 + 路径。
stdout 和 stderr 合在一起，按实际先后顺序。

取消（运行被取消、任务超时）：调用方置 stop，等待循环里发现后杀掉进程——bwrap 是命名空间的 init，
它一死里面的进程全灭。不这样做的话，线程和命令会一直跑到命令自己的超时。
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Callable

from ...config import LimitsConfig
from . import outputs

MAX_OUTPUT_CHARS = 12000           # 给模型的预览：开头 1/3 + 结尾 2/3
_KEEP_BYTES = 64 * 1024            # 内存里开头、结尾各留这么多字节
_SPILL_MAX = 200 * 1024 * 1024     # 落盘的全文最多这么大
PROGRESS_S = 3.0                   # 执行中每隔几秒报一次输出尾部

# 传给子进程的环境白名单：PATH、locale 等必需项；secrets.env 注入的密钥一律不下发
_SAFE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "SHELL")


@dataclass
class BashResult:
    command: str
    exit_code: int
    output: str
    truncated: bool
    spilled: str | None = None      # 全文所在文件（截断了才有）
    total: int = 0                  # 输出总字节数


def truncate(text: str, max_chars: int = MAX_OUTPUT_CHARS) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    head = max_chars // 3
    return text[:head] + f"\n\n... [截断，共 {len(text)} 字符] ...\n\n" + text[-(max_chars - head):], True


def build_safe_env() -> dict[str, str]:
    return {k: os.environ[k] for k in _SAFE_ENV_KEYS if k in os.environ}


class _Capture:
    """读管道：内存里只留开头和结尾各 _KEEP_BYTES，记总字节数；超过时全文顺带写进 spill_path。"""

    def __init__(self, stream, spill_path: str | None = None) -> None:
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0
        self.spilled: str | None = None
        self._spill_path = spill_path
        self._f = None
        self._written = 0
        self._t = threading.Thread(target=self._read, args=(stream,), daemon=True)
        self._t.start()

    def _read(self, stream) -> None:
        read = getattr(stream, "read1", stream.read)   # read1：有多少读多少，进度才看得到慢慢出来的输出
        while chunk := read(65536):
            self.total += len(chunk)
            if len(self.head) < _KEEP_BYTES:
                room = _KEEP_BYTES - len(self.head)
                self.head += chunk[:room]
                rest = chunk[room:]
            else:
                rest = chunk
            if rest:
                self.tail += rest
                if len(self.tail) > _KEEP_BYTES:
                    del self.tail[:-_KEEP_BYTES]
            self._spill(chunk)
        if self._f is not None:
            self._f.close()
            self._f = None

    def _spill(self, chunk: bytes) -> None:
        if not self._spill_path:
            return
        if self._f is None:
            if self.total <= _KEEP_BYTES:
                return                     # 还都在内存里：结束时需要再整份写
            try:
                os.makedirs(os.path.dirname(self._spill_path), exist_ok=True)
                self._f = open(self._spill_path, "wb")
            except OSError:
                self._spill_path = None
                return
            self.spilled = self._spill_path
            first = bytes(self.head) + bytes(self.tail)       # 刚过 _KEEP_BYTES：到目前为止的全部
            self._f.write(first)
            self._written = len(first)
            return
        if self._written < _SPILL_MAX:
            self._f.write(chunk[:_SPILL_MAX - self._written])
            self._written += len(chunk)

    def reading(self) -> bool:
        return self._t.is_alive()

    def tail_text(self, n: int = 2000) -> str:
        data = bytes(self.tail[-n * 3:]) if self.tail else bytes(self.head[-n * 3:])
        return data.decode("utf-8", errors="replace")[-n:]

    def text(self) -> tuple[str, bool]:
        self._t.join(5)
        head = self.head.decode("utf-8", errors="replace")
        if self.total <= len(self.head) + len(self.tail):
            full = head + self.tail.decode("utf-8", errors="replace")
            text, cut = truncate(full)
            if cut and self.spilled is None and self._spill_path:
                self.spilled = outputs.write(self._spill_path, full)
            return text, cut
        tail = self.tail.decode("utf-8", errors="replace")
        head_n = MAX_OUTPUT_CHARS // 3
        return head[:head_n] + f"\n\n... [截断，共 {self.total} 字节] ...\n\n" + tail[-(MAX_OUTPUT_CHARS - head_n):], True


def run_command(command: str, timeout: int = 60, cwd: str | None = None, *, hidden: tuple[str, ...] = (),
                allow: tuple[str, ...] = (), limits: LimitsConfig | None = None,
                require_sandbox: bool = True, env: dict[str, str] | None = None,
                workdir: str | None = None, stop: threading.Event | None = None,
                on_progress: Callable[[str, int], None] | None = None,
                spill_path: str | None = None) -> BashResult:
    """同步执行 shell 命令并截断输出。cwd（= scratch 目录，沙箱里整个可写）给定时经沙箱执行；
    workdir：命令的当前目录（本会话的工作目录，默认 = cwd）。
    env：子进程的完整环境（不给 = 白名单 build_safe_env）；调用方在白名单之上加项目的 PATH 与环境变量。
    stop：置位就杀掉进程（调用方被取消时）。on_progress(输出尾部, 已用毫秒)：执行中每 PROGRESS_S 秒、输出有变化时调一次。
    spill_path：输出超过预览上限时全文写到这里。"""
    from .sandbox import SandboxUnavailable, scope_env, wrap_argv
    workdir = workdir or cwd
    try:
        argv = (wrap_argv(["bash", "-c", command], cwd, hidden=hidden, allow=allow, limits=limits,
                          require=require_sandbox, workdir=workdir) if cwd else ["bash", "-c", command])
    except SandboxUnavailable as e:
        return BashResult(command, 126, f"[不可用] {e}", False)
    if workdir:
        os.makedirs(workdir, exist_ok=True)
    return _execute(argv, command, timeout, workdir=workdir, env=scope_env(env or build_safe_env(), limits),
                    stop=stop, on_progress=on_progress, spill_path=spill_path)


def _execute(argv: list[str], command: str, timeout: int, *, workdir: str | None, env: dict[str, str] | None,
             stop: threading.Event | None, on_progress: Callable[[str, int], None] | None,
             spill_path: str | None) -> BashResult:
    """起进程、边读边截、等它结束（或超时 / 被取消时杀掉）。"""
    proc = subprocess.Popen(argv, cwd=workdir, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    cap = _Capture(proc.stdout, spill_path)
    t0 = time.monotonic()
    last_report, last_total = t0, 0
    status = ""
    while True:
        try:
            code = proc.wait(timeout=0.25)
            break
        except subprocess.TimeoutExpired:
            pass
        now = time.monotonic()
        if stop is not None and stop.is_set():
            status = "[已取消] 运行被取消，命令已终止"
        elif now - t0 > timeout:
            status = f"[超时] 命令超过 {timeout}s 被终止（要跑更久就把 timeout 调大，最多 600）"
        if status:
            proc.kill()                      # bwrap 是 init：它一死命名空间里的进程全灭
            code = proc.wait()
            break
        if on_progress is not None and now - last_report >= PROGRESS_S and cap.total != last_total:
            last_report, last_total = now, cap.total
            try:
                on_progress(cap.tail_text(), int((now - t0) * 1000))
            except Exception:  # noqa: BLE001 —— 进度只是给人看的
                pass
    output, truncated = cap.text()
    # 读线程还卡在 read 上（没有沙箱时后台子进程还拿着管道）就不 close：close 会等它的缓冲锁，跟着卡住
    if proc.stdout is not None and not cap.reading():
        proc.stdout.close()
    if status:
        return BashResult(command, 130 if "取消" in status else 124, f"{status}\n{output}".rstrip(), True,
                          cap.spilled, cap.total)
    return BashResult(command, code, output, truncated, cap.spilled, cap.total)


def format_result(r: BashResult) -> str:
    """模型友好的输出格式。截断了的末尾说明全文在哪。"""
    note = ""
    if r.truncated and r.spilled and os.path.exists(r.spilled):
        size = os.path.getsize(r.spilled)
        note = "\n" + (outputs.note(r.spilled, size, "字节") if size >= r.total else
                       f"[输出共 {r.total} 字节，前 {size} 字节存在 {r.spilled}（落盘最多 {_SPILL_MAX >> 20}MB），"
                       "结尾见上面的预览：用 read(path, offset=行号) 翻看，或 grep 搜]")
    elif r.truncated:
        note = "\n" + outputs.note(None, len(r.output))
    return f"$ {r.command}\n(exit {r.exit_code})\n{r.output}{note}"
