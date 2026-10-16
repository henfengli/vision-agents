"""agent-client：服务端 HTTP API 的薄封装（纯转发无逻辑）。

用法：
    from agent_client import AgentClient
    agent = AgentClient(server="board", role="data_searcher")
    answer = agent.ask("3月以来 total_fee 是多少")
    agent.set_session(session_id="board-fee-202610").ask("环比 2 月呢")
    run = agent.submit_and_wait("data-qa", {"server": "board", "question": "..."},
                                idempotency_key="fee-202610")

配置：AGENT_BASE_URL / AGENT_TOKEN 环境变量，或构造时显式传入。
业务方也可照抄本文件为自己服务内的 agent_client.py 模块——HTTP API 是唯一契约。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Callable

import httpx

TERMINAL = ("success", "failed", "cancelled")


class AgentError(RuntimeError):
    pass


class AgentClient:
    def __init__(self, server: str, role: str,
                 base_url: str | None = None, token: str | None = None,
                 env: str | None = None, timeout: float = 300.0):
        self.server = server
        self.role = role
        self.env = env                 # 目标业务环境；None = 服务端默认
        self.session_id: str | None = None
        self._base = (base_url or os.environ.get("AGENT_BASE_URL", "")).rstrip("/")
        self._token = token or os.environ.get("AGENT_TOKEN", "")
        self._timeout = timeout
        if not self._base:
            raise AgentError("缺少 base_url：传参或设置 AGENT_BASE_URL")

    def set_session(self, session_id: str) -> "AgentClient":
        """链式指定会话：同 session_id 自动续上下文（服务端 checkpointer 持久化）。"""
        self.session_id = session_id
        return self

    def ask(self, question: str) -> str:
        """同步问答（短任务）。超时未完成时返回提示，可用 run_id 轮询。"""
        data = self._post("/v1/chat", {
            "server": self.server, "role": self.role,
            "question": question, "session_id": self.session_id,
            "env": self.env,
        })
        self.session_id = data.get("session_id", self.session_id)
        output = data.get("output") or {}
        if "answer" in output:
            return output["answer"]
        return data.get("note") or str(output)

    def ask_stream(self, question: str,
                   on_event: Callable[[dict], None] | None = None) -> str:
        """流式问答（/v1/chat/stream，SSE）：on_event 逐事件回调，返回最终回答。

        事件类型：run（拿到 run_id/session_id）/ tool_call / tool_result /
        thought / note / final（终态 + output）/ timeout（超时但 run 还在跑，
        可拿 run_id 用 wait 继续等）。进度展示订阅 on_event 即可。
        """
        answer = ""
        payload = {"server": self.server, "role": self.role,
                   "question": question, "session_id": self.session_id,
                   "env": self.env}
        with self._client() as c:
            with c.stream("POST", "/v1/chat/stream", json=payload) as resp:
                if resp.status_code != 200:
                    raise AgentError(f"/v1/chat/stream 返回 {resp.status_code}: "
                                     f"{resp.read()[:200]!r}")
                for line in resp.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    ev = json.loads(line[6:])
                    if on_event:
                        on_event(ev)
                    t = ev.get("type")
                    if t == "run":
                        self.session_id = ev.get("session_id", self.session_id)
                    elif t == "final":
                        out = ev.get("output") or {}
                        answer = out.get("answer") or str(out)
                    elif t == "timeout":
                        raise AgentError(
                            f"流式等待超时，run {ev.get('run_id')} 仍在执行，"
                            "可用 wait(run_id) 继续轮询")
        return answer

    def submit(self, task_type: str, input_data: dict[str, Any],
               idempotency_key: str | None = None) -> dict:
        """异步任务：立即返回 run_id，用 wait/get_task 轮询或走任务的输出通道。

        idempotency_key：24h 内同键重提返回首个 run（网络重试安全）。
        """
        headers = ({"Idempotency-Key": idempotency_key}
                   if idempotency_key else None)
        return self._post("/v1/tasks", {"task_type": task_type,
                                        "input": input_data, "env": self.env},
                          headers=headers)

    def submit_and_wait(self, task_type: str, input_data: dict[str, Any],
                        timeout: float = 300.0,
                        idempotency_key: str | None = None) -> dict:
        """提交并等到终态，返回 run 视图。待审批时立即返回（不等审批）。"""
        submitted = self.submit(task_type, input_data,
                                idempotency_key=idempotency_key)
        if submitted.get("status") == "awaiting_approval":
            return submitted
        return self.wait(submitted["run_id"], timeout=timeout)

    def wait(self, run_id: str, timeout: float = 300.0,
             interval: float = 2.0) -> dict:
        """轮询直到终态（success/failed/cancelled），返回 run 视图。"""
        deadline = time.monotonic() + timeout
        while True:
            run = self.get_task(run_id)
            if run.get("status") in TERMINAL:
                return run
            if time.monotonic() >= deadline:
                raise AgentError(f"等待 run {run_id} 超时（{timeout}s）")
            time.sleep(interval)

    def get_task(self, run_id: str) -> dict:
        with self._client() as c:
            resp = c.get(f"/v1/tasks/{run_id}")
        if resp.status_code != 200:
            raise AgentError(f"get_task {run_id} 返回 {resp.status_code}: "
                             f"{resp.text[:200]}")
        return resp.json()

    def events(self, run_id: str, after_seq: int = -1) -> list[dict]:
        """run 事件流（after_seq 增量）：观测执行进度用。"""
        with self._client() as c:
            resp = c.get(f"/v1/runs/{run_id}/events",
                         params={"after_seq": after_seq})
        if resp.status_code != 200:
            raise AgentError(f"events {run_id} 返回 {resp.status_code}: "
                             f"{resp.text[:200]}")
        return resp.json()["events"]

    def cancel(self, run_id: str, by: str = "") -> dict:
        """取消运行中/排队中的 run；已终态返回 409。"""
        return self._post(f"/v1/runs/{run_id}/cancel", {"by": by})

    def _post(self, path: str, payload: dict,
              headers: dict | None = None) -> dict:
        with self._client() as c:
            resp = c.post(path, json=payload, headers=headers or {})
        if resp.status_code != 200:
            raise AgentError(f"{path} 返回 {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self._base, timeout=self._timeout,
                            headers={"Authorization": f"Bearer {self._token}"})
