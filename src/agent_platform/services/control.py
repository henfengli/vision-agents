"""ProcessController：服务进程按环境启停（唯一执行点）。

后端：
- systemd（生产）：平台用户自己的 systemd --user 模板单元 agent-svc@<服务:环境:进程>.service
  （deploy/install-user.sh 装），ExecStart 是 svcrun；平台写好启动规格再 systemctl --user start，
  日志走 journalctl --user。
- local（开发）：本机子进程跑 svcrun，日志写 <数据目录>/instances/<实例>.log。
- off：只读，不允许启停。

按需启停：服务在该环境启用（envs[env].enabled）就能起，用完停；平台起的是本机副本。

租约：每次启动带租约（默认取进程定义，封顶 max_lease_hours），到期自动停——
调试用的环境不会被遗忘地一直跑着。续期从当前到期时间往后加。

env_spec() 是"按环境把配置文件就位"的唯一出处：进程启动规格和项目内核（services/kernel.py）共用。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from collections import deque
from pathlib import Path

from ..config import Settings
from ..domain import Rejected, ServiceDef
from ..domain.services import instance_name, render
from ..registry import Registry
from ..store import instances as instances_store
from .svcrun import spec_path

log = logging.getLogger(__name__)

_SYSTEMD_STATES = {"active": "running", "reloading": "running", "activating": "starting",
                   "deactivating": "stopping", "failed": "failed", "inactive": "stopped"}


async def _exec(*argv: str, timeout: float = 20.0) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        return 124, f"{argv[0]} 超时"
    return proc.returncode or 0, out.decode(errors="replace").strip()


class ProcessController:
    def __init__(self, settings: Settings, registry: Registry):
        self._settings = settings
        self._reg = registry
        self._cfg = settings.process_control
        self._local: dict[str, asyncio.subprocess.Process] = {}
        os.makedirs(settings.instances_dir, exist_ok=True)

    @property
    def backend(self) -> str:
        return self._cfg.backend

    # —— 解析 ——

    async def _resolve(self, service: str, env: str, process: str) -> tuple[ServiceDef, int | None]:
        await self._reg.env(env)
        s = await self._reg.service(service)
        if s is None:
            raise Rejected.not_found(f"服务 {service}")
        proc = s.spec.processes.get(process)
        if proc is None:
            raise Rejected.not_found(f"服务 {service} 的进程 {process}")
        return s.spec, proc.ports.get(env)

    async def env_spec(self, svc: ServiceDef, env: str) -> dict:
        """这个环境的配置文件 bind 到固定路径，其他环境的同名文件与平台密钥遮蔽。
        → {binds: [[源, 固定路径]], masks: [...], python, env_vars}。缺配置文件时报 config_missing。"""
        s = self._settings
        # 配置备份与同步补丁里有各环境的配置原文：和别的环境的配置文件一样遮蔽
        binds, masks = [], [*s.hidden_paths, s.config_history_dir, s.sync_backups_dir]
        all_envs = (await self._reg.envs()).names
        for c in svc.configs:
            selected = c.path_for(env)
            binds.append([selected, c.canonical_for(env)])
            for other in all_envs:
                if other == env:
                    continue
                for p in (c.path_for(other), c.canonical_for(other)):
                    if p not in (selected, c.canonical_for(env)) and os.path.exists(p):
                        masks.append(p)
        view = svc.view("", env)
        return {"binds": binds, "masks": masks, "python": view.python, "env_vars": view.env_vars}

    async def runtime_spec(self, service: str, env: str) -> dict:
        """项目内核用：该服务×环境的解释器、工作目录、配置就位规格。不依赖进程控制后端（off 也能用）。"""
        s = await self._reg.service(service)
        if s is None:
            raise Rejected.not_found(f"服务 {service}")
        view = await self._reg.service_view(service, env)
        if not view.enabled:
            raise Rejected("service_env_disabled", f"服务 {service} 在 {env} 环境已停用")
        spec = {**await self.env_spec(s.spec, env), "service": service, "env": env, "workdir": view.root or None}
        self.prepare_binds(spec, service, env)
        return spec

    @staticmethod
    def prepare_binds(spec: dict, service: str, env: str) -> None:
        """起进程 / 内核前：配置文件得在，固定路径得有个占位（bwrap 只能往已存在的路径上 bind）。"""
        missing = [src for src, _ in spec["binds"] if not os.path.exists(src)]
        if missing:
            raise Rejected("config_missing", f"{service} 在 {env} 的配置文件不存在：{'、'.join(missing)}")
        ensure_mount_points([dst for _, dst in spec["binds"]])

    async def build_spec(self, service: str, svc: ServiceDef, env: str, process: str) -> dict:
        """启动规格：命令/工作目录渲染好（cmd 里可写 {env} {port} {python}），配置文件按环境就位。"""
        proc = svc.processes[process]
        port = proc.ports.get(env)
        base = await self.env_spec(svc, env)
        python = base["python"]
        return {
            "instance": instance_name(service, env, process), "service": service, "env": env, "process": process,
            "argv": [render(a, env, port, python) for a in proc.cmd],
            "workdir": render(proc.workdir or svc.root, env, port) or None, "port": port,
            "binds": base["binds"], "masks": base["masks"],
            "env_vars": {**base["env_vars"], **{k: render(v, env, port, python) for k, v in proc.env_vars.items()}},
        }

    # —— 观察 ——

    async def list(self, service: str) -> list[dict]:
        """该服务全部 (环境 × 进程) 的实例状态，未启动过的也列出（stopped）。enabled：服务在该环境是否启用。"""
        s = await self._reg.service(service)
        if s is None:
            raise Rejected.not_found(f"服务 {service}")
        rows = {(r["env"], r["process"]): r for r in await instances_store.of_service(service)}
        out = []
        for e in (await self._reg.envs()).items:
            env = e.name
            enabled = s.spec.view(service, env).enabled
            for process, pdef in s.spec.processes.items():
                row = rows.get((env, process)) or {
                    "service": service, "env": env, "process": process, "state": "stopped", "port": None, "pid": None,
                    "started_at": None, "lease_until": None, "started_by": None, "last_exit": None}
                if row["port"] is None:
                    row["port"] = pdef.ports.get(env)
                out.append({**await self._reconcile(row), "enabled": enabled})
        return out

    async def get(self, service: str, env: str, process: str) -> dict:
        await self._resolve(service, env, process)
        for row in await self.list(service):
            if row["env"] == env and row["process"] == process:
                return row
        raise Rejected.not_found("进程实例")

    async def _reconcile(self, row: dict) -> dict:
        """数据库记的是"我们以为的"，这里对一眼真实状态；进程自己挂了就落 failed。"""
        if row["state"] not in ("running", "starting", "stopping"):
            return row
        live, pid, exit_code = await self._live_state(row["service"], row["env"], row["process"], row.get("pid"))
        if live in ("stopped", "failed"):
            await instances_store.mark_stopped(row["service"], row["env"], row["process"], exit_code=exit_code,
                                               failed=live == "failed" or (exit_code not in (None, 0)))
            return (await instances_store.get(row["service"], row["env"], row["process"])) or row
        return {**row, "state": live, "pid": pid or row.get("pid")}

    async def _live_state(self, service: str, env: str, process: str, pid: int | None) -> tuple[str, int | None, int | None]:
        inst = instance_name(service, env, process)
        if self.backend == "systemd":
            code, out = await self._systemctl("show", self._unit(inst), "-p", "ActiveState", "-p", "MainPID",
                                              "-p", "ExecMainStatus", "--value")
            if code != 0:
                return "stopped", None, None
            parts = out.splitlines() + ["", "", ""]
            state = _SYSTEMD_STATES.get(parts[0].strip(), "stopped")
            main_pid = int(parts[1]) if parts[1].strip().isdigit() and int(parts[1]) > 0 else None
            status = int(parts[2]) if parts[2].strip().lstrip("-").isdigit() else None
            return state, main_pid, status
        proc = self._local.get(inst)
        if proc is not None:
            if proc.returncode is None:
                return "running", proc.pid, None
            return ("failed" if proc.returncode else "stopped"), None, proc.returncode
        if pid and _pid_alive(pid):
            return "running", pid, None
        return "stopped", None, None

    async def logs(self, service: str, env: str, process: str, lines: int = 200) -> list[str]:
        await self._resolve(service, env, process)
        inst = instance_name(service, env, process)
        lines = max(10, min(lines, 2000))
        if self.backend == "systemd":
            _, out = await _exec("journalctl", "--user", "-u", self._unit(inst), "-n", str(lines),
                                 "--no-pager", "-o", "short-iso")
            return out.splitlines()
        path = self._log_path(inst)
        if not path.exists():
            return []
        with path.open("r", errors="replace") as f:
            return [line.rstrip("\n") for line in deque(f, maxlen=lines)]

    # —— 动作 ——

    def _require_enabled(self) -> None:
        if self.backend == "off":
            raise Rejected("process_control_off", "平台未开启进程启停（process_control.backend=off）")

    async def ensure_startable(self, service: str, env: str) -> None:
        """能不能在这个环境起进程：开了进程控制、服务在该环境启用。"""
        self._require_enabled()
        view = await self._reg.service_view(service, env)
        if view is None:
            raise Rejected.not_found(f"服务 {service}")
        if not view.enabled:
            raise Rejected("service_env_disabled", f"服务 {service} 在 {env} 环境已停用")

    async def start(self, service: str, env: str, process: str, *, by: str, lease_hours: float | None = None) -> dict:
        svc, port = await self._resolve(service, env, process)
        await self.ensure_startable(service, env)
        current = await self.get(service, env, process)
        if current["state"] in ("running", "starting"):
            return current
        spec = await self.build_spec(service, svc, env, process)
        self.prepare_binds(spec, service, env)
        spec_path(self._settings.instances_dir, spec["instance"]).write_text(json.dumps(spec, ensure_ascii=False, indent=2))
        limits = await self._reg.config("processes")
        lease = min(lease_hours or svc.processes[process].lease_hours or limits.default_lease_hours, limits.max_lease_hours)
        pid = await self._backend_start(spec["instance"])
        await instances_store.mark_started(service, env, process, port=port, pid=pid, lease_hours=lease, by=by)
        log.info("启动 %s（%s，租约 %.1fh）", spec["instance"], by, lease)
        return await self.get(service, env, process)

    async def stop(self, service: str, env: str, process: str, *, by: str) -> dict:
        self._require_enabled()
        await self._resolve(service, env, process)
        inst = instance_name(service, env, process)
        exit_code = await self._backend_stop(inst)
        await instances_store.mark_stopped(service, env, process, exit_code=exit_code, failed=False)
        log.info("停止 %s（%s）", inst, by)
        return await self.get(service, env, process)

    async def renew(self, service: str, env: str, process: str, hours: float | None = None) -> dict:
        svc, _ = await self._resolve(service, env, process)
        limits = await self._reg.config("processes")
        hours = hours or svc.processes[process].lease_hours or limits.default_lease_hours
        if await instances_store.renew(service, env, process, hours, limits.max_lease_hours) is None:
            raise Rejected("not_running", "进程没有在运行，无法续期", 409)
        return await self.get(service, env, process)

    async def sweep(self) -> list[dict]:
        """租约到期的停掉，返回被停掉的实例。由维护循环周期调用。"""
        stopped = []
        for row in await instances_store.expired_leases():
            try:
                stopped.append(await self.stop(row["service"], row["env"], row["process"], by="lease"))
            except Exception:  # noqa: BLE001 —— 单个失败不影响其余，下一轮再试
                log.exception("租约到期停止 %s/%s/%s 失败", row["service"], row["env"], row["process"])
        return stopped

    # —— 后端 ——

    def _unit(self, inst: str) -> str:
        return f"{self._cfg.unit}@{inst}.service"

    async def _systemctl(self, *args: str, timeout: float = 20.0) -> tuple[int, str]:
        return await _exec("systemctl", "--user", *args, timeout=timeout)

    def _log_path(self, inst: str) -> Path:
        return Path(self._settings.instances_dir) / f"{inst}.log"

    async def _backend_start(self, inst: str) -> int | None:
        if self.backend == "systemd":
            code, out = await self._systemctl("start", "--no-block", self._unit(inst))
            if code != 0:
                raise Rejected("start_failed", f"systemctl start 失败：{out[-500:]}", 500)
            _, pid = await self._systemctl("show", self._unit(inst), "-p", "MainPID", "--value")
            return int(pid) if pid.isdigit() and int(pid) > 0 else None
        logf = self._log_path(inst).open("ab")
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "agent_platform.services.svcrun", inst, "--dir", self._settings.instances_dir,
            stdout=logf, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
        logf.close()
        self._local[inst] = proc
        asyncio.get_running_loop().create_task(self._reap(inst, proc))
        return proc.pid

    async def _reap(self, inst: str, proc: asyncio.subprocess.Process) -> None:
        code = await proc.wait()
        service, env, process = inst.split(":")
        row = await instances_store.get(service, env, process)
        if row and row["state"] == "running" and row.get("pid") == proc.pid:
            await instances_store.mark_stopped(service, env, process, exit_code=code, failed=code != 0)

    async def _backend_stop(self, inst: str) -> int | None:
        if self.backend == "systemd":
            code, out = await self._systemctl("stop", self._unit(inst), timeout=60)
            if code != 0:
                raise Rejected("stop_failed", f"systemctl stop 失败：{out[-500:]}", 500)
            return 0
        proc = self._local.pop(inst, None)
        if proc is not None:
            if proc.returncode is not None:
                return proc.returncode
            try:
                os.killpg(proc.pid, 15)
                return await asyncio.wait_for(proc.wait(), 15)
            except (TimeoutError, asyncio.TimeoutError):
                os.killpg(proc.pid, 9)
                return await proc.wait()
            except ProcessLookupError:
                return None
        # 平台重启前起的本地进程：手里没有句柄，按记录的 pid 结束整个进程组
        service, env, process = inst.split(":")
        row = await instances_store.get(service, env, process)
        pid = row.get("pid") if row else None
        if pid and _pid_alive(pid):
            try:
                os.killpg(pid, 15)
            except ProcessLookupError:
                pass
        return None


def ensure_mount_points(paths: list[str]) -> None:
    """bwrap 往固定路径 bind 时目标必须已存在，否则它会以业务进程用户的身份去建（多半没有写权限）。
    每环境一个 worktree 时固定路径（如 /srv/code/board/test/.env）通常不存在：平台先建个空文件占位。"""
    for p in paths:
        if os.path.exists(p):
            continue
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            Path(p).touch()
        except OSError as e:
            raise Rejected("config_missing", f"配置文件的固定路径 {p} 不存在，平台也建不了（{e.strerror}）："
                                             "让平台用户对代码目录有写权限，或手工建好这个文件") from e


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:      # 进程在，只是不归我们
        return True
    return True
