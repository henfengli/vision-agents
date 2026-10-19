# SDK 开发指南

`sdk/` 是平台 HTTP API 的 Python 薄封装（包名 `agent-client`）：纯转发、
零业务逻辑，**HTTP API 才是唯一契约**。其他语言/不想引依赖时，照
`agent_client/client.py`（一个文件、仅依赖 httpx）抄一份即可，接口细节见
`docs/外部接口文档.md`。

## 安装

```bash
# 仓库内
pip install ./sdk

# 已部署的机器上
pip install /opt/agent-platform/sdk

# 零安装：把 sdk/agent_client/client.py 拷进自己项目改名 agent_client.py
#（唯一依赖 httpx）
```

Python ≥ 3.11。当前版本 1.4.0（SDK 版本独立于服务端演进；
服务端 5.x 全部适用）。

## 配置

```bash
export AGENT_BASE_URL=http://127.0.0.1:8100   # 或反代地址
export AGENT_TOKEN=<AGENT_BEARER_TOKEN>
```

也可构造时显式传 `base_url=` / `token=`（显式参数优先于环境变量）。

## 快速开始

```python
from agent_client import AgentClient

agent = AgentClient(server="board", role="data_searcher")

# 1) 同步问答：拿到最终回答字符串
print(agent.ask("3月以来 total_fee 是多少"))

# 2) 会话延续：同 session_id 自动续上下文（服务端持久化，跨天/跨机器可续）
agent.set_session("board-fee-202610")
agent.ask("环比 2 月呢？")          # 记得上一问

# 3) 流式问答：工具调用进度实时回调
answer = agent.ask_stream(
    "巡检今天的增量分区",
    on_event=lambda ev: print(ev["tool"]) if ev["type"] == "tool_call" else None)

# 4) 异步任务：提交 → 等终态 → 拿 run 视图
run = agent.submit_and_wait(
    "data-qa", {"server": "board", "question": "今日 GMV"},
    idempotency_key="gmv-20261016")   # 24h 内同键重提返回首个 run
print(run["status"], run["output"])
```

## API 参考

### 构造

```python
AgentClient(server, role, base_url=None, token=None, env=None, timeout=300.0)
```

| 参数 | 说明 |
|---|---|
| `server` | 业务域（如 `board`/`dagster`），必填 |
| `role` | 角色名（如 `data_searcher`），必填 |
| `env` | 目标业务环境；`None` = 服务端 `default_target_env`。服务端配了 `target_envs` 时取值必须在列表内，否则 400 |
| `timeout` | 单次 HTTP 超时（秒），默认 300 |

### 问答（对话任务）

| 方法 | 语义 | 返回 |
|---|---|---|
| `ask(question) -> str` | 同步问答，等服务端跑完 | 回答文本；超时未完成返回提示（可用返回的 run 续等） |
| `ask_stream(question, on_event=None) -> str` | SSE 流式；`on_event(ev)` 逐事件回调 | 最终回答文本 |

`ask_stream` 事件类型（dict，`ev["type"]`）：

| type | 含义 | 关键字段 |
|---|---|---|
| `run` | run 已创建 | `run_id`、`session_id` |
| `thought` | 模型思考 | `node`、`content` |
| `tool_call` | 工具调用开始 | `node`、`tool`、`args`（截断） |
| `tool_result` | 工具返回 | `node`、`tool`、`output`（截断） |
| `note` | 平台注记（闸门/资产/阶段） | `stage`、`content` |
| `final` | 终态 | `status`、`output` |
| `timeout` | 300s 未完成（run 仍在跑） | `run_id`——SDK 会抛 `AgentError`，可拿 run_id 用 `wait()` 继续等 |

另有 `llm`/`trace`/`graph`/`policy` 等平台内部事件也会出现在事件流里，
消费方按 `type` 白名单取自己关心的即可。

### 会话

```python
agent.set_session("my-session")   # 链式；同 id 续上下文
agent.session_id                  # 当前会话 id（ask/ask_stream 后自动回填）
```

