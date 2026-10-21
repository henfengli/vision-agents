# agent-platform

内网的 agent 平台，和若干业务项目（Dagster、board、配置中心等）部署在同一台机器上。

- **项目调 agent**：业务项目通过 HTTP API 或 SDK 请 agent 做事，例如问数据口径、分析报错、跑检查。
- **任务自己跑**：由定时、Dagster 失败、GitLab 部署或网页上点一下触发，无人值守跑完，结果推到钉钉或回调。
- **agent 能碰到项目本身**：读部署目录和代码、读对应环境的配置、查只读库、按环境启停进程来复现问题。

部署形态：单部署、主机 + systemd、不用容器。一套服务操作所有项目的 prod / test / dev。
系统级（root，`deploy/install.sh`）和用户级（普通用户 + systemd --user，`deploy/install-user.sh`）两种装法。

业务项目在这台机器上是**本机副本**：每个服务、每个环境一份代码（`/srv/svc/<服务>/code/<环境>`，
内建任务 `code-sync` 按环境切到部署的版本）加该环境的配置文件（`/srv/svc/<服务>/conf/<环境>`）。
agent 能读代码、经 `service_info` 读本环境打码后的配置、查只读库；能不能起进程按环境单独管，
生产出厂「只看不起」——用生产配置起一份副本会真的连生产库、跑生产调度。

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [设计文档](docs/设计文档.md) | 协作开发者 | 对象模型、关系规则、运行生命周期、代码地图 |
| [外部接口文档](docs/外部接口文档.md) | 调用方 | `/v1` 全部端点、参数、原因码 |
| [SDK开发指南](docs/SDK开发指南.md) | 业务项目 | Python SDK 与 `agent-chat` |
| [部署指南](docs/部署指南.md) | 运维 | 安装、密钥、反代、进程启停、升级、排障 |

## 一张图

```
入口      API / SDK · 对话（SSE）· 定时（cron × 环境）· 事件（/v1/events/{source}）· 控制台
提交      Submitter：解析任务（子任务自动建）→ 服务 → 环境 → 调用方权限 → 输入校验
          → 闸门链（服务停用 / 服务在该环境停用 / 任务停用 / 环境不允许 / 触发未声明 / 策略）
          → 去重 → 建台账 → 审批或启动
执行      Temporal RunWorkflow：prepare（档案、召回）→ agent / 任务图 / 内建 / 规则 → finalize（沉淀）→ deliver
agent     按任务的角色装配：角色的提示词 + 工具白名单；工具绑定这次运行的 服务×环境
存储      Postgres：定义（带版本）· API 密钥 · 运行与事件 · 审批 · 进程实例 · 知识 / 案例 / 方法 · 反馈
控制台    React 单页应用，随 Python 包发布，同进程托管
```

## 对象

| 对象 | 是什么 |
|---|---|
| 服务 | 一个业务项目：各环境代码（git 仓库 + 跟踪分支）、各环境配置文件、只读库、进程、档案，以及在哪些环境启用、能不能起进程 |
| 角色 | 能力：系统提示 + 工具白名单，和服务无关 |
| 任务 | 要做的事：输入、触发（api / chat / schedule / event）、投递、记忆开关、档案。归属一个服务、通用（`*`）或平台 |
| 子任务 | `任务:对象名`，针对某张表、某条链路；只存差异，调用时点名不存在就自动建 |
| 策略 | 提交前的输入闸门：拒绝或需审批 |
| 平台配置 | 环境（含受保护、只看不起）、审批、通知、记忆、进程默认值（设置页） |
| API 密钥 | 调用方身份；`run` / `admin` 两种范围，可限定服务与环境 |
| 运行 | 一次执行的事实记录，钉死定义版本，全过程可回放 |
| 记忆 | 知识（事实）· 案例（教训）· 方法（做法），按 服务×环境 分区 |

## 开发

```bash
pip install -e .
export AGENT_ROOT_TOKEN=dev-root AGENT_DB_PASSWORD=... MODEL_TOKEN_A=...
temporal server start-dev &                       # 本地 Temporal
AGENT_ENV=dev agent-platform check                # 连库、建表、播种
AGENT_ENV=dev agent-platform serve                # http://127.0.0.1:8100，用 root token 登录控制台
```

测试（不需要 PG / Temporal）：

```bash
python -m unittest discover -s tests
```

控制台前端：

```bash
cd web && npm ci
npm run dev:mock        # 带 mock 数据的开发服务器，不需要后端
npm run build           # 产物写到 src/agent_platform/webui/dist
npm run build:preview   # 单文件预览（mock 数据）：web/dist-preview/index.html
```

## 调用

```python
from agent_client import AgentClient

agent = AgentClient(service="board", env="test")       # AGENT_URL / AGENT_KEY
agent.ask("3 月以来 total_fee 是多少")                   # 对话，自动续会话
agent.run("failure-analysis", {...}, subtask="dwd_trade_order", env="prod")
```

```bash
curl -X POST $AGENT_URL/v1/runs -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \
  -d '{"task":"data-qa","service":"board","env":"test","input":{"question":"7 天留存怎么算"},"wait":120}'
```

## 目录

```
src/agent_platform/   服务源码（地图见设计文档 §8）
web/                  控制台源码
sdk/agent_client/     Python SDK + agent-chat
conf/                 部署配置（base + env 差异）与种子（只在库里没有时播种）
deploy/               systemd 单元、polkit 规则、install.sh（系统级）；user/ + install-user.sh（用户级）
mcp_servers/          仓库自带的 MCP server
scripts/migrate_v5.py 从 v5 迁移
tests/                unittest
docs/                 文档
```
