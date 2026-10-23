# agent-platform

内网的 agent 平台，和若干业务项目（vision-dagster、vision-board、vision-web）部署在同一台机器上。

- **项目调 agent**：业务项目通过 HTTP API 或 SDK 请 agent 做事，例如问数据口径、分析报错、跑检查。
- **任务自己跑**：由定时、Dagster 失败、GitLab 部署或网页上点一下触发，无人值守跑完，结果推到钉钉或回调。
- **agent 能碰到项目本身**：读部署目录和代码、读对应环境的配置、查只读库（PostgreSQL / MySQL / Doris / ClickHouse / MongoDB）、
  在该环境的项目 Python 里直接跑项目代码，需要长驻时按环境起进程。

部署形态：单部署、主机 + systemd、不用容器，外部依赖只有 PostgreSQL。一套服务操作所有项目的 prod / test / dev。
平台和它起的业务进程都以一个普通用户运行（systemd --user，`deploy/install-user.sh`）。
模型是 Kimi（月之暗面开放平台，OpenAI 兼容）；账号限并发 1、3 RPM，平台侧排队。

业务项目在这台机器上是**本机副本**：每个服务、每个环境一份代码（`/srv/svc/<服务>/code/<环境>`，都跟踪 master：
代码跟踪发现远端有新提交就由内建任务 `code-sync` 对齐、按变更装依赖等），每个项目一个 conda 环境（各环境共用），
加该环境的配置文件（`/srv/svc/<服务>/conf/<环境>`，可在控制台改）。agent 经 `service_info` 读本环境打码后的配置，
用 `db_query` 查本环境的只读库，用 `py` 在本环境的项目 Python 里 import 项目模块、调项目自己的函数；需要长驻时才起进程（带租约，用完停）。
拉代码、装依赖、改配置都由平台进程做，agent 的沙箱和内核只读。

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [设计文档](docs/设计文档.md) | 协作开发者 | 对象模型、关系规则、运行生命周期、代码地图 |
| [外部接口文档](docs/外部接口文档.md) | 调用方 | `/v1` 全部端点、参数、原因码 |
| [SDK开发指南](docs/SDK开发指南.md) | 业务项目 | Python SDK 与 `agent-chat` |
| [部署指南](docs/部署指南.md) | 运维 | 安装、密钥、业务代码与配置、只读库、反代、进程启停、升级、排障 |

## 一张图

```
入口      API / SDK · 对话（SSE）· 定时（cron × 环境）· 事件（/v1/events/{source}）· 控制台 · 代码跟踪 · 回归重放
提交      Submitter：解析任务 → 服务 → 环境 → 输入校验
          → 闸门链（服务停用 / 服务在该环境停用 / 任务停用 / 环境不允许 / 触发未声明）
          → 去重 →（点名的子任务不存在就建）→ 建台账行（queued）
执行      worker 从 runs 表认领（SKIP LOCKED、限并发、心跳）
          → prepare（记配方、档案、召回）→ agent / 内建 / 规则 → finalize（沉淀）→ deliver
agent     按任务的角色装配（langchain create_agent）：平台提示词 + 角色的提示词 + 工具 + 子代理，加上所在服务的 MCP 工具；
          工具绑定这次运行的 服务×环境（py 跑在该环境的项目内核里，里面能直接调其他工具）
存储      Postgres：定义（带版本，档案在里面）· 平台配置与提示词 · API 密钥 · 运行（配方）与事件（兼执行队列）· 进程实例 · 记忆（事实 / 教训 / 交接摘要）· 方法 · 反馈 · 回归重放 · 同步记账
控制台    React 单页应用，随 Python 包发布，同进程托管
```

## 对象

| 对象 | 是什么 |
|---|---|
| 服务 | 一个业务项目（Python）：各环境代码（git 仓库 + 跟踪分支 + 同步步骤）、解释器、各环境配置文件（可声明仓库里的上游模板）、只读库（`databases`）、进程、地址（`urls`）、服务自己的 MCP 工具、档案，以及在哪些环境启用 |
| 角色 | 能力：系统提示 + 工具 + 可委派的子代理，和服务无关 |
| 任务 | 要做的事：形态（agent / builtin）、输入、触发（api / chat / schedule / event）、投递、记忆开关、档案、可选的结构化输出（`output_schema`）。归属一个服务、通用（`*`）或平台 |
| 子任务 | `任务:对象名`，针对某个资产、某张报表；只存差异，调用时点名不存在就自动建 |
| 平台配置 | 环境（受保护只是标记）、通知、记忆、进程默认值、平台提示词（设置页） |
| API 密钥 | 调用方身份，只标识是谁、不分权限 |
| 运行 | 一次执行的事实记录：配方（任务、角色、子代理、服务、平台提示词各是第几版）+ 全过程事件（每次模型调用的耗时、token 与思考，工具调用）；runs 表同时是执行队列 |
| 档案 / 记忆 / 方法 | 档案：人写的服务 / 任务 `profile`，逐字置顶注入；记忆：agent 记下的事实、报错教训、会话交接摘要，按服务分区，可对所有环境通用；方法：可执行的做法与脚本 |
| 回归重放 | 改完定义或平台提示词后，拿被 👎 的运行用当前定义重跑，模型判定问题改好没有 |

## 开发

```bash
pip install -e .
export AGENT_ROOT_TOKEN=dev-root AGENT_DB_PASSWORD=... MODEL_TOKEN_A=...   # MODEL_TOKEN_A：Kimi 开放平台的 API key
AGENT_ENV=dev agent-platform check                # 连库、建表、播种
AGENT_ENV=dev agent-platform serve                # http://127.0.0.1:8100（同进程带 worker），用 root token 登录控制台
AGENT_ENV=dev agent-platform worker               # 可选：serve --no-worker 时单独跑执行队列、定时、代码跟踪、维护循环
```

测试（不需要 PG）：

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

agent = AgentClient(service="vision-board", env="test")   # AGENT_URL / AGENT_KEY
agent.ask("离线 HTML 导出是怎么实现的，依赖什么")             # 对话，自动续会话；服务没有专属对话任务时用通用入口 ask
agent.run("failure-analysis", {...}, service="vision-dagster", subtask=asset_key, env="prod")
```

```bash
curl -X POST $AGENT_URL/v1/runs -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \
  -d '{"task":"data-qa","service":"vision-board","env":"test","input":{"question":"报表页面的数据来自 ck 库的哪几张表"},"wait":120}'

# 不带 task 就是通用入口 ask：任何服务任何环境直接提问或交代一件事，不用先建任务
curl -X POST $AGENT_URL/v1/runs -H "Authorization: Bearer $AGENT_KEY" -H 'Content-Type: application/json' \
  -d '{"service":"vision-dagster","env":"prod","input":{"question":"昨天哪些资产物化失败了，原因是什么"},"wait":300}'
```

## 目录

```
src/agent_platform/   服务源码（地图见设计文档 §8）
web/                  控制台源码
sdk/agent_client/     Python SDK + agent-chat
conf/                 部署配置（base + env 差异）与种子（只在库里没有时播种）
deploy/               install-user.sh 与 user/（systemd 用户单元）
mcp_servers/          仓库自带的 MCP server
tests/                unittest
docs/                 文档
```