session_id 是会话唯一标识：不指定则服务端生成并在首次应答回填；
纠正反馈（`POST /v1/sessions/{sid}/feedback`）也按它定位。

### 异步任务

| 方法 | 语义 |
|---|---|
| `submit(task_type, input: dict, idempotency_key=None, subtask=None) -> dict` | 立即返回 `{"run_id", "status", ...}`；命中幂等/去重时 `status="dedup_hit"` |
| `wait(run_id, timeout=300.0, interval=2.0) -> dict` | 轮询至终态，返回 run 视图；超时抛 `AgentError` |
| `submit_and_wait(task_type, input, timeout=300.0, idempotency_key=None, subtask=None) -> dict` | 提交 + 等待一体；**待审批立即返回**（`status="awaiting_approval"`，不等审批） |
| `get_task(run_id) -> dict` | 单次查询 run 视图 |
| `events(run_id, after_seq=-1) -> list[dict]` | 事件流增量拉取（观测进度用；每条 `{"seq","kind","payload","created_at"}`） |
| `cancel(run_id, by="") -> dict` | 取消运行中/排队中的 run；已终态抛错（HTTP 409） |

run 视图的 `status`：`queued` / `running` / `awaiting_approval` /
`success` / `failed` / `cancelled`。终态三值是 `success/failed/cancelled`。

run 视图字段：`run_id, session_id, task_type, task_version, role,
role_version, domain, target_env, trigger_source, caller, input, output,
status, tokens, duration_ms, created_at`。

### 幂等与重试

网络重试安全靠 `Idempotency-Key`（24h 窗口）：

```python
run = agent.submit("data-qa", {...}, idempotency_key="fee-20261016-01")
# 同键重提 → 返回首个 run（排队/运行中/成功都命中）；首个失败才允许同键重提
```

任务自身还可配 `dedup_key`/`dedup_window_s`（任务定义里），那是
**业务去重**（同输入不重跑），与调用方幂等键是两层。

## 错误处理

所有失败统一抛 `AgentError`（`RuntimeError` 子类），消息带 HTTP 状态码与
服务端 `detail`：

```python
from agent_client import AgentClient, AgentError

try:
    agent.ask("...")
except AgentError as e:
    ...   # "…返回 429: 服务繁忙，请稍后重试" / "…400: 未知任务 xxx" / 超时提示
```

| 场景 | HTTP | 说明 |
|---|---|---|
| 并发打满 | 429 `overloaded` | 稍候重试 |
| 未知任务/闸门拒绝/终态冲突 | 400 `task_rejected` | 客户端错误，重试无用 |
| 目标环境不在白名单 | 400 | 换 `env` 值 |
| 鉴权失败 | 401 | 检查 `AGENT_TOKEN` |
| 参数不合法 | 422 | 按 `detail` 修请求 |
| 流式 300s 未完成 | （异常消息含 run_id） | run 没死，`wait(run_id)` 续等 |

## CLI：agent-chat

装 SDK 即得交互式对话命令（走 SSE，工具调用实时可见）：

```bash
agent-chat --server board --role data_searcher
agent-chat --server board --role data_searcher --env prod        # 指定目标环境
agent-chat --server board --role data_searcher --resume board-fee-a1b2  # 续会话
```

输出里 `[session: xxx]` 是会话 id，记下来可 `--resume` 续聊。

## 常见问题

- **ask 返回"超时"提示但没报错**：同步路径等的时间有限，run 还在跑；
  用 `submit_and_wait`（可控 timeout）或拿 run_id `wait()` 续等。
- **多线程/多并发**：`AgentClient` 无共享状态（每请求新建 httpx.Client），
  可安全并发使用；但同 session 的问答请串行（会话上下文有顺序）。
- **想看中间过程**：`ask_stream(on_event=...)`，或事后
  `events(run_id)` 拉全量事件流。
- **嵌入自己服务**：直接把 `client.py` vendor 进去即可，类名/方法随意改——
  只要不破坏 HTTP 契约。
