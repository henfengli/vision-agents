# SDK 开发指南

`sdk/agent_client` 是 `/v1` 接口的 Python 薄封装（包名 `agent-client`，版本 2.x，对应服务端 v6）。
它只做转发，不含业务逻辑，**HTTP 接口才是唯一契约**。

其他语言的项目、或不想多一个依赖的项目，照着 `agent_client/client.py` 抄一份即可：一个文件，
只依赖 httpx。接口细节见 `docs/外部接口文档.md`。

## 安装

```bash
pip install ./sdk                        # 仓库里
pip install /opt/agent-platform/sdk      # 已部署的机器上
# 零安装：把 sdk/agent_client/client.py 拷进自己的项目
```

需要 Python ≥ 3.11。

## 配置

```bash
export AGENT_URL=https://agent.internal      # 或 http://127.0.0.1:8100
export AGENT_KEY=ak_xxx                      # 设置 → API 密钥 里给这个项目建的那把
```

也可以在构造时显式传 `url=`、`key=`，显式参数优先于环境变量。

建议每个项目一把密钥，名字用项目名（如 `board-backend`）。这样运行记录里的「发起方」一眼能看出是谁调的；
需要时，还可以把这把密钥限定在自己的服务和环境上。

## 快速开始

```python
from agent_client import AgentClient, AgentError

agent = AgentClient(service="board", env="test")

# 1) 对话：用服务的对话任务；同一个 client 自动续会话
print(agent.ask("3 月以来 total_fee 是多少"))
print(agent.ask("环比 2 月呢"))             # 记得上一问
agent.ask("换个话题", new_session=True)     # 另起一段

# 2) 任务：等到结束，返回运行详情
run = agent.run("frontend-smoke", {"version": "1.2.0"})
print(run["status"], run["output"])

# 3) 针对某个对象跑（子任务不存在会自动建，档案在控制台补）
run = agent.run("failure-analysis", {"run_id": "8f2c", "asset_key": "dwd_trade_order", "error": "…"},
                subtask="dwd_trade_order", env="prod", wait=False)
print(run["run_id"], run["subtask_created"])
```

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

每个方法也都能单独指定 `service` / `env`，覆盖构造时的默认值。

### 对话

```python
agent.ask(message, *, task=None, new_session=False, on_event=None, **input_fields) -> str
```

- 返回回答文本。运行没有成功结束时抛 `AgentError`，`code` 为 `run_failed` / `run_cancelled`。
- 默认续上一轮的会话，当前会话 id 在 `agent.session_id`；也可以手动赋值，续一个已有会话。
- `task` 不传时，用该服务声明了 `chat` 触发的任务。
- `on_event(ev)` 可以订阅执行过程，`ev["type"]` 取值：`stage`、`thought`、`tool_call`、`tool_result`、`approval`。
- `**input_fields` 是对话任务的其他输入字段。

### 任务

```python
agent.run(task, input=None, *, subtask=None, service=None, env=None, wait=True,
          idempotency_key=None, recall=None, save=None) -> dict
```

| 参数 | 说明 |
|---|---|
| `wait` | `True` 等到结束；传数字表示最多等这么多秒；`False` 立即返回回执 |
| `subtask` | 对象名；不存在时按父任务自动创建 |
| `idempotency_key` | 网络重试安全：同一个键只受理一次 |
| `recall` / `save` | 这一次的记忆开关；`None` 表示跟随任务和平台默认 |

`run` 的返回值有两种形状：

- 等到了结束：返回运行详情，包含 `status`、`output`、`context` 等，字段见接口文档 §2。
- `wait=False`，或运行在等审批：立即返回回执 `{run_id, session_id, status, output, dedup, subtask_created, approval_id}`。

| 方法 | 说明 |
|---|---|
| `get(run_id)` | 运行详情 |
| `wait(run_id, timeout=None)` | 轮询到终态或超时，返回运行详情 |
| `events(run_id, after=0)` | 过程事件增量拉取 |
| `cancel(run_id)` | 取消 |
| `rerun(run_id)` | 同样的输入新开一次运行 |
| `resume(run_id)` | 失败的运行从断点续跑 |
| `correct(run_id, text)` | 纠正结论：同会话重答，纠正内容沉淀为人工知识 |
| `feedback(run_id, score, comment="")` | 评价：`1` 有用 / `-1` 没帮助 |

### 事件

```python
agent.emit("webhook", {"service": "board", "env": "test", "version": "1.2.0"}, event="release")
```

把事件推给平台（`POST /v1/events/{source}`），返回匹配到的任务及其运行。
声明了这个 `source + event` 触发器的任务才会被触发。

## 幂等与去重

- **幂等键**由调用方提供，解决网络重试的问题：同一个键只受理一次，重复提交返回同一个运行（`dedup: true`）。
- **任务去重**写在任务定义里（`dedup: {key, window_s}`），解决业务重复：时间窗内同键的成功运行直接复用结果。

两者是独立的两层。

## 错误处理

所有失败都抛 `AgentError`。按 `e.code` 判断原因，不要解析 `e.message`：

```python
try:
    agent.run("frontend-smoke", {"version": "1.2.0"}, env="prod")
except AgentError as e:
    if e.code == "service_env_disabled":
        ...                      # 服务在 prod 停用了
    elif e.code == "policy":
        print(e.detail["policy"])
    else:
        raise
```

| e.code | 含义 | 该怎么办 |
|---|---|---|
| `unauthorized` | 密钥无效 / 吊销 / 过期 | 检查 `AGENT_KEY` |
| `forbidden` | 密钥不允许这个服务或环境 | 换密钥，或让管理员放宽范围 |
| `service_required` | 通用任务没指定服务 | 传 `service` |
| `invalid_input` | 输入不合法 | 看 `e.detail["fields"]` |
| `service_disabled` / `service_env_disabled` / `task_disabled` | 停用 | 控制台启用，或换环境 |
| `env_not_allowed` | 任务不能在这个环境跑 | 换环境 |
| `trigger_not_allowed` | 任务没开放 API 调用 | 在任务定义里加 `api` 触发 |
| `policy` | 命中拒绝策略 | 改输入，或找管理员 |
| `unknown_task` / `unknown_service` / `unknown_env` | 名字写错 | — |
| `run_failed` / `run_cancelled` | `ask` 的运行没有成功结束 | 去控制台看运行详情 |

命中 `require_approval` 策略**不抛错**：`run()` 立即返回 `status="awaiting_approval"` 的回执，
放行后运行自动开始，之后用 `wait(run_id)` 等结果。

## 命令行：agent-chat

装好 SDK 就有这个命令。过程实时可见，会话存在服务端，跨天、跨机器都能续：

```bash
agent-chat board                        # 默认环境
agent-chat board --env prod
agent-chat board --task data-qa
agent-chat board --resume <会话 id>
```

## 常见问题

- **想看中间过程**：`ask(on_event=...)`，或者事后 `events(run_id)` 拉全量事件。
- **并发**：同一个 `AgentClient` 的 `ask` 会续同一个会话，并发提问请用不同的实例。
- **嵌入自己的服务**：直接把 `client.py` 拷进去，类名和方法名随意改，只要不破坏 HTTP 契约。
