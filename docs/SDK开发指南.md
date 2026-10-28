# SDK 开发指南

`sdk/agent_client` 是 `/v1` 接口的 Python 薄封装（包名 `agent-client`，版本 2.x，对应服务端 v9）。
它只做转发，不含业务逻辑，**HTTP 接口才是唯一契约**。

其他语言的项目、或不想多一个依赖的项目，照着 `agent_client/client.py` 抄一份即可：一个文件，
只依赖 httpx。接口细节见 `docs/外部接口文档.md`。

## 安装

```bash
pip install ./sdk                        # 仓库里（已部署的机器上也用仓库里的：安装脚本不拷 sdk）
# 零安装：把 sdk/agent_client/client.py 拷进自己的项目
```

需要 Python ≥ 3.11。

## 配置

```bash
export AGENT_URL=https://agent.internal      # 或 http://127.0.0.1:8100
export AGENT_KEY=ap_xxx                      # 设置 → API 密钥 里给这个项目建的那把
```

也可以在构造时显式传 `url=`、`key=`，显式参数优先于环境变量。

建议每个项目一把密钥，名字用项目名（如 `vision-board`）。这样运行记录里的「发起方」一眼能看出是谁调的。
密钥只标识身份、不分权限，有效密钥能调全部接口，别外传。

## 快速开始

```python
from agent_client import AgentClient, AgentError

agent = AgentClient(service="vision-board", env="test")

# 1) 对话：用服务的对话任务（没有专属的就用通用入口 ask）；同一个 client 自动续会话
print(agent.ask("报表页面的数据来自 ck 库的哪几张表"))
print(agent.ask("其中哪张表昨天没有新数据"))    # 记得上一问
agent.ask("换个话题", new_session=True)         # 另起一段

# 2) 任务：等到结束，返回运行详情
run = agent.run("frontend-smoke", {"version": "1.2.0"})
print(run["status"], run["output"])

# 3) 针对某个对象跑（子任务不存在会自动建，档案在控制台补）；failure-analysis 是 vision-dagster 的任务
run = agent.run("failure-analysis", {"run_id": run_id, "asset_key": asset_key, "error": error},
                service="vision-dagster", subtask=asset_key, env="prod", wait=False)
print(run["run_id"], run["subtask_created"])
```

一次 agent 运行要多次调模型和工具，可能要几分钟；`ask` 和 `run()`（默认 `wait=True`）会一直等到结束。

## API 参考

### 构造

```python
AgentClient(service=None, env=None, *, url=None, key=None, timeout=330.0)
```

| 参数 | 说明 |
|---|---|
| `service` | 默认操作的服务。专属任务可以不传；通用任务和对话需要传 |
| `env` | 默认环境；`None` 表示用平台默认环境（出厂是 `test`，所以生产必须显式写） |
| `url` / `key` | 不传就读 `AGENT_URL` / `AGENT_KEY` |
| `timeout` | 单次 HTTP 超时（秒） |

`ask` 和 `run` 都能按次传 `service` / `env`，覆盖构造时的默认值。专属任务传了别的服务会被拒（`service_not_allowed`），
所以调别的服务的任务时按次传它的 `service`。

### 对话

```python
agent.ask(message, *, task=None, subtask=None, service=None, env=None, new_session=False,
          recall=None, save=None, on_event=None, **input_fields) -> str
```

- 返回回答文本。运行没有成功结束时抛 `AgentError`，`code` 为 `run_failed` / `run_cancelled`；推流在运行结束前断开时 `code` 为
  `stream_broken`（运行可能还在跑，`message` 里有 run id，用 `get` / `wait` 查结果）。
- 默认续上一轮的会话，当前会话 id 在 `agent.session_id`；也可以手动赋值，续一个已有会话。续会话时没传的 `task`、`service`、`env`
  由服务端沿用上一轮。
