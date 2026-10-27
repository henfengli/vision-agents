# agent-platform

内网的 agent 平台，装在业务项目（vision-dagster、vision-board、vision-web）实际部署的主机上。

- **项目调 agent**：业务项目通过 HTTP API 或 SDK 请 agent 做事，例如问数据口径、分析报错、跑检查。
- **任务自己跑**：由定时、Dagster 失败、GitLab 部署或网页上点一下触发，无人值守跑完，结果推到钉钉或回调。
- **agent 面对的是线上现场**：读线上正在跑的代码目录、看线上日志（应用、nginx、docker 容器、systemd 单元；可在整个日志文件里按正则搜）
  和主机状况（含本服务的进程、监听端口、crontab、容器资源）、
  查只读库（PostgreSQL / MySQL / Doris / ClickHouse / MongoDB）、在线上用的解释器里跑项目代码（生产的配置换成只读版），
  经 dagster 的 MCP 工具查线上运行、在允许的范围内重跑作业。

部署形态：**同机部署**。平台装在项目的部署主机上，用部署项目的同一个 Linux 用户运行（systemd --user，`deploy/install-user.sh`），
不另起机器、不新建用户、基本不用 root。业务环境是 `prod`（国内生产）和 `test`（国内测试）。每台主机一个 agent 服务，
本机的 `local.yaml` 写它负责哪个环境（`env`）：生产机执行 prod 的运行；test 的项目分在两台测试机上，各装一个，再用 `services` 分。
各台共用一个 PostgreSQL 和一套控制台。模型是 Kimi（月之暗面开放平台，OpenAI 兼容）；账号同时在途的请求最多 3 个（`model.max_concurrency`），各台经库共用。

平台只读，不改线上：不拉代码、不装依赖、不启停业务进程，这些照旧由项目原来的部署流程负责。配置按环境分：生产（受保护）的真实配置
agent 看不到，每个服务的每个配置文件由运维在控制台填一份只读账号的版本，`py` 的项目内核里盖在项目读配置的路径上；测试直接用项目的真实配置，
库只读靠提示词约束。模型写的代码（`bash`、`py`）跑在 bubblewrap 沙箱里（文件只读，home 只露代码目录、解释器环境和方法目录，
生产的配置、平台密钥、docker、systemd 用户总线看不到，独立 pid、ipc 命名空间；网络不限），每个内核（32G）、每条命令（8G）各一个
systemd 用户 scope 限内存，超了只杀它自己；CPU 不设上限。详见部署指南 §5。

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [需求背景](docs/需求背景.md) | 所有人 | 要解决的问题、现场（服务、环境、主机）、需求与约束、不做什么 |
| [设计文档](docs/设计文档.md) | 协作开发者 | 对象模型、关系规则、运行生命周期、代码地图 |
| [外部接口文档](docs/外部接口文档.md) | 调用方 | `/v1` 全部端点、参数、原因码 |
| [SDK开发指南](docs/SDK开发指南.md) | 业务项目 | Python SDK 与 `agent-chat` |
| [部署指南](docs/部署指南.md) | 运维 | 主机与布局、共用的库、安装、密钥、服务定义与给 agent 的配置、日志权限、对外访问、沙箱与资源上限、升级、排障 |

## 一张图

```
入口      API / SDK · 对话（SSE）· 定时（cron × 环境）· 事件（/v1/events/{source}）· 控制台 · 回归重放
提交      Submitter：解析任务 → 服务 → 环境 → 输入校验
          → 闸门链（服务停用 / 服务在该环境停用 / 任务停用 / 环境不允许 / 触发未声明）
          → 去重 →（点名的子任务不存在就建）→ 建台账行（queued）
执行      负责该环境的那台主机上的 worker 从 runs 表认领（按 env / services 过滤、SKIP LOCKED、限并发、心跳）
          → prepare（记配方、档案、召回）→ agent / 内建 / 规则 → finalize（沉淀）→ deliver
agent     按任务的角色装配（langchain create_agent）：平台提示词 + 角色的提示词 + 工具 + 子代理，加上所在服务的 MCP 工具；
          工具绑定这次运行的 服务×环境（py 跑在该环境的项目内核里，里面能直接调其他工具）
主机      每台部署主机一个 agent 服务，local.yaml 写它负责的环境（env）和服务（services）；定时、维护在每台都跑（幂等）
存储      Postgres（各台共用）：定义（带版本，档案在里面）· 平台配置与提示词 · API 密钥 · 运行（配方）与事件（兼执行队列）·
          给 agent 的只读配置（生产，带版本）· 记忆（事实 / 教训 / 交接摘要）· 方法 · 反馈 · 回归重放
控制台    React 单页应用，安装时构建（要 Node），同进程托管；由对外的那台主机提供
```

## 对象

| 对象 | 是什么 |
|---|---|
| 服务 | 一个业务项目（Python）：线上的代码目录与解释器、项目读的配置路径（`configs`，生产在控制台填一份给 agent 的只读版，测试用真实的）、含口令的其他路径（`hidden`，生产只遮蔽）、日志（`logs`）、只读库（`databases`）、地址（`urls`）、服务自己的 MCP 工具、档案，以及在哪些环境启用 |
| 角色 | 能力：系统提示 + 工具 + 可委派的子代理，和服务无关 |
| 任务 | 要做的事：形态（agent / builtin）、输入、触发（api / chat / schedule / event）、投递、记忆开关、档案、可选的结构化输出（`output_schema`）。归属一个服务、通用（`*`）或平台 |
| 子任务 | `任务:对象名`，针对某个资产、某张报表；只存差异，调用时点名不存在就自动建 |
| 平台配置 | 环境（受保护的环境用只读版配置，其余用真实配置）、通知、记忆、平台提示词（设置页） |
| API 密钥 | 调用方身份，只标识是谁、不分权限 |
| 运行 | 一次执行的事实记录：配方（任务、角色、子代理、服务、平台提示词各是第几版）+ 全过程事件（每次模型调用的耗时、token 与思考，工具调用）；runs 表同时是执行队列 |
| 档案 / 记忆 / 方法 | 档案：人写的服务 / 任务 `profile`，逐字置顶注入；记忆：agent 记下的事实、报错教训、会话交接摘要，按服务分区，可对所有环境通用；方法：可执行的做法与脚本 |
| 回归重放 | 改完定义、平台提示词或记忆后，拿过去的 agent 运行（默认被 👎 的，也可以选最近的）用现在的一切重跑：被 👎 的判问题改好没有，没被 👎 的判有没有退步。重放只读，看不到原运行自己沉淀的记忆 |

## 开发

```bash
pip install -e .
export AGENT_ROOT_TOKEN=dev-root AGENT_DB_PASSWORD=... MODEL_TOKEN_A=...   # MODEL_TOKEN_A：Kimi 开放平台的 API key
AGENT_ENV=dev agent-platform check                # 连库、建表、播种
AGENT_ENV=dev agent-platform serve                # http://127.0.0.1:8100（同进程带 worker），用 root token 登录控制台
```

开发机用 `conf/env/dev.yaml`：不写 `env`（单机，执行所有环境的运行），`require_sandbox: false`（没有 bwrap 也让代码跑，不隔离）。
本机要覆盖什么写进 `~/.config/agent-platform/local.yaml`（或用 `AGENT_CONF_LOCAL` 指定路径）。

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
deploy/               install-user.sh 与 user/（agent-platform.service、agent.slice 两个 systemd 用户单元）
mcp_servers/          仓库自带的 MCP server
tests/                unittest
docs/                 文档
```
