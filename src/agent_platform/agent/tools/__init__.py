"""工具层：执行能力的唯一入口。

- catalog     工具目录：每个工具的唯一定义点，两个出口（langchain_tools / host_tools）
- sandbox     bwrap 沙箱包装
- bash        通用 shell
- sql         只读 SQL
- run_code    CodeAct 编排（driver 为沙箱内一侧）
- hostinfo    Grafana 主机指标
- mcp_bridge  内部 MCP 服务器工具加载
"""
