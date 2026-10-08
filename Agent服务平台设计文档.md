# Agent 服务平台设计文档（v3.0）

> v2.0 是一次架构换代：执行层从"自建队列+恢复"换成 **Temporal**（durable execution），
> 观测与 prompt 源头换成 **Langfuse**，记忆层时序化，反馈改为纠正式闭环。
> v1 的自建 dispatcher/zombie recovery/pg_cron/Phoenix 全部移除。

## 1. 定位与约束

平台级 agent 服务：部署在三个物理隔离的内网环境（prod/test/dev），
为业务系统（Dagster、看板、配置中心等）提供统一的 agent 能力。

硬约束：无用户体系（固定 bearer token）；单一内部 OpenAI 兼容模型 API；
无 MCP（bash 为通用工具）；无容器（host + systemd）。

## 2. 架构总览

```
业务系统 / CLI / Web / Dagster sensor / GitLab webhook
        │  HTTP（bearer token）
        ▼
┌─────────────────────────────────────────────────┐
│ gateway (FastAPI)                                │
│  ask/chat/tasks/resume/approvals/feedback/admin  │
└──────┬──────────────────────────────┬───────────┘
       │ start_workflow               │ 读写
       ▼                              ▼
┌─────────────┐   poll/execute   ┌──────────────┐
│  Temporal    │ ◄────────────── │ Worker        │
│  Server      │   3 activities  │ prepare_run   │
│ (durable     │                 │ run_agent     │── DeepAgents(角色/工具)
│  execution)  │                 │ finalize_run  │── 记忆召回/沉淀
└─────────────┘                  └──────┬───────┘
                                        │
        ┌───────────────┬───────────────┼───────────────┐
        ▼               ▼               ▼               ▼
   ┌─────────┐   ┌───────────┐   ┌──────────┐   ┌───────────┐
   │ Postgres│   │ Langfuse  │   │ 模型 API │   │ 钉钉中继  │
   │ 台账/记忆│   │ trace/prompt│  │(兼容OpenAI)│  │(单向输出) │
   │ /审批/缓存│   │ /评估/score│  │          │   │           │
   └─────────┘   └───────────┘   └──────────┘   └───────────┘
```

**职责切分**：
- **Temporal**：执行的耐久性——崩溃恢复、重试、超时、调度、跨机 worker。
  事件历史即执行记录。
- **Langfuse**：观测（OTEL trace）+ 评估（score/数据集）+ 角色 prompt 源头。
- **Postgres**：业务闭环唯一事实源——run 台账、事件明细、知识/案例（记忆）、
  审批、反馈、任务定义、Langfuse prompt 的持久缓存。
- **自家代码**：业务闭环逻辑（审批门禁、记忆召回/沉淀、纠正反馈、管理页）。

## 3. 执行层（Temporal）

### 3.1 Workflow 结构

一个 run = 一个 workflow（id = run_id），三步各为一个 activity：

| Activity | 职责 | 重试策略 |
| --- | --- | --- |
| `prepare_run` | 建/更新台账行、角色解析（Langfuse→缓存→PG）、记忆召回、拼 prompt | 3 次（轻量 DB 操作） |
| `run_agent` | DeepAgents 执行，事件流实时写 PG 台账 | 不自动重试（人工/resume 路径） |
| `finalize_run` | 状态落库、纠正反馈的旧记忆取代、记忆沉淀、输出投递 | 3 次 |

为什么 DeepAgents 整体是一个 activity 而不是 per-node：DeepAgents 的图节点
是框架内部生成的，无法标注 `execute_in`；run 级粒度 + LangGraph PG
checkpoint（会话/续跑用）已覆盖我们的恢复需求。

### 3.2 恢复语义（v1 zombie recovery 的替代）

- worker/进程死亡：Temporal server 重新调度 activity，无需自建清扫
- run 失败：`POST /v1/runs/{id}/resume` 用同 workflow id 重新 start，
  `WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY`——
  **只有终态（失败/终止）的执行能被顶替，正在跑的不会被误续**；
  resume 时 run_agent 以空输入从 LangGraph 断点继续
- 调度任务（schedule 触发）：run_id 由 prepare_run 现场生成并建台账行

### 3.3 审批

bash 工具命中危险模式 → 写 approvals 行 → 钉钉 actionCard →
等待用 **LISTEN/NOTIFY 毫秒级唤醒**（每轮等待同时发 Temporal heartbeat，
activity 不被误判超时；notify 丢失有轮询兜底；DB 行是唯一事实源）。
超时/拒绝视同不放行（安全侧默认）。

### 3.4 调度

任务定义带 `schedule`（cron 表达式）+ `schedule_input` →
启动时同步为 **Temporal Schedules**（前缀 `task:<name>`，幂等增删改）。
替代 v1 的 pg_cron 方案。

## 4. Langfuse（观测 + prompt 源头 + 评估）

### 4.1 角色定义源头

- Langfuse prompt：`name="role:<角色名>"`，content=system_prompt 文本，
  config=工具/域/继承等结构化配置，label=production/canary（灰度）
- 读取路径：**Langfuse API → MAP 缓存（TTL 10s）→ PG definitions 持久缓存**
  （写穿：拉到就同步 PG，内容不变不产生新版本）
- Langfuse 宕机：MAP 过期缓存 → PG 缓存，服务可独立存活
- 写入路径：`POST /v1/admin/roles` → Langfuse 新版本接管 label + 写穿 PG；
  回滚 = 把历史版本重新推为新版本
- 降级模式（langfuse.enabled=false）：源头即 PG definitions 表，全功能可用

### 4.2 观测

