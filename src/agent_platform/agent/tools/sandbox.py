"""沙箱：bubblewrap 包装子进程（无容器拿到内核级隔离）。

威胁模型：内网可信用户 + 防误操作（不是对抗性代码），
bwrap 的 namespace 隔离足够；bwrap 不可用时退化直接执行并记警告。

策略：全盘只读、仅 scratch 可写、默认断网（--unshare-net）；
内网 API 访问由调用方显式选择放网。

进程生命期（关键，别删这两个 flag）：
--unshare-pid + --as-pid-1 让命令本身做 pid namespace 的 init——
调用结束（正常返回 / 超时强杀 / worker 崩溃经 --die-with-parent）
内核 SIGKILL 整个命名空间，`&`/nohup/setsid 起的后台服务必死，
不可能泄漏成"断网不可达但占着内存"的僵尸。少了它俩：
--die-with-parent 的 pdeathsig 只到直接子进程（bash），孙进程收不到
（bubblewrap#529）；也没有 pid ns 兜底，后台进程会活下来。
注意语义变化：沙箱内 ps 只见本调用进程；跨调用起服务本就连不上
（net ns 每次调用独立），唯一能用的模式是单次调用内起服务+验证。
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
    """给命令行套 bwrap 沙箱；不可用时原样返回（退化不失效，但进程
    清理与隔离保证全部消失——生产必须装 bwrap，install.sh 会检查告警）。"""
    if not has_bwrap():
        return argv
    args = [
        "bwrap",
        "--ro-bind", "/", "/",              # 全盘只读
        "--bind", scratch_dir, scratch_dir,  # 仅 scratch 可写
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--die-with-parent",                # 父进程死则沙箱内全灭（无孤儿）
        "--unshare-pid",                    # 独立 pid ns：ns init 死则全 ns 收 SIGKILL
        "--as-pid-1",                       # 命令即 init：调用结束 = 后台进程全灭
        "--new-session",
    ]
    if not allow_net:
        args.append("--unshare-net")
    return args + ["--"] + argv
