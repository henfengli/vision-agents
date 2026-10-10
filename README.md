# agent-platform

内网平台级 Agent 服务：多业务角色、事件触发、对话与自动化流程。
**单部署多目标环境**：一套服务操作 prod/test/dev 多套业务环境（请求级 `env`
字段区分），主机 + systemd 部署（无容器）。

## 架构一览

```
触发层    Dagster sensor / GitLab webhook / chat(CLI+Web SSE) / Temporal Schedule / SDK
接入层    FastAPI /v1 + webhook（统一 bearer）/ Viewer（cookie 登录）
编排层    Temporal：任务三形态 = 单 agent / 资产化任务图 / 内建处理器；
          提交闸门链（env_gate → DB 策略）在提交路径上统一收口
agent 层  DeepAgents 装配（roles/engine）+ 人工审批（approvals）+ 工具层（tools）
记忆层    recall（运行前召回）/ distill（运行后沉淀）/ gardener（夜间维护口子）
存储层    Postgres：runs(含定义版本谱系)/run_events/definitions(角色/任务/策略)/
          knowledge/cases/feedback/approvals/artifacts(产物血缘)
观测      Langfuse（prompt 源头 + OTEL trace + score 回写）+ Run Viewer（自托管页面）
通知      钉钉中继（单向只发）
```

源码分层（依赖单向向下）见 `src/agent_platform/__init__.py` 的包注释。

## 核心设计（一句话版）

- **目标环境维度**：`settings.env` 只是实例标签（定义/种子按它存取）；run 操作的
  业务环境由请求 `env` 决定——run 记录、记忆分区、产物复用分区、env_gate 与
  策略 `envs` 过滤、域连接信息（`DomainConfig.envs` 覆盖）全部按它走。
  不配 `target_envs` 即单环境，一切照旧。
- **一切需求归一为任务声明**：新增需求 = Admin API 写一条任务定义，即时生效。
  任务三种形态：单 agent 问答（默认）/ 资产化任务图（artifacts）/ 内建处理器（handler）。
- **资产化任务图**：节点是产物、边是依赖（数据流不是控制流）；动态性只收进
  route（枚举选一）与 map（对上游 list 扇出）两个出口；拓扑分层 + 层内并行；
  输入指纹未变的节点重跑时直接复用旧产物（选择性再物化）。
- **提交闸门链**：DB 声明策略（正则 + order）在提交路径上按序短路——deny 拒绝 /
  require_approval 挂起等审批，批准即启动；与执行期危险命令审批两层互补。
- **域包**：域知识（规则/会话模板/种子任务）住 `conf/domains/<name>/`，
  内核只留机制；业务团队 PR 自己的域包。
- **概念唯一 session_id**：会话由它标识；LangGraph thread 是实现细节，不出 engine 层。
- **episode 会话**：`dagster:{asset}:{error_class}:{date}`，连续性由记忆层承载
  （资产档案逐字保留 → 前序交接摘要四节模板 → 历史知识 RRF 混合检索 → 同类案例）。
- **纠正式反馈**：`POST /v1/sessions/{sid}/feedback` 从 session 最近 run 继承任务上下文
  重判，finalize 时只取代最近一次 run 沉淀的记忆，不误伤历史。
- **工具分层**：L0 bash（bwrap 沙箱：全盘只读/仅 scratch 可写/默认断网——
  出网访问全部收口成薄工具，命令是 LLM 现场拼的，正则审批管不住 API 语义）/
  L2 run_code（CodeAct，一次编排多工具）/
  薄工具（sql_query、host_metrics、dingtalk_send、update_asset_profile）/
  MCP 桥（内部服务类型化接口；browser / datahub 直接用官方实现
  @playwright/mcp、mcp-server-datahub，仓库只自带 dagster server，见 `mcp_servers/`）。
- **安全**：systemd 物理收口 + bwrap 沙箱 + 危险模式人工审批（LISTEN/NOTIFY 唤醒）。

