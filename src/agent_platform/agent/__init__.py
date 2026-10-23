"""agent 层：按角色装配并执行 agent。

- factory    AgentFactory：（角色, 版本）→ 编译好的 agent（langchain create_agent + 自选中间件），缓存复用；
             invoke 执行一次并把事件流（每次模型调用的耗时与 token、工具调用）落台账
- scope      RunScope：工具调用时的"当前运行 / 服务×环境"
- tools      工具目录与实现
"""
