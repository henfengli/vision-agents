"""read / grep：读代码、找代码的两个只读工具（参照 Kilo Code 的 read / grep）。

- read 在平台进程里直接读，带行号、按行翻页；能读什么和 bash 沙箱一致（sandbox.invisible_reason）
- grep 在 bash 用的同一个沙箱里跑 ripgrep（没有就用 grep -r），遮蔽的配置自然搜不到

写文件仍然用 bash（工作目录可写，服务代码只读）。
"""

from __future__ import annotations

import os
import shlex
import shutil
import stat

READ_LINES = 2000            # 一次最多读多少行
READ_BYTES = 50 * 1024       # 一次最多返回多少字节
LINE_CHARS = 2000            # 单行超过这么长截断
COUNT_LINES_BELOW = 20 * 1024 * 1024    # 小于这么大的文件才数总行数
DIR_ENTRIES = 500
GREP_MATCHES = 300           # grep 最多返回多少条
GREP_PER_FILE = 50


def read_text(path: str, offset: int = 1, limit: int = READ_LINES, check=None) -> str:
    """文件：带行号的一段（`行号: 内容`）；目录：列出条目。
    check(真实路径) → 看不到的原因 | None：先打开、再按打开的那个文件的真实路径查（/proc/self/fd），
    查完和读之间路径被换成软链接也读不到别处；FIFO、设备这类不是普通文件的不读（打开不阻塞）。"""
    if os.name != "posix":                       # 开发机（Windows）：没有 /proc/self/fd，按路径查
        real = os.path.realpath(path)
        if check and (why := check(real)):
            return f"[看不到] {path}：{why}"
        if os.path.isdir(path):
            return _list_dir(path, path)
        if not os.path.exists(path):
            return f"[不存在] {path}"
        with open(path, "rb") as f:
            return _read_open(f, path, offset, limit)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except FileNotFoundError:
        return f"[不存在] {path}"
    try:
        link = f"/proc/self/fd/{fd}"
        real = os.readlink(link) if os.path.exists(link) else os.path.realpath(path)
        if check and (why := check(real)):
            return f"[看不到] {path}：{why}"
        st = os.fstat(fd)
        if stat.S_ISDIR(st.st_mode):
            return _list_dir(fd, path)
        if not stat.S_ISREG(st.st_mode):
            return f"[不是普通文件] {path}（FIFO / 设备 / socket 不读）"
        os.set_blocking(fd, True)
        f = os.fdopen(fd, "rb")
        fd = -1                                  # 交给 f 关
        with f:
            return _read_open(f, path, offset, limit)
    finally:
        if fd >= 0:
            os.close(fd)


def _lines(f, cap: int):
    """逐行读，一行只留前 cap 字节（其余读掉丢弃，单行几个 GB 也不进内存）→ (行的字节, 是否截断)。"""
    while raw := f.readline(cap):
        cut = len(raw) >= cap and not raw.endswith(b"\n")
        if cut:
            while (rest := f.readline(1 << 20)) and not rest.endswith(b"\n"):
                pass
        yield raw, cut


def _read_open(f, path: str, offset: int, limit: int) -> str:
    offset = max(1, int(offset or 1))
    limit = max(1, min(int(limit or READ_LINES), READ_LINES))
    size = os.fstat(f.fileno()).st_size
    if b"\0" in f.read(8192):
        return f"[二进制文件] {path}（{size} 字节）：用 bash 的 file / xxd / strings 看"
    f.seek(0)
    out: list[str] = []
    used, last, stopped = 0, 0, ""
    for n, (raw, cut) in enumerate(_lines(f, LINE_CHARS * 4), start=1):   # 流式：大文件只读到要的那一段
        if n < offset:
            continue
        if len(out) >= limit:
            stopped = f"到 {limit} 行"
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if cut or len(line) > LINE_CHARS:
            line = line[:LINE_CHARS] + f"…[这一行超过 {LINE_CHARS} 字，截断]"
        row = f"{n}: {line}"
        cost = len(row.encode()) + 1
        if out and used + cost > READ_BYTES:
            stopped = "到 50KB 上限"
            break
        out.append(row)
        used += cost
        last = n
    total = None
    if size <= COUNT_LINES_BELOW:
        f.seek(0)
        data = f.read()
        total = data.count(b"\n") + (0 if data.endswith(b"\n") or not data else 1)
    if not out:
        return f"[超出范围] {path} 共 {total if total is not None else '?'} 行，offset={offset} 之后没有内容"
    head = f"{path}（{'共 %d 行，' % total if total is not None else ''}第 {offset}–{last} 行）"
    more = bool(stopped) or (total is not None and last < total)
    tail = f"\n…[{stopped or '没读完'}为止；接着读用 offset={last + 1}]" if more else ""
    return head + "\n" + "\n".join(out) + tail


def _list_dir(target, path: str) -> str:
    """target：目录的路径或已打开的 fd（POSIX 上按 fd 列，不再按路径重新解析）。"""
    try:
        with os.scandir(target) as it:
            entries = sorted(it, key=lambda e: (not e.is_dir(follow_symlinks=False), e.name))
    except PermissionError:
        return f"[没有权限] {path}"
    rows = [e.name + ("/" if e.is_dir(follow_symlinks=False) else "") for e in entries[:DIR_ENTRIES]]
    more = f"\n…共 {len(entries)} 项，只列前 {DIR_ENTRIES} 项" if len(entries) > DIR_ENTRIES else ""
    return f"{path}/（目录，{len(entries)} 项）\n" + "\n".join(rows) + more


def grep_command(pattern: str, path: str, glob: str = "", ignore_case: bool = False, rg: str | None = None) -> str:
    """在沙箱里执行的命令：ripgrep（尊重 .gitignore，跳过二进制）或 grep -r，结果条数有上限。"""
    q = shlex.quote
    if rg:
        cmd = [q(rg), "-n", "--no-heading", "--color=never", "--max-columns=300", "--max-columns-preview",
               f"-m{GREP_PER_FILE}"]
        if ignore_case:
            cmd.append("-i")
        if glob:
            cmd += ["-g", q(glob)]
        cmd += ["-e", q(pattern), "--", q(path)]
    else:
        cmd = ["grep", "-rnIE", "--color=never", "--exclude-dir=.git", "--exclude-dir=node_modules",
               f"-m{GREP_PER_FILE}"]
        if ignore_case:
            cmd.append("-i")
        if glob:
            cmd.append(f"--include={q(glob)}")
        cmd += ["-e", q(pattern), "--", q(path)]
    # 多取一条判断有没有超；行太长截到 300 字（grep 没有 --max-columns）
    return " ".join(cmd) + f" 2>&1 | cut -c1-400 | head -n {GREP_MATCHES + 1}"


def find_rg(visible) -> str | None:
    """宿主上的 rg，且在沙箱里看得到（装在 home 下没挂回的不算）。"""
    rg = shutil.which("rg")
    return rg if rg and visible(rg) else None


def format_grep(output: str, pattern: str, path: str) -> str:
    """输出里混着的报错（正则写错、路径不存在）照原样给模型看。"""
    lines = [ln for ln in output.splitlines() if ln.strip()]
    if not lines:
        return f"没有匹配：{pattern!r}（在 {path}）"
    more = len(lines) > GREP_MATCHES
    lines = lines[:GREP_MATCHES]
    head = f"{pattern!r} 在 {path} 下的匹配（文件:行号:内容）" + (f"，只显示前 {GREP_MATCHES} 条：缩小 path / glob 或写更具体的正则"
                                                          if more else f"，共 {len(lines)} 条")
    return head + "\n" + "\n".join(lines)
