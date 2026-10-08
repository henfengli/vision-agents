"""MCP 桥：内部 MCP 服务器的工具加载（可选依赖 langchain-mcp-adapters）。

内网 MCP 的价值不是接外部 SaaS，而是给内部服务一个带 schema 的类型化
接口（Dagster GraphQL、config-center API 等）。加载出的 LangChain 工具
注入 ToolRegistry.extra_tools，同时可供 run_code 桩函数绑定。
未安装适配器或未配置服务器时为空操作——链路不断。
"""

from __future__ import annotations

import logging

log = logging.getLogger(__name__)


async def load_mcp_tools(servers: dict[str, dict]) -> list:
    """连接全部配置的 MCP server，返回聚合的 LangChain 工具列表。"""
    if not servers:
        return []
    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        log.warning("配置了 mcp_servers 但未安装 langchain-mcp-adapters，跳过")
        return []
    try:
        client = MultiServerMCPClient(servers)
        tools = await client.get_tools()
        log.info("MCP 加载 %d 个工具（%d 个 server）", len(tools), len(servers))
        return tools
    except Exception:  # noqa: BLE001 —— MCP 不可用不阻断主流程
        log.exception("MCP 工具加载失败")
        return []
