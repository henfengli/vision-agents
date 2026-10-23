"""工具层：执行能力的唯一入口。

- catalog     工具目录：每个工具的唯一定义点，两个出口（langchain_tools / host_tools：py 内核里可调的同名函数）
- sandbox     bwrap 沙箱包装
- bash        通用 shell（也是读写文件的方式）
- db          只读查库（PostgreSQL / MySQL / MariaDB / Doris / ClickHouse / MongoDB，大结果写文件）
- hostinfo    Grafana 主机指标
- mcp_bridge  MCP server 工具加载、按 服务×环境 路由、按会话常驻的 MCP 会话
"""
