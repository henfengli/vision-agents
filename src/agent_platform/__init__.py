"""agent-platform：平台级 Agent 服务（多业务角色、事件触发、对话与自动化）。

分层（依赖单向向下，跨层只走本包出口的类/函数）：
- config         配置（环境 YAML → Settings）
- store          存储层（PG：台账/定义/知识/案例/反馈/审批）
- model          模型连接池（内部 OpenAI 兼容 API）
- memory         记忆层（recall 召回 / distill 沉淀）
- agent          agent 层（roles/engine/approvals/tools）
- orchestration  编排层（Temporal：spec/tasks/submitter/workflows/activities/worker）
- langfuse       prompt 源头 + 观测 + 反馈回写
- notify         钉钉单向中继
- api            接入层（/v1 业务路由）
- triggers       触发层（dagster sensor / gitlab webhook / chat）
- viewer         Run Viewer 自托管观测站点
- main           装配与启动入口
"""

__version__ = "4.0.0"
