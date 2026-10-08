"""工具注册表：每个工具只定义一次（`self._build_<name>` 工厂，返回 async callable）。

- resolve(names)：给 LLM 的 LangChain 工具（同一份实现套 @tool 壳）
- host_tools(names)：给 run_code 桩函数的原生 callable（同一实现，无壳）

分层：L0 bash（bwrap 沙箱兜底）/ L2 run_code（CodeAct 编排）/
薄工具（sql_query、dingtalk_send、update_asset_profile）。
审查层（review）与工具解耦：bash 命令与 run_code 代码走同一组危险模式审批。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

from . import bash as bash_mod
from . import run_code as run_code_mod
from . import sql as sql_mod

log = logging.getLogger(__name__)

ReviewFn = Callable[[str], Awaitable[None]]  # 命中危险模式时由它决定阻断/等待审批

# DeepAgents 内置文件系统中间件提供的工具名：不注册、不告警
_BUILTIN_TOOLS = {"read_file", "write_file", "grep", "ls", "edit_file"}


class ToolRegistry:
    def __init__(self, scratch_dir: str, relay: Any = None,
                 review: ReviewFn | None = None,
                 profile_writer: Callable[..., Awaitable[None]] | None = None,
                 sql_dsn: Callable[[str | None], str | None] | None = None,
                 extra_tools: list | None = None):
        self._scratch_dir = scratch_dir
        self._relay = relay
        self._review = review
        self._profile_writer = profile_writer
        self._sql_dsn = sql_dsn               # domain → 只读 DSN
        self._extra_tools = extra_tools or []  # MCP 等外部加载的 LangChain 工具

        # 工具目录：名字 → 工厂。每个工具的唯一定义点。
        self._catalog: dict[str, Callable[[], Callable]] = {"bash": self._build_bash}
        if sql_dsn is not None:
            self._catalog["sql_query"] = self._build_sql_query
        if relay is not None:
            self._catalog["dingtalk_send"] = self._build_dingtalk_send
        if profile_writer is not None:
            self._catalog["update_asset_profile"] = self._build_update_asset_profile
        self._catalog["run_code"] = self._build_run_code_placeholder

    # —— 工具定义（唯一的实现出处） ——

    def _build_bash(self) -> Callable:
        scratch, review = self._scratch_dir, self._review

        async def bash(command: str, timeout: int = 60) -> str:
            """在受控沙箱执行 shell 命令（bwrap：全盘只读、仅 scratch 可写、默认断网）。"""
            if review is not None:
                await review(command)
            r = await asyncio.to_thread(bash_mod.run_command, command, timeout, scratch)
            return bash_mod.format_result(r)
        return bash

    def _build_sql_query(self) -> Callable:
        resolver = self._sql_dsn

        async def sql_query(sql: str, domain: str | None = None) -> str:
            """只读 SQL 查询（SELECT/WITH/EXPLAIN；自动限时限量，结构化报错）。"""
            assert resolver is not None
            dsn = resolver(domain)
            if not dsn:
                return "[拒绝] 该域未配置只读库"
            return await sql_mod.run_query(dsn, sql)
        return sql_query

    def _build_dingtalk_send(self) -> Callable:
        relay = self._relay

        async def dingtalk_send(title: str, content: str) -> str:
            """向业务群发送钉钉通知。title 为标题，content 支持 markdown。"""
            await relay.send_markdown(title, content)
            return "已发送"
        return dingtalk_send

    def _build_update_asset_profile(self) -> Callable:
        writer = self._profile_writer

        async def update_asset_profile(asset_key: str, content: str,
                                       domain: str | None = None) -> str:
            """沉淀某资产的档案事实（负责人、上游依赖、特殊口径、已知坑）。
            逐字保存、永不摘要；下次涉及该资产的分析自动召回置顶。"""
            assert writer is not None
            await writer(asset_key, content, domain)
            return f"asset:{asset_key}:profile 已更新"
        return update_asset_profile

    def _build_run_code_placeholder(self) -> Callable:
        # run_code 需要角色白名单（桩函数范围），只能在 resolve() 时构建；
        # 占位保证 catalog 完整。直接取 host_tools 里的 run_code 会拿到拒绝实现。
        async def _unavailable(code: str, timeout: int = 120) -> str:
            return "[拒绝] run_code 只能作为角色工具使用（需白名单上下文）"
        return _unavailable

    def _build_run_code(self, role_tools: list[str]) -> Callable:
        review, scratch, registry = self._review, self._scratch_dir, self
        allowed = list(role_tools)  # 闭包捕获：并发角色互不污染

        async def run_code(code: str, timeout: int = 120) -> str:
            """写 Python 代码一次编排多个工具：桩函数直接调用角色白名单内的工具
            （bash/sql_query/dingtalk_send/update_asset_profile/MCP 工具），可循环/
            分支/并发；中间数据不进上下文，只有 print 输出返回。代码在沙箱内执行。"""
            if review is not None:
                await review(code)
            return await run_code_mod.execute_code(
                code, registry.host_tools(allowed), scratch, timeout=timeout)
        return run_code

    # —— 两个出口 ——

    def host_tools(self, names: list[str]) -> dict[str, Callable]:
        """name → async callable（run_code 桩函数绑定用）。白名单外忽略。"""
        out = {n: self._catalog[n]() for n in names
               if n in self._catalog and n != "run_code"}
        for t in self._extra_tools:  # MCP 工具（已是 LangChain 工具，取 ainvoke）
            if getattr(t, "name", None) in names:
                out[t.name] = t.ainvoke
        return out

    def resolve(self, names: list[str]) -> list:
        """按角色白名单返回 LangChain 工具对象（同一份实现套 @tool 壳）。"""
        from langchain_core.tools import tool  # 延迟导入：纯逻辑测试无需 langchain

        tools = []
        for name in names:
            if name == "run_code":
                tools.append(tool(self._build_run_code(names)))
            elif name in self._catalog:
                tools.append(tool(self._catalog[name]()))
            elif name not in _BUILTIN_TOOLS and name not in {
                    t.name for t in self._extra_tools}:
                # 配置 typo 不静默忽略：跳过但记警告（启动/装配日志可见）
                log.warning("角色配置了未注册的工具 %s，已跳过", name)
        extra = {t.name: t for t in self._extra_tools}
        tools += [extra[n] for n in names if n in extra]
        # read_file/grep 等由 DeepAgents 内置文件系统中间件提供，无需注册
        return tools
