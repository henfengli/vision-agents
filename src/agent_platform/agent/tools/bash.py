"""bash 工具：唯一的通用工具。

隔离由 bwrap 沙箱保证（agent/tools/sandbox.py：home 白名单、配置与 docker 遮蔽、命令即 init），
资源由 systemd 用户 scope 限制（部署配置 limits）。本层只负责：环境变量白名单
（secrets.env 注入的密钥不进子进程）、超时、输出截断。

输出边读边丢：只留开头和结尾各一段，命令输出再多（比如 yes、cat 大文件）平台进程的内存也不涨。
stdout 和 stderr 合在一起，按实际先后顺序。
"""

from __future__ import annotations

import os
import subprocess
import threading
from dataclasses import dataclass

from ...config import LimitsConfig

MAX_OUTPUT_CHARS = 8000
_KEEP_BYTES = 32 * 1024            # 开头、结尾各留这么多字节（够截出 MAX_OUTPUT_CHARS 字）

# 传给子进程的环境白名单：PATH、locale 等必需项；secrets.env 注入的密钥一律不下发
_SAFE_ENV_KEYS = ("PATH", "HOME", "LANG", "LC_ALL", "TZ", "USER", "SHELL")


@dataclass
class BashResult:
    command: str
    exit_code: int
    output: str
    truncated: bool


def truncate(text: str, max_chars: int = MAX_OUTPUT_CHARS) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    head = max_chars // 2
    return text[:head] + f"\n\n... [截断，共 {len(text)} 字符] ...\n\n" + text[-head:], True


def build_safe_env() -> dict[str, str]:
    return {k: os.environ[k] for k in _SAFE_ENV_KEYS if k in os.environ}


class _Capture:
    """读管道：只留开头 _KEEP_BYTES 和最后 _KEEP_BYTES，记总字节数。"""

    def __init__(self, stream) -> None:
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0
        self._t = threading.Thread(target=self._read, args=(stream,), daemon=True)
        self._t.start()

    def _read(self, stream) -> None:
        while chunk := stream.read(65536):
            self.total += len(chunk)
            if len(self.head) < _KEEP_BYTES:
                room = _KEEP_BYTES - len(self.head)
                self.head += chunk[:room]
                chunk = chunk[room:]
            if chunk:
                self.tail += chunk
                if len(self.tail) > _KEEP_BYTES:
                    del self.tail[:-_KEEP_BYTES]

    def text(self) -> tuple[str, bool]:
        self._t.join(5)
        head = self.head.decode("utf-8", errors="replace")
        if self.total <= len(self.head) + len(self.tail):
            return truncate(head + self.tail.decode("utf-8", errors="replace"))
        tail = self.tail.decode("utf-8", errors="replace")
        half = MAX_OUTPUT_CHARS // 2
        return head[:half] + f"\n\n... [截断，共 {self.total} 字节] ...\n\n" + tail[-half:], True


def run_command(command: str, timeout: int = 60, cwd: str | None = None, *, hidden: tuple[str, ...] = (),
                allow: tuple[str, ...] = (), limits: LimitsConfig | None = None,
                require_sandbox: bool = True, env: dict[str, str] | None = None,
                workdir: str | None = None) -> BashResult:
    """同步执行 shell 命令并截断输出。cwd（= scratch 目录，沙箱里整个可写）给定时经沙箱执行；
    workdir：命令的当前目录（本会话的工作目录，默认 = cwd）。
    env：子进程的完整环境（不给 = 白名单 build_safe_env）；调用方在白名单之上加项目的 PATH 与环境变量。"""
    from .sandbox import SandboxUnavailable, scope_env, wrap_argv
    workdir = workdir or cwd
    try:
        argv = (wrap_argv(["bash", "-c", command], cwd, hidden=hidden, allow=allow, limits=limits,
                          require=require_sandbox, workdir=workdir) if cwd else ["bash", "-c", command])
    except SandboxUnavailable as e:
        return BashResult(command, 126, f"[不可用] {e}", False)
    if workdir:
        os.makedirs(workdir, exist_ok=True)
    proc = subprocess.Popen(argv, cwd=workdir, env=scope_env(env or build_safe_env(), limits), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    cap = _Capture(proc.stdout)
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()                          # bwrap 被杀，命名空间里的进程经 --die-with-parent 一起死
        proc.wait()
        output, _ = cap.text()
        return BashResult(command, 124, f"[超时] 命令超过 {timeout}s 被终止\n{output}".rstrip(), True)
    output, truncated = cap.text()
    return BashResult(command, code, output, truncated)


def format_result(r: BashResult) -> str:
    """模型友好的输出格式。"""
    note = "\n[输出已截断]" if r.truncated else ""
    return f"$ {r.command}\n(exit {r.exit_code})\n{r.output}{note}"