OTLP exporter 指向 Langfuse OTEL 端点（`/api/public/otel/v1/traces`，
Basic Auth）+ LangChainInstrumentor 自动覆盖模型/工具调用。
run span 挂业务属性（run_id/task_type/role/env/session_id），
trace_id+span_id 写入台账事件，Viewer 详情页可跳 Langfuse。
`record_content=false` 时 trace 事件只带内容长度（脱敏）。

### 4.3 评估闭环

打分反馈（👍/👎）写 Langfuse score（挂 trace）；纠正式反馈产生的新 run
也带同一 session 的 trace 链。badcase 在 Langfuse 里按 score 过滤导出回归集。

## 5. 记忆层（时序化 + 混合检索）

### 5.1 事实时序化

knowledge/cases 带 `valid_from/valid_to/superseded_by`：**结论被纠正或失效时
置 valid_to（软过期），历史保留可审计**——配置变更后旧结论不再召回但可追溯。

### 5.2 混合检索

pg_trgm（关键词相似度）+ pgvector（语义向量，HNSW）两路召回，**RRF 融合**
（只认排名不认分数，对两路尺度差异鲁棒）。
嵌入模型走内部 OpenAI 兼容 `/embeddings`（`model.embedding_name` 配置）；
未配置/无 pgvector 扩展时自动退化 trgm → ILIKE，链路不断。

### 5.3 纠正式反馈（替代 👍/👎 的主路径）

```
POST /v1/sessions/{sid}/feedback {correction: "少考虑了汇率"}
  → 同 session（thread）提交新 run，消息带纠正内容
  → agent 结合会话上下文重新判断
  → 新 run 从 session 最近一次 run 继承 task_type/role/domain（v3：不写死）
  → finalize：上一次 run 沉淀的知识/案例置 valid_to（superseded_by=新 run）
    ——纠正只杀被纠正的判断，不误伤更早的正确历史
  → 新结论沉淀入库，feedback 表留痕（kind=correction）
```

👍/👎 保留为附带信号（影响召回排序、写 Langfuse score）。

### 5.4 会话生命周期：episode + 交接摘要（v3.0）

thread 无限复用必然上下文爆炸；**连续性由记忆层承载，不由 thread 承载**：

- **session_id 带 episode 维度**：如 `dagster:{asset_key}:{error_class}:{date}`
  ——同资产同类故障按天连续，跨类/隔天自动开新线，thread 长度天然有界
- **交接摘要**：run 结束时 distill 额外产出四节模板摘要
  （结论/被否方案/当前约束/未决问题——Compaction Cliff 的教训：
  散文摘要最先丢的恰是被否方案与约束，故固定分节），
  存为 `session:{sid}:summary` 知识条目；新 episode 召回时置顶注入
- **资产档案逐字保留**：`asset:{key}:profile` 条目（负责人/上游依赖/特殊口径）
  永不摘要，召回块固定头部；agent 可用 `update_asset_profile` 工具自行沉淀
- **升舱提示**：同一 session 被纠正 ≥3 次（`correction_counts`），管理页提示
  人工升舱为角色 prompt——程序记忆升舱保持人工门，不自动改提示词

## 5.5 v3.0 结构清理

- **概念唯一**：全系统只有 session_id（LangGraph thread 是 engine 内部实现细节）；
  runs 表列名即 session_id，无双名映射
- **真两阶段装配**：lifespan 内完成全部连接与路由挂载，无同步装配期占位类
- **knowledge 拆包**：crud / retrieval / temporal / profiles
- **viewer 分页**：pages/{runs,approvals,chat,admin,memory} 一页一文件
- **纠正继承上下文**：submitter.correct() 从 session 最近 run 继承任务配置

## 6. 管理面

- **Admin API**：角色/任务 CRUD（版本化、写后即时生效）、回滚、
  幂等 upsert（内容不变不产生新版本）
- **Viewer 网页**：/admin 角色与任务定义的网页编辑（JSON 表单，保存即新版本）；
  /memory 记忆管理（查看/筛选/编辑/失效，含已取代条目）；/runs 运行详情
  （运行图 + 事件流 + Langfuse 跳转）；/approvals 审批页；/chat 对话页（SSE）

## 7. 数据模型（Postgres）

runs（run_id, thread_id, status, dedup_key...）、run_events（seq, kind, payload）、
knowledge（env/domain/key 唯一，code_ref 失效校验，valid_from/to，embedding）、
cases（fingerprint 去重，valid_to）、feedback（run 或 session 级，kind=rating/correction）、
definitions（kind/env/name/version 版本化）、approvals（危险命令审批）。

## 8. 部署（systemd，无容器）

| 单元 | 内容 |
| --- | --- |
| `temporal-server.service` | Temporal server 单二进制（持久层可复用 PG） |
| `agent-platform.service` | uvicorn --factory（gateway + worker 同进程） |

Langfuse 复用环境既有部署（web/worker + PG + ClickHouse + Redis + MinIO）。
配置：`conf/env/{env}.yaml` 的 `temporal:` 与 `langfuse:` 块。

## 9. 与 v1 的差异对照

| v1 | v2 |
| --- | --- |
| 自建 asyncio 队列 + dispatcher | Temporal workflow/activity |
| zombie recovery 清扫 | Temporal 原生恢复（删除） |
| pg_cron + scheduled_requests 轮询 | Temporal Schedules（删除） |
| LangGraph checkpoint 续跑 | 保留（会话/断点），叠加 run 级 durable 恢复 |
| Phoenix trace | Langfuse（OTEL 端点 + score API） |
| 角色定义 PG 为源头 | Langfuse 为源头，PG 持久缓存兜底 |
| 👍/👎 反馈 | 纠正式反馈闭环为主，打分为辅 |
| 知识 ILIKE/trgm | trgm+pgvector RRF 混合检索，事实时序化 |
