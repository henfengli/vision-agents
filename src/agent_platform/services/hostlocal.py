"""本机的日志与主机状况（同机部署：执行运行的 agent 服务就装在服务×环境部署的那台主机上）。

都在沙箱外由平台执行，命令和路径写死：日志只读服务定义里声明过的（文件 / docker 容器 / systemd 单元），
模型只能选看哪一个、看多少行、按什么过滤，拼不了命令。
"""

from __future__ import annotations

import collections
import glob
import os
import re
import shutil
import subprocess
import time

MAX_LINES = 2000
MAX_CHARS = 12000
GREP_SCAN_BYTES = 512 * 1024 * 1024     # 文件按正则搜时最多从末尾往回扫这么多（大日志不整份扫）
GREP_STREAM_LINES = 50000               # docker / journal 按正则搜时取最后这么多行再过滤
GREP_SCAN_SECONDS = 20                  # 文件按正则搜最多扫这么久
_TAIL_BLOCK = 64 * 1024
_SINCE_RE = re.compile(r"^\d+[smhd]$")


def resolve_file(target: str) -> str:
    """带通配（* ? [）的路径取最新修改的那个文件：按日期 / 序号滚动的日志写成 app-*.log 即可。"""
    if not any(c in target for c in "*?["):
        return target
    files = [p for p in glob.glob(target) if os.path.isfile(p)]
    if not files:
        raise FileNotFoundError(target)
    return max(files, key=os.path.getmtime)


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


def _grep_file(path: str, pat: re.Pattern, lines: int) -> tuple[list[str], int, str]:
    """整个文件（超过 GREP_SCAN_BYTES 只扫末尾那么多）里匹配的行，留最后 lines 条。逐行流式读，不整份进内存；
    最多扫 GREP_SCAN_SECONDS 秒（正则是模型写的，慢正则不能一直占着线程）。
    返回 (匹配行, 匹配总数, 扫描范围的说明)。"""
    found: collections.deque[str] = collections.deque(maxlen=lines)
    total = 0
    deadline = time.monotonic() + GREP_SCAN_SECONDS
    with open(path, "rb") as f:
        size = f.seek(0, os.SEEK_END)
        start = max(0, size - GREP_SCAN_BYTES)
        f.seek(start)
        if start:
            f.readline()                               # 丢掉半行
        for i, raw in enumerate(f):
            if i % 20000 == 0 and i and time.monotonic() > deadline:
                done = (f.tell() - start) * 100 // max(size - start, 1)
                return list(found), total, f"前 {done}%（扫了 {GREP_SCAN_SECONDS} 秒就停了，正则写具体点或缩小范围）"
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if pat.search(line):
                total += 1
                found.append(line)
    return list(found), total, "文件末尾 512MB" if start else "整个文件"


def _docker_logs(container: str, lines: int, since: str) -> list[str]:
    if shutil.which("docker") is None:
        raise RuntimeError("本机没有 docker 命令")
    argv = ["docker", "logs", "--tail", str(lines), "--timestamps"]
    if since:
        argv += ["--since", since]
    r = subprocess.run([*argv, container], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-500:] or f"docker logs 退出码 {r.returncode}")
    return (r.stdout + r.stderr).splitlines()[-lines:]


def _journal(unit: str, lines: int, since: str) -> list[str]:
    """systemd 单元的日志：先查系统日志（平台用户要在 systemd-journal 组里），没有条目再查本用户的。"""
    if shutil.which("journalctl") is None:
        raise RuntimeError("本机没有 journalctl")
    argv = ["journalctl", "--no-pager", "-o", "short-iso", "-n", str(lines)]
    if since:
        argv += ["--since", f"-{since}" if _SINCE_RE.match(since) else since]
    err = ""
    for scope in ([], ["--user"]):
        r = subprocess.run([*argv, *scope, "-u", unit], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=60)
        out = [ln for ln in r.stdout.splitlines() if ln.strip() and not ln.startswith("-- ")]
        if r.returncode == 0 and out:
            return out[-lines:]
        if r.returncode != 0:              # 退出码 0 时 stderr 只是提示（比如不在 systemd-journal 组），不算失败
            err = err or r.stderr.strip()
    if err:
        raise RuntimeError(err[-500:])
    return []


