"""按需环境启动器：一套代码 + bwrap 配置文件隔离，会话结束服务自动结束。

背景：prod/test/dev 三套服务几乎只有配置文件不同，常驻三套是浪费。
本模块把"环境"从部署单元变成启动参数：

    python3 -m agent_platform.envrun test          # 前台运行，Ctrl-C/会话结束即停
    python3 -m agent_platform.envrun prod --print  # 只打印将要 exec 的 bwrap 命令

隔离与生命周期（bwrap 承担，与 agent 工具的 sandbox.py 同一机制）：
- 配置隔离：命名空间里其他环境的 conf/env/<other>.yaml 与
  secrets.<other>.env 全部被 /dev/null 覆盖——进程物理上读不到别环境配置
- 生命周期：--die-with-parent，启动它的 shell/SSH/tmux 会话结束，
  服务随之结束，不留孤儿进程
- secrets：/etc/agent-platform/secrets.<env>.env（KEY=VALUE 行，
  兼容 secrets.env 单文件旧约定），解析后只以环境变量注入沙箱

常驻 prod（需要 7×24 的那一套）仍可用 deploy/agent-platform.service
（systemd 收口）；本启动器面向"平时不跑、要用才起"的环境。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

DEFAULT_SECRETS_DIR = Path("/etc/agent-platform")


def parse_secrets(path: Path) -> dict[str, str]:
    """解析 KEY=VALUE 行（兼容 export 前缀、引号值、# 注释）。"""
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ").strip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


def resolve_secrets(secrets_dir: Path, env: str) -> Path:
    """本环境的 secrets 文件：secrets.<env>.env 优先，回退旧约定 secrets.env。"""
    per_env = secrets_dir / f"secrets.{env}.env"
    if per_env.exists():
        return per_env
    legacy = secrets_dir / "secrets.env"
    if legacy.exists():
        print(f"envrun: 未找到 {per_env}，回退旧约定 {legacy}", file=sys.stderr)
        return legacy
    raise FileNotFoundError(
        f"secrets 文件不存在：{per_env}（或旧约定 {legacy}）")


def masked_paths(conf_root: Path, secrets_dir: Path, env: str,
                 secrets_in_use: Path) -> list[Path]:
    """需要被 /dev/null 覆盖的路径：非本环境的 env yaml + 不在用的 secrets 文件。"""
    envs_dir = conf_root / "env"
    masks = [p for p in sorted(envs_dir.glob("*.yaml"))
             if p.stem != env] if envs_dir.is_dir() else []
    masks += [p for p in sorted(secrets_dir.glob("secrets*.env"))
              if p != secrets_in_use]
    return masks


def build_argv(env: str, conf_root: Path, secrets_dir: Path,
               python: str | None = None) -> list[str]:
    """构造 bwrap 命令行（纯函数，测试面）。"""
    secrets_file = resolve_secrets(secrets_dir, env)
    argv = [
        "bwrap",
        "--dev-bind", "/", "/",          # 从主机视图起步（python/venv/库可见）
        "--die-with-parent",             # 会话结束 = 服务结束（无孤儿）
        "--new-session",
    ]
    for path in masked_paths(conf_root, secrets_dir, env, secrets_file):
        argv += ["--ro-bind", "/dev/null", str(path)]
    argv += ["--setenv", "AGENT_ENV", env,
             "--setenv", "AGENT_CONF", str(conf_root)]
    for key, value in parse_secrets(secrets_file).items():
        argv += ["--setenv", key, value]
    return argv + ["--", python or sys.executable, "-m", "agent_platform.serve"]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="agent-platform.envrun",
        description="按需启动指定环境的服务（bwrap 隔离配置，会话结束自动停止）")
    ap.add_argument("env", help="环境名（对应 conf/env/<env>.yaml）")
    ap.add_argument("--conf-root", default=os.environ.get("AGENT_CONF", "conf"),
                    help="配置根目录（默认 $AGENT_CONF 或 ./conf）")
    ap.add_argument("--secrets-dir", default=str(DEFAULT_SECRETS_DIR),
                    help="secrets 目录（默认 /etc/agent-platform）")
    ap.add_argument("--print", action="store_true",
                    help="只打印 bwrap 命令行，不执行")
    args = ap.parse_args(argv)

    conf_root = Path(args.conf_root).resolve()
    env_yaml = conf_root / "env" / f"{args.env}.yaml"
    if not env_yaml.exists():
        sys.exit(f"envrun: 未知环境 {args.env}——{env_yaml} 不存在")
    try:
        cmd = build_argv(args.env, conf_root, Path(args.secrets_dir).resolve())
    except FileNotFoundError as e:
        sys.exit(f"envrun: {e}")
    if args.print:
        print(" ".join(cmd))
        return
    if shutil.which("bwrap") is None:
        # 与工具沙箱不同：这里隔离本身就是目的，不能静默退化
        sys.exit("envrun: 未找到 bwrap（bubblewrap）。请安装后再试；"
                 "常驻部署可改用 deploy/agent-platform.service（systemd 收口）")
    os.execvp("bwrap", cmd)


if __name__ == "__main__":
    main()
