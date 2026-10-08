# agent-platform

内网平台级 Agent 服务：多业务角色、事件触发、对话与自动化流程。
三套环境（prod/test/dev）同代码不同配置，主机部署（无容器）；
环境是启动参数而非部署单元——一套代码按需起停（bwrap 隔离配置）。

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
- **工具分层**：L0 bash（bwrap 沙箱）/ L2 run_code（CodeAct，一次编排多工具）/
  薄工具（sql_query、dingtalk_send、update_asset_profile）/ MCP 桥（内部服务类型化接口）。
- **安全**：systemd 物理收口 + bwrap 沙箱 + 危险模式人工审批（LISTEN/NOTIFY 唤醒）。

## 快速开始

```bash
pip install -e .            # 依赖见 pyproject.toml
python3 -m agent_platform.envrun dev      # 按需启动 dev：bwrap 隔离配置，前台运行
python3 -m agent_platform.envrun dev --print   # 只打印将执行的 bwrap 命令
```

secrets 约定：`/etc/agent-platform/secrets.<env>.env`（KEY=VALUE 行；
本地开发可用 `--secrets-dir` 指向别处）。启动它的会话结束，服务自动结束
（`--die-with-parent`），不留孤儿进程。

Run Viewer：`http://127.0.0.1:8100/runs/{run_id}`；管理页 `/admin`；对话页 `/chat`。

部署：`deploy/install.sh`（装一份代码 + Temporal 共享基建）；
常驻 prod 是可选项，见 `deploy/agent-platform.service`（systemd 收口）。

## 测试

```bash
python3 -m unittest discover -s tests    # 77 个用例；pgserver 不可用时 PG 用例自动跳过
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
conf/                 base/common.yaml（共享默认）+ env/{dev,test,prod}.yaml（只写差异，深合并）
deploy/               systemd unit + install.sh + Dagster MCP 参考实现
sdk/agent_client/     业务方客户端 + agent-chat CLI
tests/                单测 + PG 集成测试
docs/                 设计文档
```
