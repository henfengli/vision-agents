"""svcrun：按启动规格把业务进程跑在 bwrap 里，实现"一套部署、按环境起"。

    python3 -m agent_platform.services.svcrun <实例名>            # systemd 模板单元的 ExecStart
    python3 -m agent_platform.services.svcrun <实例名> --print    # 只打印 bwrap 命令行

启动规格（<数据目录>/instances/<实例名>.json）由 ProcessController 在启动前写好：

    {"instance": "board:test:web", "service": "board", "env": "test", "process": "web",
     "argv": [...], "workdir": "/srv/svc/board/code/test", "port": 8081,
     "binds": [["/srv/svc/board/conf/test/.env", "/srv/svc/board/code/test/.env"]],
     "masks": ["/srv/svc/board/conf/prod/.env", "/srv/svc/board/conf/dev/.env", "/home/agent/.config/agent-platform"],
     "env_vars": {"PORT": "8081"}}

隔离语义：
- 选中环境的配置文件只读 bind 到服务读的固定路径——服务零改动，固定路径里永远是该环境的内容
- 其他环境的配置文件、平台密钥目录遮蔽掉（文件换成 /dev/null，目录换成空目录）——进程物理上读不到
- 独立 pid 命名空间：看不到平台与别的进程
- --die-with-parent：systemd 停掉单元（或本地后端的父进程退出）即整组结束

bwrap 缺失直接失败：这里隔离本身就是目的，不能静默退化。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


def spec_path(instances_dir: str, instance: str) -> Path:
    return Path(instances_dir) / f"{instance}.json"


def mask_args(paths) -> list[str]:
    """遮蔽一组路径的 bwrap 参数（不存在的跳过）。agent 沙箱与业务进程共用。"""
    args: list[str] = []
    for p in sorted(set(paths)):
        if os.path.isdir(p):
            args += ["--tmpfs", p]
        elif os.path.exists(p):
            args += ["--ro-bind", "/dev/null", p]
    return args


def build_argv(spec: dict) -> list[str]:
    """启动规格 → bwrap 命令行。独立 pid 命名空间：业务进程看不到平台进程，
    读不到它的 /proc/<pid>/environ（用户级部署时两者是同一个用户）。"""
    argv = ["bwrap", "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--die-with-parent", "--new-session"]
    if spec.get("workdir"):
        argv += ["--chdir", spec["workdir"]]
    argv += mask_args(spec.get("masks") or [])
    for src, dst in spec.get("binds") or []:
        argv += ["--ro-bind", src, dst]
    env_vars = {**(spec.get("env_vars") or {}), "SVC_ENV": spec["env"], "SVC_NAME": spec["service"]}
    if spec.get("port") is not None:
        env_vars.setdefault("PORT", str(spec["port"]))
    for k, v in env_vars.items():
        argv += ["--setenv", k, str(v)]
    return argv + ["--", *spec["argv"]]


def _default_instances_dir() -> str:
    from ..config import _default_data_dir
    return os.path.join(_default_data_dir(), "instances")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="svcrun", description="按启动规格在 bwrap 里起业务进程（环境配置隔离）")
    ap.add_argument("instance", help="实例名：<服务>:<环境>:<进程>")
    ap.add_argument("--dir", default=os.environ.get("AGENT_INSTANCES_DIR") or _default_instances_dir(),
                    help="启动规格目录")
    ap.add_argument("--print", action="store_true", help="只打印命令行，不执行")
    args = ap.parse_args(argv)

    path = spec_path(args.dir, args.instance)
    try:
        spec = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        sys.exit(f"svcrun: 读不到启动规格 {path}：{e}")
    missing = [src for src, _ in spec.get("binds") or [] if not Path(src).exists()]
    if missing:
        sys.exit(f"svcrun: {spec['service']} 在 {spec['env']} 的配置文件不存在：{'、'.join(missing)}")
    cmd = build_argv(spec)
    if args.print:
        print(" ".join(cmd))
        return
    if shutil.which("bwrap") is None:
        sys.exit("svcrun: 未找到 bwrap（bubblewrap），请先安装")
    os.execvp("bwrap", cmd)


if __name__ == "__main__":
    main()
