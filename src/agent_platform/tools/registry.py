"""工具注册表：按名装配角色白名单引用的工具。

分层：
- L0 自由层：bash（bwrap 沙箱，长尾兜底）
- L2 编排层：run_code（agent 写 Python 一次编排多个工具，桩函数 RPC 回 host）
- 薄工具：sql_query / dingtalk_send / update_asset_profile（结构化、可审计）

审查层（review）与工具实现解耦：bash 命令与 run_code 代码走同一组
危险模式审批——新工具自动继承，不再各自挂 hook。

LangChain 的 @tool 装饰器在此集中应用——核心逻辑保持纯函数，可独立测试。
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from . import bash as bash_mod
from . import run_code as run_code_mod
from . import sql as sql_mod
from .dingtalk import make_dingtalk_tool

ReviewFn = Callable[[str], None]  # 命中危险模式时由它决定阻断/等待审批


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
        self._sql_dsn = sql_dsn            # domain → 只读 DSN
        self._extra_tools = extra_tools or []  # MCP 等外部加载的 LangChain 工具

    # —— host 侧可调用工具（run_code 桩函数绑定这些） ——

    def host_tools(self, names: list[str]) -> dict[str, Callable]:
        """返回 name → async callable；白名单外的名字直接忽略。"""
        out: dict[str, Callable] = {}
        if "bash" in names:
            scratch, review = self._scratch_dir, self._review

            async def _bash(command: str, timeout: int = 60) -> str:
                if review is not None:
                    review(command)
                r = await asyncio.to_thread(
                    bash_mod.run_command, command, timeout, scratch)
                return bash_mod.format_result(r)
            out["bash"] = _bash
        if "sql_query" in names and self._sql_dsn is not None:
            resolver = self._sql_dsn

            async def _sql(sql: str, domain: str | None = None) -> str:
                dsn = resolver(domain)
                if not dsn:
                    return "[拒绝] 该域未配置只读库"
                return await sql_mod.run_query(dsn, sql)
            out["sql_query"] = _sql
        if self._relay is not None and "dingtalk_send" in names:
            async def _ding(text: str, title: str = "agent") -> str:
                await self._relay.send_text(title, text)
                return "已发送"
            out["dingtalk_send"] = _ding
        if self._profile_writer is not None and "update_asset_profile" in names:
            writer = self._profile_writer

            async def _profile(asset_key: str, content: str,
                               domain: str | None = None) -> str:
                await writer(asset_key, content, domain)
                return f"asset:{asset_key}:profile 已更新"
            out["update_asset_profile"] = _profile
        for t in self._extra_tools:  # MCP 工具
            if getattr(t, "name", None) in names:
                out[t.name] = t.ainvoke
        return out

    # —— LLM 面向的 LangChain 工具 ——

    def _llm_factories(self, role_tools: list[str]) -> dict[str, Callable[[], Callable]]:
        factories: dict[str, Callable[[], Callable]] = {}

        def bash_tool():
            host = self.host_tools(["bash"])["bash"]

            async def bash(command: str, timeout: int = 60) -> str:
                """在受控沙箱执行 shell 命令（bwrap：全盘只读、仅 scratch 可写、默认断网）。"""
                return await host(command, timeout)
            return bash
        factories["bash"] = bash_tool

        if self._sql_dsn is not None:
            def sql_tool():
                host = self.host_tools(["sql_query"])["sql_query"]

                async def sql_query(sql: str, domain: str | None = None) -> str:
                    """只读 SQL 查询（SELECT/WITH/EXPLAIN；自动限时限量，结构化报错）。"""
                    return await host(sql, domain)
                return sql_query
            factories["sql_query"] = sql_tool

        def run_code_tool():
            review, scratch, registry = self._review, self._scratch_dir, self
            allowed = list(role_tools)  # 闭包捕获：并发角色互不污染

            async def run_code(code: str, timeout: int = 120) -> str:
                """写 Python 代码一次编排多个工具：桩函数直接调用（bash/sql_query/
                dingtalk_send/update_asset_profile 及角色白名单内工具），可循环/分支/
                并发；中间数据不进上下文，只有 print 输出返回。代码在沙箱内执行。"""
                if review is not None:
                    review(code)
                tools = registry.host_tools(allowed)
                return await run_code_mod.execute_code(
                    code, tools, scratch, timeout=timeout)
            return run_code
        factories["run_code"] = run_code_tool

        if self._relay is not None:
            factories["dingtalk_send"] = lambda: make_dingtalk_tool(self._relay)
        if self._profile_writer is not None:
            def profile_tool():
                writer = self._profile_writer

                async def update_asset_profile(asset_key: str, content: str,
                                               domain: str | None = None) -> str:
                    """沉淀某资产的档案事实（负责人、上游依赖、特殊口径、已知坑）。
                    逐字保存、永不摘要；下次涉及该资产的分析自动召回置顶。"""
                    await writer(asset_key, content, domain)
                    return f"asset:{asset_key}:profile 已更新"
                return update_asset_profile
            factories["update_asset_profile"] = profile_tool
        return factories

    def resolve(self, names: list[str]) -> list:
        """按角色白名单返回 LangChain 工具对象。"""
        from langchain_core.tools import tool  # 延迟导入：纯逻辑测试无需 langchain

        factories = self._llm_factories(list(names))
        tools = [tool(factories[name]()) for name in names if name in factories]
        extra = {t.name: t for t in self._extra_tools}
        tools += [extra[n] for n in names if n in extra]
        # read_file/grep 等由 DeepAgents 内置文件系统中间件提供，无需注册
        return tools
