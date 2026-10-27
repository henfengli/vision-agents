"""本机的日志与主机状况（同机部署：执行运行的 agent 服务就装在服务×环境部署的那台主机上）。

都在沙箱外由平台执行，命令和路径写死：日志只读服务定义里声明过的（文件 / docker 容器），
模型只能选看哪一个、看多少行、按什么过滤，拼不了命令。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time

MAX_LINES = 2000
MAX_CHARS = 12000
_TAIL_BLOCK = 64 * 1024


def _tail_file(path: str, lines: int) -> list[str]:
    """从文件末尾往前读够 lines 行（大文件不整份读进来）。"""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        end = f.tell()
        data, pos = b"", end
        while pos > 0 and data.count(b"\n") <= lines:
            step = min(_TAIL_BLOCK, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
            if end - pos > 64 * 1024 * 1024:          # 最多往回读 64MB
                break
    return data.decode("utf-8", errors="replace").splitlines()[-lines:]


def _docker_logs(container: str, lines: int, since: str) -> list[str]:
    if shutil.which("docker") is None:
        raise RuntimeError("本机没有 docker 命令")
    argv = ["docker", "logs", "--tail", str(lines), "--timestamps"]
    if since:
        argv += ["--since", since]
    r = subprocess.run([*argv, container], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=30)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-500:] or f"docker logs 退出码 {r.returncode}")
    return (r.stdout + r.stderr).splitlines()[-lines:]


def read_log(target: str, *, lines: int = 200, grep: str = "", since: str = "") -> str:
    """target：文件路径或 docker:<容器名>。grep 是正则（不分大小写），先取最后 lines 行再过滤；
    since 只对 docker 生效（如 30m、2h、2026-10-21T08:00:00）。"""
    lines = max(1, min(int(lines), MAX_LINES))
    try:
        if target.startswith("docker:"):
            out = _docker_logs(target[7:], lines, since)
        else:
            out = _tail_file(target, lines)
    except FileNotFoundError:
        return f"[不存在] {target}"
    except PermissionError:
        return f"[没有权限] 平台用户读不了 {target}（请运维给平台用户加读权限，见部署指南）"
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
        return f"[读取失败] {target}：{e}"
    if grep:
        try:
            pat = re.compile(grep, re.IGNORECASE)
        except re.error as e:
            return f"[参数] grep 不是合法的正则：{e}"
        out = [line for line in out if pat.search(line)]
    text = "\n".join(out)
    if len(text) > MAX_CHARS:
        text = "…[前面省略，只显示最后 %d 字]\n" % MAX_CHARS + text[-MAX_CHARS:]
    head = f"[{target}] 最后 {lines} 行" + (f"里匹配 {grep!r} 的 {len(out)} 行" if grep else "")
    return head + "\n" + (text or "（没有内容）")


def _run(argv: list[str], timeout: float = 10, *, any_exit: bool = False) -> str | None:
    """any_exit：退出码不是 0 也要输出（systemctl is-active 在服务没起时退出 3，这时的输出恰恰最有用）。"""
    if shutil.which(argv[0]) is None:
        return None
    try:
        r = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() if r.returncode == 0 or any_exit else None


def _meminfo() -> dict[str, int]:
    out = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                out[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    return out


def _gb(n: int) -> str:
    return f"{n / 1024 ** 3:.1f}G"


def host_status(paths: list[str] | None = None) -> str:
    """负载、内存、磁盘、占内存最多的进程、docker 容器、nginx。拿不到的项跳过。"""
    lines = []
    try:
        with open("/proc/loadavg") as f:
            load = f.read().split()[:3]
        with open("/proc/uptime") as f:
            up = float(f.read().split()[0])
        lines.append(f"负载 {' / '.join(load)}（{os.cpu_count()} 核），已运行 {up / 86400:.1f} 天")
    except OSError:
        pass
    m = _meminfo()
    if m:
        total, avail = m.get("MemTotal", 0), m.get("MemAvailable", 0)
        swap = m.get("SwapTotal", 0) - m.get("SwapFree", 0)
        lines.append(f"内存 已用 {_gb(total - avail)} / {_gb(total)}（可用 {_gb(avail)}），swap 已用 {_gb(swap)}")
    seen = set()
    for p in ["/", *(paths or [])]:
        if not p or not os.path.exists(p):
            continue
        st = os.statvfs(p) if hasattr(os, "statvfs") else None
        if st is None or st.f_fsid in seen:
            continue
        seen.add(st.f_fsid)
        total, free = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
        lines.append(f"磁盘 {p}：已用 {_gb(total - free)} / {_gb(total)}（{(total - free) * 100 // max(total, 1)}%）")
    if top := _run(["ps", "-eo", "pid,user,rss,pcpu,etime,args", "--sort=-rss"]):
        rows = top.splitlines()[:11]
        lines.append("占内存最多的进程（RSS KB）：\n" + "\n".join(r[:160] for r in rows))
    if docker := _run(["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"]):
        lines.append("docker 容器：\n" + docker)
    if nginx := _run(["systemctl", "is-active", "nginx"], any_exit=True):
        lines.append(f"nginx：{nginx}")
    lines.append(f"（采集于 {time.strftime('%Y-%m-%d %H:%M:%S')}）")
    return "\n".join(lines)