## 快速开始

```bash
pip install -e .            # 依赖见 pyproject.toml
export MODEL_TOKEN_A=... AGENT_DB_PASSWORD=... DINGTALK_ACCESS_TOKEN=... AGENT_BEARER_TOKEN=...
AGENT_ENV=dev uvicorn --factory agent_platform.main:build_app --host 127.0.0.1 --port 8100
```

Run Viewer：总览 `/`（近 24h 聚合仪表盘：状态统计卡 + 最近 Runs + 待审批/
最近失败 + 任务分布）、引擎拓扑 `/graph`（Agent 静态结构，cytoscape 渲染）、
Runs 列表 `/runs`（可按目标环境过滤）、详情 `/runs/{run_id}`
（**Langfuse trace 页整页内嵌**——打开时自动把 trace 设为公开链接免登；
自托管需在 Langfuse 反向代理剥 `X-Frame-Options`/CSP 头，未剥或 Langfuse
未启用时降级为自研执行轨迹图 + 步骤时间线）；**步骤时间线始终渲染，每步
👍👎 节点级反馈**（kind=step 留痕 + 回写 Langfuse——score 直接挂对应
span，等价 Annotate 但走 API 免登录；映射不上降级 trace 级 `step#seq`）；
终态 run 头部带**重跑**按钮（失败 → 同 id 断点续跑，成功 → 同输入新开
run 并跳过去重）、审批待办 `/approvals`
（顶栏「审批」带待办数角标；钉钉卡片 deep-link 直达 `/approvals/{run_id}`
处理页）、管理页 `/admin`、记忆页 `/memory`、对话页 `/chat`（配置了
`target_envs` 时带环境选择器）。

主机监控：配好 `grafana:`（url + Prometheus 数据源 uid + 只读 token）并在域包
`domain.yaml` 登记 `hosts` 后，角色可用 `host_metrics` 工具查部署机器的
内存/负载/根盘（经 Grafana datasource proxy，指标集固定）。既有部署需在
管理页给角色热加该工具。

生产部署：`deploy/install.sh prod`（低权限用户 + systemd 加固）。
Temporal server 见 `deploy/temporal-server.service`。

## 同机业务服务：按需启动（svcrun）

与 agent 同机的业务服务（Dagster、board、配置中心…）几乎只有配置文件不同，
不必按环境各常驻一套。注册进 `conf/services.yaml` 后按需起停：

```bash
python3 -m agent_platform.svcrun --list                 # 看注册表
python3 -m agent_platform.svcrun dagster-webserver test # 前台起 test 环境
python3 -m agent_platform.svcrun board test --print     # 只打印将执行的命令
```

bwrap 把选中环境的配置文件 bind 到服务本来就读的固定路径（服务零改动，
不可能拿错环境），其他环境的配置文件遮蔽为 `/dev/null`；
`--die-with-parent` 保证启动它的会话结束，服务自动结束。

## 测试

```bash
python3 -m unittest discover -s tests    # 105 个用例；pgserver 不可用时 PG 用例自动跳过
```

## SDK（业务方接入）

```python
from agent_client import AgentClient
agent = AgentClient(server="board", role="data_searcher")
print(agent.ask("3月以来 total_fee 是多少"))
```

CLI：`agent-chat --server board --role data_searcher`

## 目录

```
src/agent_platform/   服务源码（分层见包注释）
mcp_servers/          仓库自带的内部 MCP server（stdio）：dagster 报错分析（无现成实现）；
                      browser / datahub 用官方包，settings.mcp_servers 里 npx/uvx 接入
conf/                 base/common.yaml（共享默认）+ env/{dev,test,prod}.yaml（只写差异，深合并）
deploy/               systemd unit + install.sh
sdk/agent_client/     业务方客户端 + agent-chat CLI
tests/                单测 + PG 集成测试
docs/                 设计文档
```
