"""沙箱：bubblewrap 包装子进程（无容器拿到内核级隔离）。

威胁模型：内网可信用户 + 防误操作（不是对抗性代码），
bwrap 的 namespace 隔离足够；bwrap 不可用时退化直接执行并记警告。

策略：全盘只读、仅 scratch 可写、默认断网（--unshare-net）；
Dagster/内网 API 访问由 bash 命令里显式走代理或调用方选择放网。
"""

from __future__ import annotations

import logging
import shutil

log = logging.getLogger(__name__)

_HAS_BWRAP: bool | None = None


def has_bwrap() -> bool:
    global _HAS_BWRAP
    if _HAS_BWRAP is None:
        _HAS_BWRAP = shutil.which("bwrap") is not None
        if not _HAS_BWRAP:
            log.warning("bubblewrap 不可用：子进程无沙箱隔离（仅 systemd 加固兜底）")
    return _HAS_BWRAP


def wrap_argv(argv: list[str], scratch_dir: str, allow_net: bool = False) -> list[str]:
    """给命令行套 bwrap 沙箱；不可用时原样返回（退化不失效）。"""
    if not has_bwrap():
        return argv
    args = [
        "bwrap",
        "--ro-bind", "/", "/",          # 全盘只读
        "--bind", scratch_dir, scratch_dir,  # 仅 scratch 可写
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--die-with-parent",            # 父进程死则沙箱内全灭（无孤儿）
        "--new-session",
    ]
    if not allow_net:
        args.append("--unshare-net")
    return args + ["--"] + argv
