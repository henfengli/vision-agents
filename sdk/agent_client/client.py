"""agent-client：服务端 HTTP API 的薄封装（约 50 行，纯转发无逻辑）。

用法：
    from agent_client import AgentClient
    agent = AgentClient(server="board", role="data_searcher")
    answer = agent.ask("3月以来 total_fee 是多少")
    agent.set_session(session_id="board-fee-202610").ask("环比 2 月呢")

配置：AGENT_BASE_URL / AGENT_TOKEN 环境变量，或构造时显式传入。
业务方也可照抄本文件为自己服务内的 agent_client.py 模块——HTTP API 是唯一契约。
"""

from __future__ import annotations

import os
from typing import Any

import httpx


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

    def submit(self, task_type: str, input_data: dict[str, Any]) -> dict:
        """异步任务：立即返回 run_id，用 get_task 轮询或走任务的输出通道。"""
        return self._post("/v1/tasks", {"task_type": task_type,
                                        "input": input_data, "env": self.env})

    def get_task(self, run_id: str) -> dict:
        with self._client() as c:
            return c.get(f"/v1/tasks/{run_id}").json()

    def _post(self, path: str, payload: dict) -> dict:
        with self._client() as c:
            resp = c.post(path, json=payload)
        if resp.status_code != 200:
            raise AgentError(f"{path} 返回 {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self._base, timeout=self._timeout,
                            headers={"Authorization": f"Bearer {self._token}"})