def read_log(target: str, *, lines: int = 200, grep: str = "", since: str = "", spill_dir: str | None = None) -> str:
    """target：文件路径（可带通配）、docker:<容器名> 或 journal:<单元>。
    grep 是正则（不分大小写）：文件在整个文件里搜（超大文件只搜末尾 512MB），docker / journal 在最后 5 万行里搜，
    都返回最后 lines 条匹配。since 对 docker / journal 有效（如 30m、2h、2026-10-21 08:00:00）。"""
    lines = max(1, min(int(lines), MAX_LINES))
    pat = None
    if grep:
        try:
            pat = re.compile(grep, re.IGNORECASE)
        except re.error as e:
            return f"[参数] grep 不是合法的正则：{e}"
    fetch = GREP_STREAM_LINES if pat else lines
    total, scanned, where = None, "", target
    try:
        if target.startswith("docker:"):
            out = _docker_logs(target[7:], fetch, since)
        elif target.startswith("journal:"):
            out = _journal(target[8:], fetch, since)
        else:
            where = resolve_file(target)
            if pat:
                out, total, scanned = _grep_file(where, pat, lines)
            else:
                out = _tail_file(where, lines)
    except FileNotFoundError:
        return f"[不存在] {target}"
    except PermissionError:
        return f"[没有权限] 平台用户读不了 {where}（请运维给平台用户加读权限，见部署指南）"
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as e:
        return f"[读取失败] {target}：{e}"
    if pat and total is None:
        out = [line for line in out if pat.search(line)]
        total = len(out)
        out = out[-lines:]
    text = "\n".join(out)
    if len(text) > MAX_CHARS:
        # 全文存进工作目录（spill_dir），模型拿到路径，用 read / grep 看前面的部分
        path = _spill(spill_dir, text) if spill_dir else None
        hint = f"全文在 {path}，用 read(path, offset=行号) 或 grep 看" if path else "要看前面的就缩小 lines 或用 grep"
        text = f"…[前面省略，只显示最后 {MAX_CHARS} 字；{hint}]\n" + text[-MAX_CHARS:]
    name = where if where == target else f"{target} → {where}"
    streamed = target.startswith(("docker:", "journal:"))
    if pat:
        scope = f"最后 {GREP_STREAM_LINES} 行" if streamed else scanned
        head = f"[{name}] {scope}里匹配 {grep!r} 的共 {total} 行" + (f"，显示最后 {len(out)} 行" if total > len(out) else "")
    else:
        head = f"[{name}] 最后 {lines} 行"
    if since and not streamed:
        head += "（since 只对 docker / journal 有效，文件日志已忽略）"
    return head + "\n" + (text or "（没有内容）")


def _spill(work: str, text: str) -> str | None:
    from ..agent.tools import outputs        # 延迟导入：本模块只用标准库，测试里单独用也不用拉起工具层
    return outputs.spill(work, "logs", text)


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


def _cap(text: str, n: int) -> str:
    rows = text.splitlines()
    return "\n".join(r[:200] for r in rows[:n]) + (f"\n…共 {len(rows)} 行" if len(rows) > n else "")


def host_status(paths: list[str] | None = None, *, containers: list[str] | None = None) -> str:
    """负载、内存、磁盘、占内存最多的进程；本服务的进程（命令行里带代码目录的）、监听端口、本用户的 crontab、
    本服务容器的资源占用；全部 docker 容器、nginx。拿不到的项跳过。paths：本服务的代码目录。"""
    paths = [p for p in (paths or []) if p]
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
    for p in ["/", *paths]:
        if not os.path.exists(p):
            continue
        st = os.statvfs(p) if hasattr(os, "statvfs") else None
        if st is None or st.f_fsid in seen:
            continue
        seen.add(st.f_fsid)
        total, free = st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize
        lines.append(f"磁盘 {p}：已用 {_gb(total - free)} / {_gb(total)}（{(total - free) * 100 // max(total, 1)}%）")
    if top := _run(["ps", "-eo", "pid,user,rss,pcpu,etime,args", "--sort=-rss"]):
        rows = top.splitlines()
        lines.append("占内存最多的进程（RSS KB）：\n" + "\n".join(r[:160] for r in rows[:11]))
        mine = [r for r in rows[1:] if any(p.rstrip("/") + "/" in r or r.endswith(p.rstrip("/")) for p in paths)
                and "bwrap" not in r]
        if paths:
            lines.append("本服务的进程（命令行里带代码目录）：\n" + (rows[0] + "\n" + "\n".join(r[:200] for r in mine[:15])
                                                  if mine else "（没有：可能跑在 docker 里，看下面的容器）"))
    if ports := _run(["ss", "-ltnp"]):            # 老版本的 ss 没有 -H（不打表头），表头留着也不碍事
        lines.append("监听端口（本用户的进程带进程名）：\n" + _cap(ports, 31))
    if cron := _run(["crontab", "-l"]):
        body = "\n".join(r for r in cron.splitlines() if r.strip() and not r.lstrip().startswith("#"))
        if body:
            lines.append("本用户的 crontab：\n" + _cap(body, 30))
    if containers and (stats := _run(["docker", "stats", "--no-stream", "--format",
                                      "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}", *containers],
                                     timeout=20, any_exit=True)):
        lines.append("本服务容器的资源（名称 / CPU / 内存 / 内存%）：\n" + stats)
    if docker := _run(["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"]):
        lines.append("docker 容器：\n" + _cap(docker, 40))
    if nginx := _run(["systemctl", "is-active", "nginx"], any_exit=True):
        lines.append(f"nginx：{nginx}")
    lines.append(f"（采集于 {time.strftime('%Y-%m-%d %H:%M:%S')}）")
    return "\n".join(lines)
