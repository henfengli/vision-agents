"""agent-platform：平台级 Agent 服务（多业务角色、事件触发、对话与自动化）。

分层（依赖单向向下，跨层只走本包出口的类/函数）：
- config         配置（环境 YAML → Settings）
- store          存储层（PG：台账/定义/知识/案例/反馈/审批/产物）
- model          模型连接池（内部 OpenAI 兼容 API）
- memory         记忆层（recall 召回 / distill 沉淀 / gardener 夜间维护口子）
- agent          agent 层（roles/engine/approvals/tools）
- orchestration  编排层（Temporal：spec/tasks/policies/artgraph/submitter/
                 workflows/activities/worker）
- langfuse       prompt 源头 + 观测 + 反馈回写
- notify         钉钉单向中继
- api            接入层（/v1 业务路由）
- triggers       触发层（dagster sensor / gitlab webhook / chat）
- viewer         Run Viewer 自托管观测站点
- main           装配与启动入口
- envrun         按需环境启动器（bwrap 隔离配置，会话结束自动停止）
- serve          沙箱内服务入口（host/port 从 Settings 读）
"""

__version__ = "4.2.0"