- `task` 不传时，该服务专属的对话任务（声明了 `chat` 触发）优先，没有就用通用入口 `ask`；`subtask` 选用子任务（不存在会按父任务自动建）。
- `recall` / `save` 按次覆盖记忆开关，`None` 表示跟随任务与平台默认。
- `on_event(ev)` 可以订阅执行过程，`ev["type"]` 取值：`stage`、`model_call`（每次模型调用：耗时、token、调了哪些工具、思考）、`tool_call`、`tool_result`。子代理里发生的带 `agent` 字段。
- `**input_fields` 是对话任务的其他输入字段。

### 任务

```python
agent.run(task, input=None, *, subtask=None, service=None, env=None, wait=True,
          idempotency_key=None, recall=None, save=None, after=None) -> dict
```

| 参数 | 说明 |
|---|---|
| `wait` | `True` 等到结束；传数字表示最多等这么多秒；`False` 立即返回回执 |
| `subtask` | 对象名；不存在时按父任务自动创建 |
| `idempotency_key` | 网络重试安全：同一个键只受理一次 |
| `recall` / `save` | 这一次的记忆开关；`None` 表示跟随任务和平台默认 |
| `after` | 点名等的上游运行 id 列表（最多 20 个）：先排队，都成功了才执行；有一个失败或取消，这次不执行（`error_code: upstream_failed`） |

按依赖串几步（A、B 都成功后跑 C）：

```python
a = agent.run("daily-inspection", env="test", wait=False)
b = agent.run("frontend-smoke", env="test", wait=False)
c = agent.run("release-report", {"version": "e5f6a7b"}, env="test", after=[a["run_id"], b["run_id"]])   # 等到 C 结束
```

每次都这么串的，在控制台给下游任务加「上游任务结束后」触发（上游联动），不用调用方自己串。

SDK 的 `task` 必填。不想先建任务时用通用入口：`agent.run("ask", {"question": "…"})`（HTTP 接口不写 `task` 就是 `ask`）。

`run` 的返回值有两种形状：

- 等到了结束（或等到了 `wait` 秒数）：返回运行详情，包含 `status`、`output`、`recipe`（配方：这次用的各定义版本）、`context` 等，字段见接口文档 §2。
  任务声明了 `output_schema` 时，校验过的结构化结果在 `output["data"]`（`output["answer"]` 仍是文字结论）；
  agent 没交回合规结果的运行以 `error_code: invalid_output` 失败。
- `wait=False`：立即返回回执 `{run_id, session_id, status, output, dedup, subtask_created}`。

| 方法 | 说明 |
|---|---|
| `get(run_id)` | 运行详情 |
| `wait(run_id, timeout=None)` | 轮询到终态或超时，返回运行详情 |
| `events(run_id, after=0)` | 过程事件增量拉取 |
| `cancel(run_id)` | 取消 |
| `rerun(run_id)` | 同样的输入新开一次运行 |
| `resume(run_id)` | 失败的运行从断点续跑（如 `interrupted`、`orphaned`、`step_limit`） |
| `correct(run_id, text)` | 纠正结论：同会话重答，成功后取代被纠正那一轮沉淀的记忆；运行没结束、会话里还有一轮在跑时 409 |
| `feedback(run_id, score, *, reasons=None, comment="")` | 评价：`1` 有用 / `-1` 有问题；`reasons` 取值见 `/v1/meta` 的 `feedback_reasons`；同一把密钥再评即覆盖 |
| `graph()` | 任务图：`{nodes, edges}`，边是上游联动（上游结束 → 下游） |
| `ticks(*, task=None, kind=None, outcome=None, env=None, hours=None, limit=100)` | 触发记录：定时 / 事件 / 联动 / 自动重试每次判定建了哪条运行、为什么没建（`outcome` 如 `fired` `filtered` `rejected` `unmatched`）。排查「为什么没跑」先看它 |

