"""编排层：Temporal 之上的一切。

- spec       RunSpec：一次 run 的完整规格（编排层唯一数据结构）
- tasks      任务类型注册表（DB 声明 + 热生效）
- submitter  提交端：submit/run_sync/correct/resume_run
- workflows  AgentRunWorkflow + Temporal Schedules 同步
- activities 三个执行步骤（prepare/run/finalize + mark_failed）
- worker     Temporal Worker 装配
"""
