"""agent 层：按角色装配并执行 agent。

- factory    AgentFactory：（角色, 版本）→ 编译好的 agent，缓存复用；invoke 执行一次并把事件流落台账
- scope      RunScope：工具调用时的"当前运行 / 服务×环境"
- approvals  人工门（危险命令、受保护环境进程启停、任务图闸门）
- tools      工具目录与实现
"""
