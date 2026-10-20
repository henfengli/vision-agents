"""工具目录：每个工具只定义一次，两个出口——
- langchain_tools(names)：给模型的 LangChain 工具（角色白名单之内）
- host_tools(names)：给 run_code 桩函数的原生 async callable（同一实现）

所有工具从 RunScope 取"当前服务×环境"，签名里没有 service/env：
sql_query 只能查本服务本环境的只读库，service_ctl 只能启停本服务本环境的进程。
危险操作（bash/run_code/service_ctl）统一过 Gatekeeper。

deepagents 的文件工具（read_file/write_file/edit_file/ls/grep/glob）由框架中间件注入，
根目录是 scratch（与 bash 的工作目录同一块），不在本目录里登记、不受白名单控制。
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ...config import Settings
from ...domain import Rejected
from ...notify import Message, Notifier
from ...services import inspect as svc_inspect
from ...store import artifacts as artifacts_store
from ...store import assets as assets_store
from .. import scope as run_scope
from ..approvals import ApprovalRejected, Gatekeeper
from . import bash as bash_mod
from . import hostinfo
from . import run_code as run_code_mod
from . import sql as sql_mod

log = logging.getLogger(__name__)

FILE_TOOLS = ("read_file", "write_file", "edit_file", "ls", "grep", "glob")
ASSET_KINDS = ("procedure", "script", "query", "baseline")

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
    def __init__(self, settings: Settings, gate: Gatekeeper, notifier: Notifier, controller: Any = None,
                 mcp_tools: list | None = None):
        self._s = settings
        self._gate = gate
        self._ctl = controller
        self._notifier = notifier
        self._mcp = {t.name: t for t in (mcp_tools or [])}
        self._fns: dict[str, Fn] = {}
        self._info: dict[str, ToolInfo] = {}
        self._register()

    # —— 目录 ——

    def _add(self, fn: Fn, title: str, group: str, dangerous: bool = False, summary: str = "") -> None:
        self._fns[fn.__name__] = fn
        doc = (fn.__doc__ or "").strip().splitlines()
        self._info[fn.__name__] = ToolInfo(fn.__name__, title, summary or (doc[0] if doc else ""), group, dangerous)

    def info(self) -> list[dict]:
        out = [i.dump() for i in self._info.values()]
        out += [ToolInfo(n, n, (t.description or "").split("\n")[0][:120], "mcp").dump() for n, t in self._mcp.items()]
        return out

    @property
    def names(self) -> set[str]:
        return set(self._fns) | set(self._mcp)

    def unknown(self, names: list[str]) -> list[str]:
        return [n for n in names if n not in self.names and n not in FILE_TOOLS]

    def langchain_tools(self, names: list[str]) -> list:
        from langchain_core.tools import tool

        out = []
        for n in names:
            if n in self._fns:
                out.append(tool(self._fns[n]))
            elif n in self._mcp:
                out.append(self._mcp[n])
            elif n not in FILE_TOOLS:
                log.warning("角色声明了未登记的工具 %s，已忽略", n)
        return out

    def host_tools(self, names: list[str] | tuple[str, ...]) -> dict[str, Fn]:
        out: dict[str, Fn] = {n: self._fns[n] for n in names if n in self._fns and n != "run_code"}
        out.update({n: self._mcp[n].ainvoke for n in names if n in self._mcp})
        return out

    # —— 实现 ——

    def _register(self) -> None:
        s, gate, ctl, toolbox = self._s, self._gate, self._ctl, self

        async def bash(command: str, timeout: int = 60, network: bool = False) -> str:
            """在沙箱里执行 shell 命令：全盘只读（可读服务代码与配置）、只有工作目录可写、
            调用结束后台进程全灭。默认断网；需要访问本机服务端口或内网接口时传 network=true。
            受保护环境里命中危险模式（rm -rf、drop、kill、systemctl…）会挂起等人工审批。"""
            try:
                await gate.review("bash", command)
            except ApprovalRejected as e:
                return f"[未执行] {e}"
            r = await asyncio.to_thread(bash_mod.run_command, command, max(1, min(timeout, 600)),
                                        s.scratch_dir, None, network)
            return bash_mod.format_result(r)

        async def run_code(code: str, timeout: int = 120) -> str:
            """写一段 Python 一次编排多个工具：角色可用的工具都以同名函数提供（如 sql_query(sql)），
            可循环/分支；中间数据不进上下文，只有 print 的内容返回。代码在沙箱内执行。"""
            try:
                await gate.review("run_code", code)
            except ApprovalRejected as e:
                return f"[未执行] {e}"
            sc = run_scope.current()
            return await run_code_mod.execute_code(code, toolbox.host_tools(sc.tools), s.scratch_dir,
                                                   timeout=max(1, min(timeout, 600)))

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
            """启停本服务在本环境的进程。action：status / start / stop / restart / logs。
            process 为进程名（只有一个进程时可省略）。受保护环境的 start/stop/restart 需人工审批。
            启动带租约，到期自动停止。"""
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
                if sc.protected:
                    await gate.hold(kind="process", title=f"进程{action} · {sc.service}/{process}@{sc.env}",
                                    detail=f"运行 {sc.run_id} 请求 {action} {sc.service}/{process}（环境 {sc.env}）",
                                    payload={"service": sc.service, "env": sc.env, "process": process,
                                             "action": action, "executor": "run"})
                by = f"run:{sc.run_id}"
                if action in ("stop", "restart"):
                    await ctl.stop(sc.service, sc.env, process, by=by)
                if action in ("start", "restart"):
                    await ctl.start(sc.service, sc.env, process, by=by)
                i = await ctl.get(sc.service, sc.env, process)
                return f"{action} 完成：{i['state']}" + (f"，端口 {i['port']}" if i["port"] else "") \
                    + (f"，租约到 {i['lease_until']}" if i["lease_until"] else "")
            except ApprovalRejected as e:
                return f"[未执行] {e}"
            except Rejected as e:
                return f"[失败] {e.message}"

        async def sql_query(sql: str) -> str:
            """在本服务本环境的只读库执行 SELECT / WITH / EXPLAIN（自动限时、限 200 行，报错结构化返回）。"""
            sc = run_scope.current()
            dsn = sc.view.readonly_dsn if sc.view else None
            if not dsn:
                return f"[未配置] 服务 {sc.service or '—'} 在 {sc.env} 没有只读库"
            return await sql_mod.run_query(dsn, sql)

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

        async def read_artifact(name: str) -> str:
            """读取本次任务图运行里某个上游节点的完整产物（提示里只给了摘要）。"""
            sc = run_scope.current()
            a = await artifacts_store.get(sc.run_id, name)
            if a is None or a["content"] is None:
                return f"[不存在] 产物 {name}（未物化或被跳过）"
            return json.dumps(a["content"], ensure_ascii=False, indent=2, default=str)

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

        self._add(bash, "Shell", "core", dangerous=True, summary="bwrap 沙箱：全盘只读、工作目录可写、默认断网")
        self._add(run_code, "代码编排", "core", dangerous=True, summary="CodeAct：一段 Python 编排多个工具调用")
        self._add(service_info, "服务信息", "service", summary="本运行服务×环境的目录、配置文件内容、git 状态")
        if ctl is not None and ctl.backend != "off":
            self._add(service_ctl, "进程启停", "service", dangerous=True, summary="启停本服务本环境的进程（受保护环境需审批）")
        self._add(sql_query, "只读 SQL", "service", summary="本服务本环境的只读库，自动限时限量")
        if s.grafana is not None:
            self._add(host_metrics, "主机指标", "service", summary="部署主机内存/负载/根盘（Grafana）")
        self._add(save_asset, "沉淀方法", "memory", summary="把可复用的方法/脚本/查询/基线存入记忆")
        self._add(read_artifact, "读产物", "memory", summary="读取任务图上游节点的完整产物")
        self._add(notify, "发通知", "notify", summary="发 markdown 通知到任务的通知渠道")