运行详情里和调度有关的几项：`attempt`（第几次执行，续跑 / 自动重试 +1）、`retry_at`（失败了、等着在这个时刻自动重试；
这时 `status` 是 `failed` 但还不是最终结果，`run(wait=True)` / `wait()` 会接着等重试的结果，传了超时就等到超时为止）、
`lineage`（触发它的上游运行、它点名等的、它引出的）、`queue`（排队中才有：在等哪个上游、任务并发、有没有在线主机负责、`since` 这次进队列的时刻）。

### 事件

```python
agent.emit("webhook", {"service": "vision-board", "env": "test", "version": "1.2.0"}, event="release")
```

把事件推给平台（`POST /v1/events/{source}`），返回匹配到的任务及其运行。
声明了这个 `source + event` 触发器的任务才会被触发。

## 幂等与去重

- **幂等键**由调用方提供，解决网络重试的问题：同一个键只受理一次，重复提交返回同一个运行（`dedup: true`）。
  键最长 200 个字符，不限时间；只有失败的运行会释放这个键（定时触发的除外）。
- **任务去重**写在任务定义里（`dedup: {key, window_s}`），解决业务重复：时间窗内同键、还在排队 / 运行中或已成功的运行直接返回它。

两者是独立的两层。

## 错误处理

所有失败都抛 `AgentError`。按 `e.code` 判断原因，不要解析 `e.message`：

```python
try:
    agent.run("frontend-smoke", {"version": "1.2.0"}, env="prod")
except AgentError as e:
    if e.code == "service_env_disabled":
        ...                      # 服务在 prod 停用了
    elif e.code == "env_not_allowed":
        ...                      # 任务不能在 prod 跑
    else:
        raise
```

| e.code | 含义 | 该怎么办 |
|---|---|---|
| `unauthorized` | 密钥无效 / 吊销 / 过期 | 检查 `AGENT_KEY` |
| `service_required` | 通用任务没指定服务 | 传 `service` |
| `service_not_allowed` | 专属任务传了别的服务 | 按次传任务所属的 `service` |
| `invalid_input` | 输入不合法 | 看 `e.detail["fields"]` |
| `service_disabled` / `service_env_disabled` / `task_disabled` | 停用 | 控制台启用，或换环境 |
| `env_not_allowed` | 任务不能在这个环境跑 | 换环境 |
| `trigger_not_allowed` | 任务没开放 API 调用 | 在任务定义里加 `api` 触发 |
| `unknown_task` / `unknown_service` / `unknown_env` | 名字写错 | — |
| `run_failed` / `run_cancelled` | `ask` 的运行没有成功结束 | 去控制台看运行详情 |
| `stream_broken` | `ask` 的推流在运行结束前断开，运行可能还在跑 | 按 `message` 里的 run id 用 `wait` 取结果 |

## 命令行：agent-chat

装好 SDK 就有这个命令。过程实时可见，会话存在服务端，跨天、跨机器都能续：

```bash
agent-chat vision-board                        # 默认环境
agent-chat vision-board --env prod
agent-chat vision-board --task data-qa
agent-chat vision-board --resume <会话 id>
```

## 常见问题

- **想看中间过程**：`ask(on_event=...)`，或者事后 `events(run_id)` 拉全量事件。
- **并发**：同一个 `AgentClient` 的 `ask` 会续同一个会话，并发提问请用不同的实例。并发多了也快不了：模型账号同时只放 3 个请求，
  prod、test 所有调用共用，多出来的在平台侧排队。
- **运行一直 `queued`**：先看运行详情的 `queue`——`waiting_for` 不空是在等你点名的上游；`concurrency` 满了是任务的同时执行上限；
  `hosts` 为空是负责这个环境的 agent 服务没在跑（平台照常受理，等它起来后接着执行，控制台概览的「执行主机与排队」能看到）。
  持续出现就找平台负责人看那台机器上的 `agent-platform`。
- **嵌入自己的服务**：直接把 `client.py` 拷进去，类名和方法名随意改，只要不破坏 HTTP 契约。
