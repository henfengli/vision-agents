# agent-platform v3.1

平台级 Agent 服务：一套代码三环境部署，多业务角色、事件触发、对话与自动化流程。
设计文档见《Agent服务平台设计文档.md》（v3.0）。

v3 在 v2 基础上做了结构清理（session 单概念、两阶段装配、knowledge 拆包、viewer 分页、纠正继承上下文）；v2 相对 v1：**编排层换成 Temporal**（durable execution：崩溃恢复、审批挂起、重试、定时调度全部原生），
**可观测与提示词管理换成 Langfuse**（角色提示词=Langfuse Prompt，追踪=OTEL 直推，评估=Scores），
Postgres 仍是业务事实层（台账/记忆/定义/反馈），并新增时序化记忆、pg_trgm+pgvector RRF 混合检索、
session 级纠正反馈闭环、Web 管理页（角色/任务/记忆在线编辑）。
会话为 episode 制（thread 有界），跨会话连续性由记忆层承载：
四节模板交接摘要 + 资产档案逐字召回 + agent 可写 profile + 重复纠正升舱提示。

## 快速开始

```bash
# 依赖服务：Postgres、Temporal server、Langfuse（可选，禁用则提示词直读 PG）
sudo systemctl start temporal-server langfuse

# 部署（主机 + systemd，与现有服务方式一致）
sudo deploy/install.sh test

# 业务服务内嵌调用（HTTP API 即契约，SDK 为可选薄封装）
pip install ./sdk
export AGENT_BASE_URL=http://agent.test.internal:8100 AGENT_TOKEN=...
python -c "
from agent_client import AgentClient
print(AgentClient(server='board', role='data_searcher').ask('3月以来 total_fee 是多少'))
"

# 交互式对话
agent-chat --server board --role data_searcher

# 管理（角色写 Langfuse 标签即生效，PG 兜底缓存）
curl -X PUT $AGENT_BASE_URL/v1/admin/roles/data_searcher \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"definition": {"prompt": "...", "domains": ["board"], "tools": ["bash"]}}'

# session 级纠正反馈（AI 判断有误时给出具体纠正，自动重判并更新记忆）
curl -X POST $AGENT_BASE_URL/v1/sessions/{session_id}/feedback \
  -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d '{"correction": "少考虑了退款单，total_fee 应排除 status=refunded"}'
```

## 目录

```
conf/    domains.yaml（业务域拓扑）+ env/{prod,test,dev}.yaml（环境差异：temporal/langfuse 配置）
src/agent_platform/
  gateway/        接入层：鉴权 / 限流 / 端点（含 session 纠正反馈、admin 角色/任务/记忆管理）
  orchestration/  Temporal：workflows（3-activity 主流程）/ activities / worker / submitter / schedules
  tasks/          任务注册（DB 热生效）+ 触发源（dagster/gitlab/chat）
  roles/          角色继承解析 + DeepAgents 装配
  runtime/        Engine（agent 生命周期）+ approvals（LISTEN/NOTIFY + activity heartbeat）
  tools/          L0 bash（bwrap 沙箱）+ L2 run_code（CodeAct 编排）+ L1 MCP 桥 + 薄工具（sql_query 等）
  model/          模型连接池（多 token 轮询 + 限并发 + 重试 + embedding）
  store/          Postgres：台账 / 案例库 / 反馈 / 版本化定义 + knowledge 包（crud/retrieval/temporal/profiles）
  memory/         运行前召回（RRF 混合检索）+ 运行后沉淀（supersede 时序失效）
  notify/         钉钉中继封装（纯输出）
  viewer/         Run 详情 / 审批 / Web 对话 / 管理 / 记忆，五页同站点
sdk/       agent-client 参考封装 + agent-chat CLI
deploy/    systemd unit（agent + temporal-server）+ install.sh
tests/     标准库 unittest：python3 -m unittest discover -s tests
```

## 关键设计

- **Temporal durable execution**：run_id 即 workflow id；崩溃后 worker 自动重放恢复；审批挂起不占资源；
  同 id 重启（ALLOW_DUPLICATE_FAILED_ONLY）实现断点续跑；Temporal Schedules 替代 pg_cron
- **Langfuse 提示词源**：角色 = `role:<name>` Prompt（label 区分生产/灰度，config 存 domains/tools 等元数据），
  读路径 Langfuse→MAP 缓存→PG 兜底；写路径幂等 upsert，支持整替换与版本回滚
- **环境即权限**：systemd 低权限用户 + 全盘只读 + 仅 scratch 可写；DB 全走只读账号
- **时序化记忆**：valid_from/valid_to/superseded_by，事实过期不删除只失效；纠正反馈触发重判后
  旧 session 产出的知识/案例自动 supersede，新结论入库
- **混合检索**：pg_trgm 关键词 + pgvector 余弦，RRF（k=60）融合排序
- **越用越聪明**：知识库（code_ref commit 校验防过期）+ 案例库（报错指纹归一化）+ 纠正反馈闭环
