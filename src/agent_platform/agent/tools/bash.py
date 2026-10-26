"""bash 工具：唯一的通用工具。

隔离由 bwrap 沙箱保证（agent/tools/sandbox.py：home 白名单、配置与 docker 遮蔽、默认断网、命令即 init），
资源由 systemd 用户 scope 限制（部署配置 limits）。本层只负责：工作目录收口、环境变量白名单
（secrets.env 注入的密钥不进子进程）、超时、输出截断。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass

from ...config import LimitsConfig

MAX_OUTPUT_CHARS = 8000

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


def run_command(command: str, timeout: int = 60, cwd: str | None = None, *, allow_net: bool = False,
                hidden: tuple[str, ...] = (), allow: tuple[str, ...] = (), limits: LimitsConfig | None = None,
                require_sandbox: bool = True) -> BashResult:
    """同步执行 shell 命令并截断输出。cwd（= scratch 目录）给定时经沙箱执行。"""
    from .sandbox import SandboxUnavailable, scope_env, wrap_argv
    try:
        argv = (wrap_argv(["bash", "-c", command], cwd, allow_net=allow_net, hidden=hidden, allow=allow,
                          limits=limits, require=require_sandbox) if cwd else ["bash", "-c", command])
    except SandboxUnavailable as e:
        return BashResult(command, 126, f"[不可用] {e}", False)
    try:
        proc = subprocess.run(argv, cwd=cwd, env=scope_env(build_safe_env(), limits),
                              capture_output=True, text=True, timeout=timeout)
        output, truncated = truncate(proc.stdout + proc.stderr)
        return BashResult(command, proc.returncode, output, truncated)
    except subprocess.TimeoutExpired:
        return BashResult(command, 124, f"[超时] 命令超过 {timeout}s 被终止", False)


def format_result(r: BashResult) -> str:
    """模型友好的输出格式。"""
    note = "\n[输出已截断]" if r.truncated else ""
    return f"$ {r.command}\n(exit {r.exit_code})\n{r.output}{note}"
