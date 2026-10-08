"""工具层：执行能力与审查的唯一入口。

- sandbox     bwrap 沙箱包装
- bash        L0 通用工具
- sql         只读 SQL 薄工具
- run_code    L2 CodeAct 编排（driver 为沙箱内一侧）
- mcp_bridge  内部 MCP 服务器工具加载
- registry    注册表：每个工具的唯一定义点，两个出口（resolve / host_tools）
"""
