"""agent 层：角色、引擎、人工审批、工具——agent 能力的一切。

- roles     角色定义/继承解析/DeepAgents 装配
- engine    agent 生命周期（按需构建、TTL 惰性重建、热加载）
- approvals 危险命令人工审批（LISTEN/NOTIFY 唤醒）
- tools     工具层（sandbox/bash/sql/run_code/mcp/registry）
"""
