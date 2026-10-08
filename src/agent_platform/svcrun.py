"""通用服务纳管启动器：业务服务按需启动 + bwrap 环境配置隔离。

背景：与 agent 平台同机的业务服务（dagster/board/config-center…）过去按
prod/test/dev 各常驻一套，而这些服务几乎只有配置文件不同。svcrun 把
"环境"从部署单元变成启动参数——平时一套都不跑，要用哪个环境就起哪个：

    python3 -m agent_platform.svcrun dagster-webserver test  # 前台起，会话结束即停
    python3 -m agent_platform.svcrun board test --print      # 只打印将执行的命令
    python3 -m agent_platform.svcrun --list                  # 看注册表

注册表 conf/services.yaml（新服务加一段即纳管）：

    envs: [prod, test, dev]
    services:
      dagster-webserver:
        workdir: /srv/dagster
        cmd: ["/srv/dagster/venv/bin/dagster-webserver", "-w", workspace.yaml,
              "-p", "{port}"]
        ports: {prod: 3000, test: 3001, dev: 3002}   # cmd/configs 里可用 {port}/{env}
        configs:
          - canonical: /srv/dagster/dagster.yaml     # 服务读的固定路径
            template: /srv/dagster/conf/dagster.{env}.yaml

隔离语义（bwrap，与工具沙箱同一机制但用途不同）：
- 选中环境的配置 bind 到 canonical——服务零改动；固定路径里永远是
  选中环境的内容，不可能拿错环境（优于在启动命令里传配置路径：
  不依赖服务支持配置参数，也不存在"忘传参数读到默认配置"的坑）
- 其他环境的配置文件存在即遮蔽为 /dev/null——进程物理上读不到别环境配置
- --die-with-parent：启动它的 shell/SSH/tmux 会话结束，服务自动结束

bwrap 缺失直接报错：这里隔离本身就是目的，不能静默退化。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

import yaml

DEFAULT_REGISTRY = Path(os.environ.get("AGENT_CONF", "conf")) / "services.yaml"


def load_registry(path: Path) -> dict:
    """读注册表并做声明期校验（配置问题暴露于启动前）。"""
    reg = yaml.safe_load(path.read_text()) or {}
    envs = reg.get("envs")
    if not isinstance(envs, list) or not envs:
        raise ValueError(f"{path} 缺少顶层 envs 列表")
    services = reg.get("services") or {}
    for name, svc in services.items():
        if not isinstance(svc.get("cmd"), list) or not svc["cmd"]:
            raise ValueError(f"服务 {name} 缺少 cmd（列表）")
        for cfg in svc.get("configs") or []:
            if "canonical" not in cfg or "template" not in cfg:
                raise ValueError(f"服务 {name} 的 configs 条目需要 canonical + template")
    return {"envs": envs, "services": services}


def _render(template: str, env: str, port: int | None) -> str:
    return template.replace("{env}", env).replace("{port}", str(port or ""))


def build_argv(registry: dict, service: str, env: str,
               *, path_exists=lambda p: Path(p).exists()) -> list[str]:
    """构造 bwrap 命令行（纯函数，测试面；path_exists 可注入便于单测）。"""
    services = registry["services"]
    if service not in services:
        raise ValueError(f"未知服务 {service}（注册表里有：{sorted(services)}）")
    if env not in registry["envs"]:
        raise ValueError(f"未知环境 {env}（注册表里有：{registry['envs']}）")
    svc = services[service]
    port = (svc.get("ports") or {}).get(env)

    argv = ["bwrap", "--dev-bind", "/", "/",  # 从主机视图起步（解释器/依赖可见）
            "--die-with-parent",              # 会话结束 = 服务结束（无孤儿）
            "--new-session"]
    if svc.get("workdir"):
        argv += ["--chdir", _render(svc["workdir"], env, port)]

    for cfg in svc.get("configs") or []:
        selected = _render(cfg["template"], env, port)
        if not path_exists(selected):
            raise FileNotFoundError(
                f"服务 {service} 环境 {env} 的配置文件不存在：{selected}")
        # 选中环境 bind 到服务读的固定路径
        argv += ["--ro-bind", selected, _render(cfg["canonical"], env, port)]
        # 其他环境的同名配置文件：存在即遮蔽
        for other_env in registry["envs"]:
            if other_env == env:
                continue
            other = _render(cfg["template"], other_env,
                            (svc.get("ports") or {}).get(other_env))
            if other != selected and path_exists(other):
                argv += ["--ro-bind", "/dev/null", other]

    for key, value in (svc.get("env_vars") or {}).items():
        argv += ["--setenv", key, _render(str(value), env, port)]
    argv += ["--setenv", "SVCRUN_ENV", env]
    return argv + ["--"] + [_render(part, env, port) for part in svc["cmd"]]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="agent-platform.svcrun",
        description="业务服务按需启动（bwrap 隔离环境配置，会话结束自动停止）")
    ap.add_argument("service", nargs="?", help="注册表里的服务名")
    ap.add_argument("env", nargs="?", help="环境名（注册表顶层 envs 之一）")
    ap.add_argument("--registry",
                    default=os.environ.get("SVCRUN_REGISTRY",
                                           str(DEFAULT_REGISTRY)),
                    help="注册表路径（默认 conf/services.yaml）")
    ap.add_argument("--list", action="store_true", help="列出注册表里的服务")
    ap.add_argument("--print", action="store_true",
                    help="只打印 bwrap 命令行，不执行")
    args = ap.parse_args(argv)

    try:
        registry = load_registry(Path(args.registry))
    except (OSError, ValueError) as e:
        sys.exit(f"svcrun: {e}")

    if args.list or not args.service:
        for name, svc in sorted(registry["services"].items()):
            ports = svc.get("ports") or {}
            port_text = " ".join(f"{e}:{p}" for e, p in ports.items())
            print(f"{name:24s} {port_text:28s} {' '.join(svc['cmd'][:2])}")
        if not args.list:
            print("\n用法：svcrun <service> <env>")
        return
    if not args.env:
        sys.exit("svcrun: 缺少环境名（用法：svcrun <service> <env>）")

    try:
        cmd = build_argv(registry, args.service, args.env)
    except (ValueError, FileNotFoundError) as e:
        sys.exit(f"svcrun: {e}")
    if args.print:
        print(" ".join(cmd))
        return
    if shutil.which("bwrap") is None:
        # 与工具沙箱不同：这里隔离本身就是目的，不能静默退化
        sys.exit("svcrun: 未找到 bwrap（bubblewrap），请安装后再试")
    os.execvp("bwrap", cmd)


if __name__ == "__main__":
    main()
