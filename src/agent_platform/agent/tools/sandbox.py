"""沙箱：bubblewrap 包装模型写的代码（bash 命令、项目内核），外面再套一个 systemd 用户 scope 限资源。

同机部署时平台和线上项目是同一个用户，能读到的东西很多（真实配置、~/.ssh、docker、systemd 用户总线），
所以沙箱按"能看到什么"白名单来做：

- 全盘只读（--ro-bind / /）
- home 整个换成空目录，只挂回需要的目录（只读）：代码目录、解释器所在的 conda 环境、方法目录，
  部署配置 home_allow 里额外写的；工作目录（scratch）可写
- /run/user/<uid> 换成空目录：碰不到 systemd 用户总线（否则能 systemctl --user 停平台自己）
- 遮蔽：docker 的 socket、服务声明的配置文件（按环境，见 services/envspec.masked_configs；文件换成 /dev/null，目录换成空目录）
- 项目内核再把本环境给 agent 的只读配置 bind 到项目读的路径上（只在受保护的环境），
  项目自己会写的日志文件换成可写的 /dev/null（项目代码 import 时打开日志不至于报只读）
- 独立 pid、ipc 命名空间：看不到同用户的其他进程和共享内存，读不到它们的 /proc/<pid>/environ、/proc/<pid>/root
- 网络不限（要连库、调接口）
- home 本身（或它的上级目录）不会被整个挂回：挂回的只能是 home 下的子目录

进程生命期（关键，别删）：bash 用 --unshare-pid + --as-pid-1，命令本身是 pid 命名空间的 init，
调用结束（正常返回 / 超时强杀 / worker 崩溃经 --die-with-parent）整个命名空间被 SIGKILL，
`&` / nohup / setsid 起的后台进程必死。

没有 bwrap 时：require_sandbox（默认）直接拒绝执行；只有开发机关掉它，退化成直接执行。
"""

from __future__ import annotations

import logging
import os
import shutil

from ...config import LimitsConfig

log = logging.getLogger(__name__)

_HAS_BWRAP: bool | None = None
# 不带进沙箱的环境变量（systemd-run 要用它们找用户总线，进了沙箱就没用了）
_DROP_ENV = ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")


class SandboxUnavailable(RuntimeError):
    pass


def has_bwrap() -> bool:
    global _HAS_BWRAP
    if _HAS_BWRAP is None:
        _HAS_BWRAP = shutil.which("bwrap") is not None
        if not _HAS_BWRAP:
            log.warning("bubblewrap 不可用：模型写的代码没有沙箱隔离")
    return _HAS_BWRAP


def mask_args(paths) -> list[str]:
    """遮蔽一组路径的 bwrap 参数（不存在的跳过）：目录换成空目录，文件换成 /dev/null。"""
    args: list[str] = []
    for p in sorted(set(paths)):
        if os.path.isdir(p):
            args += ["--tmpfs", p]
        elif os.path.exists(p):
            args += ["--ro-bind", "/dev/null", p]
    return args


def _under(path: str, base: str) -> bool:
    base = base.rstrip("/" + os.sep)
    return path == base or path.startswith(base + "/") or path.startswith(base + os.sep)


def bwrap_argv(argv: list[str], *, scratch: str, hidden=(), allow=(), binds=(), sinks=(), workdir: str | None = None,
               pid1: bool = False) -> list[str]:
    """allow：home 下要挂回的目录（只读，home 外的本来就看得见）；binds：[(宿主上的源, 沙箱里的路径)] 只读；
    sinks：可写的 /dev/null 盖住的文件（项目自己写的日志）。"""
    home = os.path.expanduser("~")
    hide_home = home not in ("", "/") and os.path.isdir(home)
    args = ["bwrap", "--ro-bind", "/", "/"]
    # 挂回 home 本身或它的上级（比如 python 是 ~/bin/python 推出来的 ~）等于没遮：平台密钥、~/.ssh 都会露出来
    allowed = sorted({os.path.normpath(p) for p in allow
                      if p and os.path.exists(p) and not (hide_home and _under(home, os.path.normpath(p)))}, key=len)
    if hide_home:
        args += ["--tmpfs", home]
        for p in allowed:
            if _under(p, home) and not any(_under(p, q) and p != q for q in allowed):
                args += ["--ro-bind", p, p]
    if hasattr(os, "getuid") and os.path.isdir(f"/run/user/{os.getuid()}"):
        args += ["--tmpfs", f"/run/user/{os.getuid()}"]
    def visible(p: str) -> bool:
        return not hide_home or not _under(p, home) or any(_under(p, q) for q in allowed)

    args += mask_args([m for m in hidden if visible(m)])
    for src, dst in binds:
        args += ["--ro-bind", src, dst]
    for p in sorted({s for s in sinks if os.path.isfile(s) and visible(s)}):
        args += ["--bind", "/dev/null", p]
    args += ["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", scratch, scratch,
             "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--new-session"]
    for k in _DROP_ENV:
        args += ["--unsetenv", k]
    if pid1:
        args.append("--as-pid-1")
    if workdir:
        args += ["--chdir", workdir]
    return args + ["--", *argv]


def limit_argv(argv: list[str], limits: LimitsConfig | None, *, memory: str) -> list[str]:
    """套一个 systemd 用户 scope：内存（不换 swap）和进程数有上限，超了只杀这一个 scope。CPU 不限。"""
    if limits is None or not limits.enabled:
        return argv
    return ["systemd-run", "--user", "--scope", "--quiet", "--collect", f"--slice={limits.slice}",
            "-p", f"MemoryMax={memory}", "-p", "MemorySwapMax=0", "-p", f"TasksMax={limits.tasks}", "--", *argv]


def scope_env(env: dict[str, str], limits: LimitsConfig | None) -> dict[str, str]:
    """systemd-run 要从环境变量找到用户总线；进 bwrap 时再去掉（--unsetenv）。"""
    if limits is None or not limits.enabled:
        return env
    return {**env, **{k: os.environ[k] for k in _DROP_ENV if k in os.environ}}


def wrap_argv(argv: list[str], scratch_dir: str, hidden=(), allow=(), *,
              limits: LimitsConfig | None = None, require: bool = True) -> list[str]:
    """bash 命令：命令即 init。没有 bwrap 时 require=True 抛 SandboxUnavailable，否则原样返回。"""
    if not has_bwrap():
        if require:
            raise SandboxUnavailable("没有 bwrap（bubblewrap），按部署配置 require_sandbox 拒绝执行")
        return argv
    inner = bwrap_argv(argv, scratch=scratch_dir, hidden=hidden, allow=allow, pid1=True)
    return limit_argv(inner, limits, memory=limits.bash_memory if limits else "")
