"""工具目录：每个工具只定义一次，两个出口——
- langchain_tools(names)：给模型的 LangChain 工具（角色白名单之内）
- host_tools(names)：同一批实现的原生 async callable，在 py 项目内核里以同名函数出现（内核 → 宿主 RPC）

所有工具从 RunScope 取"当前服务×环境"，签名里没有 service/env：
py 在本服务本环境的项目内核里执行，db_query 只能查本服务本环境登记的只读库，
logs 只能读本服务本环境声明过的日志。同机部署：执行运行的 agent 服务就装在这个服务×环境部署的主机上，
logs / host_status 看到的就是线上那台机器。代管执行（部署配置 remote_envs，RunScope.local=False）时这两个不可用：
本机上同名的日志、进程是别的环境的；py / bash / read 用本机的代码目录（当参考），配置用只读版。

工具集刻意收敛：读写文件用 bash（工作目录可写，服务代码只读），编排多个工具用 py（内核里直接调），
不另设文件工具和代码编排工具。
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ... import credentials
from ...config import Settings
from ...domain import Rejected
from ...notify import Message, Notifier
from ...services import envspec, hostlocal
from ...services import inspect as svc_inspect
from ...services.kernel import KernelError, KernelManager, kernel_key
from ...store import assets as assets_store
from .. import scope as run_scope
from . import bash as bash_mod
from . import db as db_mod
from . import files as files_mod
from . import outputs
from .progress import Progress
from .sandbox import invisible_reason, work_dir

log = logging.getLogger(__name__)

ASSET_KINDS = ("procedure", "script", "query", "baseline")
ALIASES = {"sql_query": "db_query", "read_file": "read"}       # 旧角色定义里的写法

Fn = Callable[..., Awaitable[str]]


TODO_STATUS = ("pending", "in_progress", "completed", "cancelled")


def executor_label(s: Settings) -> str:
    """代管时执行运行的主机：「<主机名>（test 的部署主机）」。"""
    import socket
    return f"{socket.gethostname()}（{s.env} 的部署主机）" if s.env else socket.gethostname()


def remote_unavailable(sc: run_scope.RunScope, what: str) -> str:
    """代管执行（部署配置 remote_envs）：本机不是这个环境的部署主机，本机上的同名日志、进程是别的环境的，不能拿来用。"""
    return (f"[不可用] 这次是代管执行：本机不是 {sc.env} 的部署主机，看不到 {sc.env} 主机上的{what}；"
            f"本机上同名的是别的环境的，不能当成 {sc.env} 的。"
            f"{sc.env} 的运行记录和日志用服务工具（MCP，如 dagster 的 get_run_logs）查，页面用浏览器工具（有的话）看，"
            "数据用 db_query / py 查；确实需要主机上的信息就在结论里写明缺这一项")


def _work_dir(s: Settings, sc: run_scope.RunScope) -> str:
    """本会话×服务×环境的工作目录（和项目内核的 $SCRATCH 是同一个）。"""
    return work_dir(s.scratch_dir, kernel_key(sc.session_id, sc.service or "-", sc.env))


def _resolve(s: Settings, sc: run_scope.RunScope, path: str) -> str:
    """read / grep 的路径：~ 展开；相对路径按本服务的代码目录（平台任务按工作目录）。"""
    p = os.path.expanduser(path.strip()) if path.strip() else ""
    if p and os.path.isabs(p):
        return os.path.normpath(p)
    base = (sc.view.root if sc.view and sc.view.root else "") or _work_dir(s, sc)
    return os.path.normpath(os.path.join(base, p)) if p else base


@dataclass(frozen=True)
class ToolInfo:
    name: str
    title: str
    description: str
    group: str            # core / service / memory / notify / mcp
    dangerous: bool = False

    def dump(self) -> dict:
        return {"name": self.name, "title": self.title, "description": self.description,
                "group": self.group, "dangerous": self.dangerous}


class Toolbox:
    def __init__(self, settings: Settings, notifier: Notifier | None, registry: Any = None,
                 mcp_tools: list | None = None, kernels: KernelManager | None = None):
        self._s = settings
        self._reg = registry
        self._notifier = notifier
        self._kernels = kernels
        self._mcp = {t.name: t for t in (mcp_tools or [])}
        self._fns: dict[str, Fn] = {}
        self._info: dict[str, ToolInfo] = {}
        self._register()

    # —— 目录 ——

    def _add(self, fn: Fn, title: str, group: str, dangerous: bool = False, summary: str = "") -> None:
        @functools.wraps(fn)
        async def guarded(*args: Any, **kwargs: Any) -> str:
            # 工具里没料到的异常不能炸掉整次运行：如实告诉模型，让它换个做法
            try:
                return await fn(*args, **kwargs)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.exception("工具 %s 出错", fn.__name__)
                return f"[工具出错] {fn.__name__}：{type(e).__name__}: {str(e)[:500]}"

        self._fns[fn.__name__] = guarded
        doc = (fn.__doc__ or "").strip().splitlines()
        self._info[fn.__name__] = ToolInfo(fn.__name__, title, summary or (doc[0] if doc else ""), group, dangerous)

    def info(self) -> list[dict]:
        out = [i.dump() for i in self._info.values()]
        out += [{**ToolInfo(n, n, (t.description or "").split("\n")[0][:120], "mcp").dump(),
                 "server": (t.metadata or {}).get("mcp_server")} for n, t in self._mcp.items()]
        return out

    @property
    def names(self) -> set[str]:
        return set(self._fns) | set(self._mcp)

    def mcp_servers(self) -> list[str]:
        return sorted({(t.metadata or {}).get("mcp_server") or "" for t in self._mcp.values()} - {""})

    def expand(self, names: list[str] | tuple[str, ...]) -> list[str]:
        """角色里的工具写法 → 具体工具名："*" = 全部内置 + 全部平台 MCP；"mcp:<server>" = 该 server 的全部工具。
        自动带上的：有 bash 的角色带 read / grep（只读，是 bash 能力的子集）；todo 人人都有（没有副作用）。
        这样库里已有的角色定义不用改就能用上。"""
        out: list[str] = []
        for n in names:
            if n == "*":
                items = [*self._fns, *self._mcp]
            elif n.startswith("mcp:"):
                items = [k for k, t in self._mcp.items() if (t.metadata or {}).get("mcp_server") == n[4:]]
            else:
                items = [ALIASES.get(n, n)]
            out += [x for x in items if x not in out]
        implied = (["read", "grep"] if "bash" in out else []) + ["todo"]
        return out + [x for x in implied if x in self._fns and x not in out]

    def unknown(self, names: list[str]) -> list[str]:
        servers = set(self.mcp_servers())
        return [n for n in names if ALIASES.get(n, n) not in self.names and n != "*"
                and not (n.startswith("mcp:") and n[4:] in servers)]

    def langchain_tools(self, names: list[str], extra: list | None = None) -> list:
        """角色白名单里的工具，加上 extra（运行所在服务的 MCP 工具；和白名单重名的以白名单为准）。
        未登记的名字（比如旧定义里的 run_code、read_file）忽略。"""
        from langchain_core.tools import tool

        out = []
        for n in self.expand(names):
            if n in self._fns:
                out.append(tool(self._fns[n]))
            elif n in self._mcp:
                out.append(self._mcp[n])
        taken = {t.name for t in out}
        return out + [t for t in (extra or []) if t.name not in taken]

    def host_tools(self, names: list[str] | tuple[str, ...], extra: list | tuple = ()) -> dict[str, Fn]:
        """内核里可调用的平台工具：角色白名单（py 自己除外）+ 运行所在服务的 MCP 工具。"""
        names = self.expand(names)
        out: dict[str, Fn] = {n: self._fns[n] for n in names if n in self._fns and n not in ("py", "todo")}
        out.update({n: self._mcp[n].coroutine for n in names if n in self._mcp})   # MCP 工具按关键字参数调用
        out.update({t.name: t.coroutine for t in extra if t.name not in out and t.coroutine is not None})
        return out

    # —— 实现 ——

    def _register(self) -> None:
        s, reg, toolbox, kernels = self._s, self._reg, self, self._kernels

        async def py(code: str, timeout: int = 120, restart: bool = False) -> str:
            """在本服务本环境的项目 Python 里执行代码（项目内核）：解释器、工作目录是执行主机上的那份（同机部署就是线上的；
            代管执行时是执行主机上部署的那份，见 [运行环境]），配置已就位（生产是给 agent 的只读版，测试是项目的真实配置；
            库都只能查不能改），可以直接 import
            项目模块、调用项目自己的函数和数据访问层（口径函数、ORM、dagster 资产……），用项目的方式连库。
            变量在本会话内保留，最后一个表达式的值会显示。
            你的其他工具在这里是同名函数（如 db_query("select …")、service_info(what="config")，返回文本），
            要循环 / 批量调工具时写进一段代码，只把 print 的结论带回来。db_query 的大结果在文件里，用 pandas 读它。
            沉淀过的脚本类方法所在目录已在 sys.path 上，可以直接 import。
            文件系统只读，要写文件写到 $SCRATCH（与 bash 共用的工作目录）或 /tmp；内存有上限。服务声明的日志文件在内核里
            是空的（项目写进去的直接丢掉），看日志用 logs。restart=true 清空变量重新开始。
            输出超过 20000 字时全文存进工作目录的 outputs/，返回里有路径。同一会话的 py 调用是排队执行的。"""
            sc = run_scope.current()
            if kernels is None or reg is None or sc.view is None:
                return "[不可用] 本运行没有关联业务服务，没有项目内核"
            key = kernel_key(sc.session_id, sc.service, sc.env)
            prog = Progress(sc.run_id, "py", code.strip().splitlines()[0] if code.strip() else "")
            try:
                spec = await envspec.runtime_spec(reg, s, sc.service, sc.env)
                if restart or not kernels.alive(key, spec["digest"]):
                    # 文件类方法（沉淀的脚本）的目录放上 sys.path：内核里直接 import，不用复制一遍
                    methods = await assets_store.search_active(sc.env, sc.service, sc.task.split(":")[0], limit=20,
                                                               exclude_run=sc.replay_of)
                    spec["method_paths"] = [m["path"] for m in methods if m.get("path")]
                return await kernels.execute(key, spec, code, timeout=max(1, min(timeout, 1800)), hidden=sc.hidden,
                                             restart=restart, tools=toolbox.host_tools(sc.tools, sc.extra_tools),
                                             progress=prog.update)
            except (Rejected, KernelError) as e:
                return f"[失败] {getattr(e, 'message', None) or e}"
            finally:
                await asyncio.shield(prog.done())

        async def bash(command: str, timeout: int = 60) -> str:
            """在沙箱里执行 shell 命令：全盘只读（可读服务代码；home 下其他目录、平台密钥看不到；生产环境的配置文件
            也看不到，配置用 service_info 读）、只有工作目录和 /tmp 可写、调用结束后台进程全灭、内存有上限；网络照常。
            当前目录是本会话的工作目录（$SCRATCH，和 py 共用，跨调用保留）；每次调用是新的 shell，cd、export 不会带到
            下一次，要连着做的写进同一条命令（&&）。PATH 最前面是本服务的项目解释器所在目录：python / pip / pytest
            用的是项目的环境。读代码、找代码用 read / grep，不要 cat 整个文件。
            stdout 和 stderr 合在一起，超过 12000 字只留开头和结尾，全文存进工作目录的 outputs/，返回里有路径。"""
            sc = run_scope.current()
            work = _work_dir(s, sc)
            env = bash_mod.build_safe_env()
            env["SCRATCH"] = work
            if sc.view is not None:
                env.update(sc.view.env_vars)
                if os.path.isabs(sc.view.python):
                    env["PATH"] = os.path.dirname(sc.view.python) + os.pathsep + env.get("PATH", "/usr/bin:/bin")
            stop = threading.Event()
            prog = Progress(sc.run_id, "bash", command)
            try:
                r = await asyncio.to_thread(
                    bash_mod.run_command, command, max(1, min(timeout, 600)), s.scratch_dir,
                    hidden=sc.hidden, allow=sc.allow, limits=s.limits, require_sandbox=s.require_sandbox, env=env,
                    workdir=work, stop=stop, on_progress=prog.push, spill_path=outputs.new_path(work, "bash"))
            except asyncio.CancelledError:
                stop.set()                     # 线程里的等待循环看到后杀掉进程（不然命令会一直跑到它自己的超时）
                raise
            finally:
                await asyncio.shield(prog.done())
            return bash_mod.format_result(r)

        async def read(path: str, offset: int = 1, limit: int = 2000) -> str:
            """读文件（每行带行号 `行号: 内容`）或列目录。path：绝对路径，或相对本服务代码目录的路径。
            一次最多 2000 行 / 50KB，单行超过 2000 字截断；没读完时末尾会告诉你下一段的 offset。
            大文件先用 grep 找到行号，再用 offset 读那一段；不要一小段一小段地读（一次读够上下文）。
            能读什么和 bash 一样：遮蔽的配置、home 下没挂回的目录读不到。"""
            sc = run_scope.current()
            full = _resolve(s, sc, path)

            def hidden_why(p: str) -> str | None:
                return invisible_reason(p, hidden=sc.hidden, allow=sc.allow, scratch=s.scratch_dir)

            if why := hidden_why(full):
                return f"[看不到] {full}：{why}"
            try:      # 打开之后按打开的那个文件再查一次：查和读之间路径被换成软链接也读不到别处
                return await asyncio.to_thread(files_mod.read_text, full, offset, limit, hidden_why)
            except PermissionError:
                return f"[没有权限] 平台用户读不了 {full}"
            except OSError as e:
                return f"[读取失败] {full}：{e}"

        async def grep(pattern: str, path: str = "", glob: str = "", ignore_case: bool = False) -> str:
            """在代码里按正则搜（ripgrep 语法；没装 rg 时用 grep -E）：返回 `文件:行号:内容`，最多 300 条、每个文件最多 50 条。
            path：目录或文件（绝对路径，或相对本服务代码目录），不填 = 本服务代码目录。glob：只搜这些文件，如 "*.py"。
            跳过 .gitignore 里的、二进制文件。遮蔽的配置搜不到。找到位置后用 read(path, offset) 看上下文。"""
            sc = run_scope.current()
            full = _resolve(s, sc, path or ((sc.view.root if sc.view else "") or _work_dir(s, sc)))
            if why := invisible_reason(full, hidden=sc.hidden, allow=sc.allow, scratch=s.scratch_dir):
                return f"[看不到] {full}：{why}"
            rg = files_mod.find_rg(lambda p: invisible_reason(p, hidden=sc.hidden, allow=sc.allow,
                                                               scratch=s.scratch_dir) is None)
            cmd = files_mod.grep_command(pattern, full, glob, ignore_case, rg)
            stop = threading.Event()
            try:
                r = await asyncio.to_thread(
                    bash_mod.run_command, cmd, 60, s.scratch_dir, hidden=sc.hidden, allow=sc.allow, limits=s.limits,
                    require_sandbox=s.require_sandbox, workdir=_work_dir(s, sc), stop=stop)
            except asyncio.CancelledError:
                stop.set()
                raise
            if r.exit_code in (124, 126, 130):
                return bash_mod.format_result(r)
            return files_mod.format_grep(r.output, pattern, full)

        async def todo(items: list[dict]) -> str:
            """维护这次运行的待办清单（整份替换），运行详情里会显示给人看。
            items：[{"content": "做什么", "status": "pending|in_progress|completed|cancelled"}]。
            3 步以上的任务先列出来；开始做一项就把它标成 in_progress（同时只有一项），做完马上标 completed，
            发现新的事加进去。一两步就能做完的事不用列。"""
            bad = [i for i in items if not isinstance(i, dict) or not str(i.get("content", "")).strip()
                   or i.get("status", "pending") not in TODO_STATUS]
            if bad:
                return f"[参数] 每项要有 content，status 只能是 {'/'.join(TODO_STATUS)}"
            marks = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]", "cancelled": "[-]"}
            done = sum(1 for i in items if i.get("status") == "completed")
            body = "\n".join(f"{marks[i.get('status', 'pending')]} {i['content']}" for i in items)
            return f"待办已更新（完成 {done}/{len(items)}）：\n{body}"

        async def service_info(what: str = "overview", path: str = "") -> str:
            """查看本次运行所在服务×环境。what：overview（目录 / 配置文件 / 日志总览）、
            config（读本环境的一份配置，path 填配置文件路径，密钥已打码；生产是给 agent 的只读版，测试是真实配置）、
            git（代码目录最近提交）。"""
            sc = run_scope.current()
            if sc.view is None:
                return "[无服务] 本任务是平台任务，不关联业务服务"
            v = sc.view
            if what == "config":
                try:
                    return await svc_inspect.read_config(v, path or (v.config_files[0]["path"] if v.config_files else ""),
                                                         protected=sc.protected)
                except Rejected as e:
                    return f"[失败] {e.message}"
            remote = "" if sc.local else f"（执行主机上的那份，不是 {sc.env} 部署的版本）"
            if what == "git":
                return "\n\n".join(f"## {p}{remote}\n{svc_inspect.git_log(p)}" for p in v.code_paths) or "（未配置代码目录）"
            lines = [v.prompt_block(sc.protected) if sc.local else v.prompt_block(sc.protected, executor=executor_label(s))]
            git = svc_inspect.git_state(v.root) if v.root else None
            if git:
                lines.append(f"- 代码目录当前提交 {git['commit']}（{git['branch']}，{git['committed_at']}）"
                             + ("，有未提交的改动" if git["dirty"] else "") + remote)
            if sc.protected:
                for c in await svc_inspect.config_status(v):
                    lines.append(f"- 配置 {c['path']}：" + (f"给 agent 的只读版第 {c['version']} 版" if c["version"]
                                                             else "还没有填给 agent 的只读版（py 起不来）"))
            else:
                lines += [f"- 配置 {c['path']}：项目的真实配置" + ("" if os.path.exists(c["path"]) else "（本机上不存在）")
                          for c in v.config_files]
            return "\n".join(lines)

        async def logs(name: str = "", lines: int = 200, grep: str = "", since: str = "") -> str:
            """读本服务本环境线上的日志（服务定义里声明过的：应用日志、nginx、docker 容器、systemd 单元）。代管执行时不可用。
            name 不填列出有哪些。lines：最多返回多少行（最多 2000）。grep：正则（不分大小写）——文件日志在整个文件里搜
            （超大的只搜末尾 512MB），docker / systemd 在最后 5 万行里搜，返回最后 lines 条匹配和匹配总数。
            since：只对 docker / systemd 有效，如 30m、2h、"2026-10-21 08:00:00"。看报错先 grep error|exception|traceback。"""
            sc = run_scope.current()
            if not sc.local:
                return remote_unavailable(sc, "日志")
            available = sc.view.logs if sc.view else {}
            if not available:
                return f"[未配置] 服务 {sc.service or '—'} 在 {sc.env} 没有声明日志（服务定义 → logs）"
            if not name:
                return "可读的日志：\n" + "\n".join(f"- {k}：{t}" for k, t in available.items())
            if name not in available:
                return f"[参数] name 须为 {'、'.join(available)} 之一"
            return await asyncio.to_thread(hostlocal.read_log, available[name], lines=lines, grep=grep, since=since,
                                           spill_dir=_work_dir(s, sc))

        async def host_status() -> str:
            """本服务本环境部署主机（就是你所在的这台）的现状：负载、内存、磁盘、占内存最多的进程；本服务的进程、
            监听端口、本用户的 crontab、本服务容器的 CPU / 内存；全部 docker 容器、nginx。代管执行时不可用。"""
            sc = run_scope.current()
            if not sc.local:
                return remote_unavailable(sc, "主机状况（负载、内存、磁盘、进程、端口、crontab、容器、nginx）")
            v = sc.view
            paths = list(dict.fromkeys(p for p in ([v.root, *v.code_paths] if v else []) if p))
            containers = [t[7:] for t in (v.logs.values() if v else []) if t.startswith("docker:")]
            return await asyncio.to_thread(hostlocal.host_status, paths, containers=containers)

        async def db_query(query: str, db: str = "") -> str:
            """查本服务本环境登记的只读库（库名与类型见 [运行环境]）。query：一条 SQL（PostgreSQL / MySQL / MariaDB /
            Doris / ClickHouse，用该库自己的方言）；MongoDB 写 JSON：{"collection": "c", "filter": {...}, "sort": {...},
            "limit": 100}、{"collection": "c", "pipeline": [...]}、{"collection": "c", "count": {...}}、{"collections": true}。
            db：库名，只登记了一个库时可省略。只读、单条语句、限时 30 秒。
            结果超过 20 行时全部写进工作目录下的文件（CSV / JSONL），这里只返回行数、列与前 20 行；
            要细看就用 bash（head / grep / awk）或 py（pandas.read_csv）读那个文件，别把整份打印出来。
            看表结构：PG 查 information_schema，MySQL / Doris / ClickHouse 用 SHOW TABLES / DESCRIBE 表名。"""
            sc = run_scope.current()
            dbs = sc.view.databases if sc.view else {}
            if not dbs:
                return f"[未配置] 服务 {sc.service or '—'} 在 {sc.env} 没有登记只读库"
            name = db or (next(iter(dbs)) if len(dbs) == 1 else "")
            if name not in dbs:
                return f"[参数] db 须为 {'、'.join(dbs)} 之一"
            try:
                url = credentials.expand(dbs[name])
            except credentials.MissingSecret as e:
                return f"[未配置] 库 {name} 的口令取不到：{e}"
            # 结果文件放在本会话工作目录下：bash / py 里按相对路径就能读，save_asset 也能收编
            out_dir = os.path.join(_work_dir(s, sc), "queries", sc.run_id)
            return await db_mod.run_query(name, url, query, out_dir)

        async def save_asset(name: str, kind: str, summary: str, content: str = "",
                             files: list[str] | None = None, task_specific: bool = True) -> str:
            """沉淀可复用的方法，之后同任务（或同服务）的运行会自动召回。
            kind：procedure（方法/SOP）| script（脚本）| query（查询）| baseline（基线数据）。
            name 在同类里唯一，重复保存即整体更新（旧版留档）；summary 一句话写清何时用（召回靠它）。
            content 是正文；脚本等文件先写进工作目录并跑通，再用 files（相对路径列表）收编，
            files 相对工作目录（$SCRATCH）；.py 收编前会做编译检查。task_specific=false 表示服务级通用方法。"""
            sc = run_scope.current()
            if sc.replay_of:
                return "[回归重放] 这是对比用的重跑，不沉淀方法（记忆保持不变），直接给出结论即可"
            if kind not in ASSET_KINDS:
                return f"[失败] kind 须为 {'/'.join(ASSET_KINDS)}"
            if not name.strip() or not summary.strip():
                return "[失败] name 与 summary 不能为空"
            if not content.strip() and not files:
                return "[失败] content 与 files 至少给一样"
            if not sc.service:
                return "[失败] 平台任务没有服务归属，不能沉淀方法"
            task = sc.task.split(":")[0] if task_specific else ""
            path = None
            n_files = n_bytes = 0
            if files:
                work = _work_dir(s, sc)          # 相对路径按本会话的工作目录解析
                errors = await asyncio.to_thread(assets_store.python_lint_errors, work, files)
                if errors:
                    return "[失败] 编译检查未通过，修好后再收编：\n" + "\n".join(errors[:10])
                try:
                    path, n_files, n_bytes = await asyncio.to_thread(
                        assets_store.collect_files, s.assets_dir, sc.env, sc.service, task, kind,
                        name.strip(), files, work)
                except ValueError as e:
                    return f"[失败] {e}"
            await assets_store.upsert(sc.env, sc.service, task, kind, name.strip(), summary.strip(), content,
                                      source_run=sc.run_id, path=path)
            where = f"{sc.service}/{task}" if task else f"{sc.service}（服务通用）"
            if path:
                return f"已沉淀 {kind}:{name}（{where}，{n_files} 个文件 {n_bytes // 1024}KB）→ {path}"
            return f"已沉淀 {kind}:{name}（{where}），后续运行会自动召回"

        async def notify(title: str, content: str) -> str:
            """发一条 markdown 通知到本任务的通知渠道（任务投递渠道，未配置则用名为 default 的渠道）。"""
            sc = run_scope.current()
            if sc.replay_of:
                return "[回归重放] 这是对比用的重跑，不发通知；要通知的内容写进最终回答"
            channel = sc.notify_channel or "default"
            body = f"{content}\n\n> {sc.service or '平台'} · {sc.env} · 运行 {sc.run_id}"
            try:
                await toolbox._notifier.send(channel, Message(title=title, text=body,
                                                              link=toolbox._notifier.link(f"/runs/{sc.run_id}")))
            except Rejected as e:
                return f"[失败] {e.message}"
            except Exception as e:  # noqa: BLE001
                return f"[失败] 发送出错：{type(e).__name__}: {str(e)[:200]}"
            return f"已发送到渠道 {channel}"

        if kernels is not None and reg is not None:
            self._add(py, "项目内核", "service", dangerous=True,
                      summary="在线上的代码目录和解释器里执行代码（生产的配置换成只读版，测试用真实配置）：import 项目模块、调项目函数，变量会话内保留")
        self._add(bash, "Shell", "core", dangerous=True, summary="bwrap 沙箱：全盘只读、home 只露代码目录、工作目录和 /tmp 可写、调用结束进程全灭")
        self._add(read, "读文件", "core", summary="带行号读文件、按 offset 翻页，或列目录；能读什么和 bash 一样")
        self._add(grep, "搜代码", "core", summary="在代码里按正则搜（ripgrep），返回 文件:行号:内容；在 bash 的沙箱里跑")
        self._add(todo, "待办", "core", summary="多步任务的待办清单，运行详情里显示给人看")
        self._add(service_info, "服务信息", "service", summary="本运行服务×环境的目录、配置内容（打码）、git 状态")
        self._add(logs, "看日志", "service",
                  summary="读本服务本环境线上的日志（文件 / docker 容器 / systemd 单元），按行数取尾部或在整个文件里按正则搜")
        self._add(host_status, "主机状况", "service",
                  summary="部署主机的负载、内存、磁盘、大进程；本服务的进程、监听端口、crontab、容器资源；nginx")
        self._add(db_query, "只读查库", "service",
                  summary="本服务本环境登记的只读库：PostgreSQL / MySQL / MariaDB / Doris / ClickHouse / MongoDB；大结果写文件")
        self._add(save_asset, "沉淀方法", "memory", summary="把可复用的方法/脚本/查询/基线存入记忆")
        self._add(notify, "发通知", "notify", summary="发 markdown 通知到任务的通知渠道")
