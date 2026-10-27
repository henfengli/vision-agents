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


def invisible_reason(path: str, *, hidden=(), allow=(), scratch: str = "", home: str | None = None) -> str | None:
    """这个路径在 bash 沙箱里看不看得到——read 工具在平台进程里直接读文件，按同一套规则拦（和 bwrap_argv 对齐）：
    home 下只有挂回的目录（allow）和 scratch；/proc、/dev、/tmp、/run/user 在沙箱里是新的、看不到宿主的；
    遮蔽的配置和目录看不到。路径和它解析软链接后的真实路径都要过。看得到返回 None，否则返回原因。"""
    def both(p: str) -> list[str]:       # bwrap 挂载时跟随软链接：写的路径和解析后的都算
        return list(dict.fromkeys([os.path.normpath(p), os.path.realpath(p)]))

    home = os.path.normpath(home if home is not None else os.path.expanduser("~"))
    hide_home = home not in ("", "/", os.sep) and os.path.isdir(home)
    allowed = [q for p in allow if p and not (hide_home and _under(home, os.path.normpath(p))) for q in both(p)]
    scratches = both(scratch) if scratch else []
    fresh = ["/proc", "/dev", "/tmp", "/sys"]
    if hasattr(os, "getuid"):
        fresh.append(f"/run/user/{os.getuid()}")
    masks = [q for m in hidden if m for q in both(m)]
    for p in both(path):
        if any(_under(p, m) for m in masks):
            return "这个文件 / 目录对 agent 遮蔽（含口令的配置：生产用 service_info(what=config) 读给 agent 的只读版）"
        if any(_under(p, q) for q in scratches):      # scratch 在 /tmp 新建之后才 bind，在 /tmp 下也看得到
            continue
        if any(_under(p, f) for f in fresh):
            return "沙箱里这个目录是新的（看不到宿主上的内容）"
        if hide_home and _under(p, home) and not any(_under(p, q) for q in allowed):
            return "home 下只看得到代码目录、解释器环境、方法目录和工作目录"
    return None


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
              limits: LimitsConfig | None = None, require: bool = True, workdir: str | None = None) -> list[str]:
    """bash 命令：命令即 init。没有 bwrap 时 require=True 抛 SandboxUnavailable，否则原样返回。
    scratch_dir 整个可写（db_query 的结果文件在它下面）；workdir 是命令的当前目录（本会话的工作目录）。"""
    if not has_bwrap():
        if require:
            raise SandboxUnavailable("没有 bwrap（bubblewrap），按部署配置 require_sandbox 拒绝执行")
        return argv
    inner = bwrap_argv(argv, scratch=scratch_dir, hidden=hidden, allow=allow, pid1=True, workdir=workdir)
    return limit_argv(inner, limits, memory=limits.bash_memory if limits else "")


def work_dir(scratch_dir: str, key: str) -> str:
    """会话的工作目录 <scratch>/work/<会话×服务×环境>：bash 的当前目录、py 内核和 bash 里的 $SCRATCH。
    同一台主机上并发的运行各写各的，不会互相覆盖同名文件；同一会话的 bash 和 py 共用。"""
    import hashlib
    import re
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", key)[:80]
    return os.path.join(scratch_dir, "work", f"{safe}-{hashlib.sha1(key.encode()).hexdigest()[:8]}")
