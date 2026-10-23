"""工具目录：每个工具只定义一次，两个出口——
- langchain_tools(names)：给模型的 LangChain 工具（角色白名单之内）
- host_tools(names)：同一批实现的原生 async callable，在 py 项目内核里以同名函数出现（内核 → 宿主 RPC）

所有工具从 RunScope 取"当前服务×环境"，签名里没有 service/env：
py 在本服务本环境的项目内核里执行，db_query 只能查本服务本环境登记的只读库，
service_ctl 只能启停本服务本环境声明过的进程。

工具集刻意收敛：读写文件用 bash（工作目录可写，服务代码只读），编排多个工具用 py（内核里直接调），
不另设文件工具和代码编排工具。
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ... import credentials
from ...config import Settings
from ...domain import Rejected
from ...notify import Message, Notifier
from ...services import inspect as svc_inspect
from ...services.kernel import KernelError, KernelManager, kernel_key
from ...store import assets as assets_store
from .. import scope as run_scope
from . import bash as bash_mod
from . import db as db_mod
from . import hostinfo

log = logging.getLogger(__name__)

ASSET_KINDS = ("procedure", "script", "query", "baseline")
ALIASES = {"sql_query": "db_query"}       # 旧角色定义里的写法

Fn = Callable[..., Awaitable[str]]


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
    def __init__(self, settings: Settings, notifier: Notifier | None, controller: Any = None,
                 mcp_tools: list | None = None, kernels: KernelManager | None = None):
        self._s = settings
        self._ctl = controller
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
        """角色里的工具写法 → 具体工具名："*" = 全部内置 + 全部平台 MCP；"mcp:<server>" = 该 server 的全部工具。"""
        out: list[str] = []
        for n in names:
            if n == "*":
                items = [*self._fns, *self._mcp]
            elif n.startswith("mcp:"):
                items = [k for k, t in self._mcp.items() if (t.metadata or {}).get("mcp_server") == n[4:]]
            else:
                items = [ALIASES.get(n, n)]
            out += [x for x in items if x not in out]
        return out

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
        out: dict[str, Fn] = {n: self._fns[n] for n in names if n in self._fns and n != "py"}
        out.update({n: self._mcp[n].coroutine for n in names if n in self._mcp})   # MCP 工具按关键字参数调用
        out.update({t.name: t.coroutine for t in extra if t.name not in out and t.coroutine is not None})
        return out

    # —— 实现 ——

    def _register(self) -> None:
        s, ctl, toolbox, kernels = self._s, self._ctl, self, self._kernels

        async def py(code: str, timeout: int = 120, restart: bool = False) -> str:
            """在本服务本环境的项目 Python 里执行代码（项目内核）：解释器是该环境的，工作目录是部署目录，
            本环境的配置文件已在项目读的路径上，可以直接 import 项目模块、调用项目自己的函数和数据访问层
            （口径函数、ORM、dagster 资产……），用项目的方式连只读库。变量在本会话内保留，最后一个表达式的值会显示。
            你的其他工具在这里是同名函数（如 db_query("select …")、service_info(what="config")，返回文本），
            要循环 / 批量调工具时写进一段代码，只把 print 的结论带回来。db_query 的大结果在文件里，用 pandas 读它。
            沉淀过的脚本类方法所在目录已在 sys.path 上，可以直接 import。
            文件系统只读，要写文件写到 $SCRATCH（与 bash 共用的工作目录）。restart=true 清空变量重新开始。"""
            sc = run_scope.current()
            if kernels is None or ctl is None or sc.view is None:
                return "[不可用] 本运行没有关联业务服务，没有项目内核"
            key = kernel_key(sc.session_id, sc.service, sc.env)
            try:
                spec = await ctl.runtime_spec(sc.service, sc.env)
                if restart or not kernels.alive(key):
                    # 文件类方法（沉淀的脚本）的目录放上 sys.path：内核里直接 import，不用复制一遍
                    methods = await assets_store.search_active(sc.env, sc.service, sc.task.split(":")[0], limit=20)
                    spec["method_paths"] = [m["path"] for m in methods if m.get("path")]
                return await kernels.execute(key, spec, code, timeout=max(1, min(timeout, 1800)), hidden=sc.hidden,
                                             restart=restart, tools=toolbox.host_tools(sc.tools, sc.extra_tools))
            except (Rejected, KernelError) as e:
                return f"[失败] {getattr(e, 'message', None) or e}"

        async def bash(command: str, timeout: int = 60, network: bool = False) -> str:
            """在沙箱里执行 shell 命令：全盘只读（可读服务代码；配置文件与密钥被遮蔽，配置用 service_info 读）、
            只有工作目录可写、调用结束后台进程全灭。默认断网；需要访问本机服务端口或内网接口时传 network=true。
            输出超过 8000 字会截断：大输出先写进文件，再 head / grep 着看。"""
            sc = run_scope.current()
            r = await asyncio.to_thread(bash_mod.run_command, command, max(1, min(timeout, 600)),
                                        s.scratch_dir, None, network, sc.hidden)
            return bash_mod.format_result(r)

        async def service_info(what: str = "overview", path: str = "") -> str:
            """查看本次运行所在服务×环境。what：overview（目录/配置文件/进程总览）、
            config（读本环境的一个配置文件，path 填文件路径，密钥已打码）、git（代码目录最近提交）。"""
            sc = run_scope.current()
            if sc.view is None:
                return "[无服务] 本任务是平台任务，不关联业务服务"
            v = sc.view
            if what == "config":
                try:
                    return svc_inspect.read_config(v, path or (v.config_files[0]["path"] if v.config_files else ""))
                except Rejected as e:
                    return f"[失败] {e.message}"
            if what == "git":
                return "\n\n".join(f"## {p}\n{svc_inspect.git_log(p)}" for p in v.code_paths) or "（未配置代码目录）"
            lines = [v.prompt_block()]
            for c in svc_inspect.config_files(v):
                lines.append(f"- 配置 {c['path']} → {c['canonical']}：{'存在' if c['exists'] else '缺失'}"
                             + (f"，{c['size']} 字节" if c['size'] is not None else ""))
            if ctl is not None and v.processes:
                for inst in await ctl.list(v.service):
                    if inst["env"] == v.env:
                        lines.append(f"- 进程 {inst['process']}：{inst['state']}"
                                     + (f"，端口 {inst['port']}" if inst["port"] else "")
                                     + (f"，租约到 {inst['lease_until']}" if inst["lease_until"] else ""))
            return "\n".join(lines)

        async def service_ctl(action: str, process: str = "", lines: int = 100) -> str:
            """启停本服务在本环境的进程（本机副本，用该环境的配置起）。action：status / start / stop / restart / logs。
            process 为进程名（只有一个进程时可省略）。只是跑一段项目代码用 py，需要长驻（起 webserver 看页面、
            让别的工具连它）才起进程。启动带租约，到期自动停止。"""
            sc = run_scope.current()
            if ctl is None or sc.view is None:
                return "[不可用] 本运行没有可操作的服务进程"
            procs = list(sc.view.processes)
            if not procs:
                return f"[无进程] 服务 {sc.service} 没有声明可启停的进程"
            process = process or (procs[0] if len(procs) == 1 else "")
            if process not in procs:
                return f"[参数] process 须为 {'、'.join(procs)} 之一"
            try:
                if action == "status":
                    i = await ctl.get(sc.service, sc.env, process)
                    return json.dumps(i, ensure_ascii=False)
                if action == "logs":
                    return "\n".join(await ctl.logs(sc.service, sc.env, process, lines)) or "（无日志）"
                if action not in ("start", "stop", "restart"):
                    return "[参数] action 须为 status/start/stop/restart/logs"
                if action in ("start", "restart"):
                    await ctl.ensure_startable(sc.service, sc.env)
                by = f"run:{sc.run_id}"
                if action in ("stop", "restart"):
                    await ctl.stop(sc.service, sc.env, process, by=by)
                if action in ("start", "restart"):
                    await ctl.start(sc.service, sc.env, process, by=by)
                i = await ctl.get(sc.service, sc.env, process)
                return f"{action} 完成：{i['state']}" + (f"，端口 {i['port']}" if i["port"] else "") \
                    + (f"，租约到 {i['lease_until']}" if i["lease_until"] else "")
            except Rejected as e:
                return f"[失败] {e.message}"

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
            out_dir = os.path.join(s.scratch_dir, "queries", sc.run_id)
            return await db_mod.run_query(name, url, query, out_dir)

        async def host_metrics() -> str:
            """本服务本环境部署主机的实时资源：内存使用率、系统负载、根盘使用率（Grafana / node_exporter）。"""
            sc = run_scope.current()
            if s.grafana is None:
                return "[未配置] 平台未接入 Grafana"
            hosts = sc.view.hosts if sc.view else []
            if not hosts:
                return f"[无数据] 服务 {sc.service or '—'} 在 {sc.env} 没有登记主机"
            g = s.grafana

            async def fetch(expr: str) -> dict[str, float]:
                return await hostinfo.grafana_query(g.url, g.datasource_uid, g.token, expr)
            try:
                return await hostinfo.collect(fetch, hosts)
            except Exception as e:  # noqa: BLE001 —— 监控故障如实返回，不炸运行
                return f"[监控不可用] {type(e).__name__}: {str(e)[:300]}"

        async def save_asset(name: str, kind: str, summary: str, content: str = "",
                             files: list[str] | None = None, task_specific: bool = True) -> str:
            """沉淀可复用的方法，之后同任务（或同服务）的运行会自动召回。
            kind：procedure（方法/SOP）| script（脚本）| query（查询）| baseline（基线数据）。
            name 在同类里唯一，重复保存即整体更新（旧版留档）；summary 一句话写清何时用（召回靠它）。
            content 是正文；脚本等文件先写进工作目录并跑通，再用 files（相对路径列表）收编，
            .py 收编前会做编译检查。task_specific=false 表示服务级通用方法。"""
            sc = run_scope.current()
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
                errors = await asyncio.to_thread(assets_store.python_lint_errors, s.scratch_dir, files)
                if errors:
                    return "[失败] 编译检查未通过，修好后再收编：\n" + "\n".join(errors[:10])
                try:
                    path, n_files, n_bytes = await asyncio.to_thread(
                        assets_store.collect_files, s.assets_dir, sc.env, sc.service, task, kind,
                        name.strip(), files, s.scratch_dir)
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

        if kernels is not None and ctl is not None:
            self._add(py, "项目内核", "service",
                      summary="在本服务本环境的项目 Python 里执行代码：import 项目模块、调项目函数、直接调其他工具，变量会话内保留")
        self._add(bash, "Shell", "core", dangerous=True, summary="bwrap 沙箱：全盘只读、工作目录可写、默认断网；读写文件也用它")
        self._add(service_info, "服务信息", "service", summary="本运行服务×环境的目录、配置文件内容、git 状态")
        if ctl is not None and ctl.backend != "off":
            self._add(service_ctl, "进程启停", "service", dangerous=True, summary="启停本服务本环境声明过的进程（带租约）")
        self._add(db_query, "只读查库", "service",
                  summary="本服务本环境登记的只读库：PostgreSQL / MySQL / MariaDB / Doris / ClickHouse / MongoDB；大结果写文件")
        if s.grafana is not None:
            self._add(host_metrics, "主机指标", "service", summary="部署主机内存/负载/根盘（Grafana）")
        self._add(save_asset, "沉淀方法", "memory", summary="把可复用的方法/脚本/查询/基线存入记忆")
        self._add(notify, "发通知", "notify", summary="发 markdown 通知到任务的通知渠道")
