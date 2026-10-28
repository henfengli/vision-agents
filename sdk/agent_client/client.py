"""agent-client：/v1 接口的薄封装。HTTP 接口是唯一契约，项目里也可以照抄这一个文件。

    from agent_client import AgentClient

    agent = AgentClient(service="vision-board", env="test")    # AGENT_URL / AGENT_KEY 环境变量
    agent.ask("3 月以来 total_fee 是多少")                       # 对话：服务的对话任务；同一个对象自动续会话
    agent.ask("环比 2 月呢")
    run = agent.run("frontend-smoke", {"version": "1.2.0"})     # 任务：等到结束，返回运行详情
    run = agent.run("failure-analysis", {...}, subtask="ods_orders", wait=False)   # 只提交

出错抛 AgentError，e.code 是服务端的原因码（如 task_disabled、service_env_disabled、trigger_not_allowed）。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx

TERMINAL = ("success", "failed", "cancelled")


class AgentError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, detail: Any = None):
        super().__init__(f"[{code}] {message}")
        self.status, self.code, self.message, self.detail = status, code, message, detail


class AgentClient:
    def __init__(self, service: str | None = None, env: str | None = None, *, url: str | None = None,
                 key: str | None = None, timeout: float = 330.0):
        """service / env：这个客户端默认操作的服务和环境（每次调用也可以单独指定）。"""
        self.service = service
        self.env = env
        self.session_id: str | None = None
        base = (url or os.environ.get("AGENT_URL", "")).rstrip("/")
        if not base:
            raise ValueError("缺少服务地址：传 url= 或设置 AGENT_URL")
        self._http = httpx.Client(base_url=base, timeout=timeout,
                                  headers={"Authorization": f"Bearer {key or os.environ.get('AGENT_KEY', '')}"})

    # —— 对话 ——

    def ask(self, message: str, *, task: str | None = None, subtask: str | None = None,
            service: str | None = None, env: str | None = None, new_session: bool = False,
            recall: bool | None = None, save: bool | None = None,
            on_event: Callable[[dict], None] | None = None, **input_fields: Any) -> str:
        """发一条消息，返回回答。默认续上一轮的会话；new_session=True 另起一个。
        service / env 不传用客户端的默认；recall / save 按次覆盖记忆开关（None = 跟随任务与平台）。
        on_event 可订阅过程（stage / model_call / tool_call / tool_result）。"""
        if new_session:
            self.session_id = None
        body = {"message": message, "session_id": self.session_id, "service": service or self.service,
                "env": env or self.env, "task": task, "subtask": subtask, "input": input_fields,
                "memory": {"recall": recall, "save": save}}
        answer, status, run_id = "", None, None
        for ev in self._sse("/v1/chat", body):
            if ev["type"] == "run":
                self.session_id, run_id = ev["session_id"], ev.get("run_id")
            elif ev["type"] == "error":
                raise AgentError(400, ev["code"], ev["message"])
            elif ev["type"] == "final":
                status, output = ev["status"], ev.get("output") or {}
                answer = output.get("answer") or output.get("error") or ""
            elif on_event:
                on_event(ev)
        if status is None:
            raise AgentError(502, "stream_broken", "推流在运行结束前断开" + (f"，运行 {run_id}" if run_id else ""))
        if status != "success":
            raise AgentError(500, f"run_{status}", answer or "运行没有成功结束")
        return answer

    # —— 任务 ——

    def run(self, task: str, input: dict[str, Any] | None = None, *, subtask: str | None = None,
            service: str | None = None, env: str | None = None, wait: bool | float = True,
            idempotency_key: str | None = None, recall: bool | None = None, save: bool | None = None,
            after: list[str] | None = None) -> dict:
        """发起一次任务运行。
        wait=True 等到结束；wait=秒数 最多等这么久；wait=False 立即返回回执 {run_id, status, …}。
        等到了返回运行详情（status / output / 配方 / 过程上下文）。任务声明了 output_schema 的，
        校验过的结构化结果在 output["data"]。
        after：等这些运行（run_id）都成功了再执行；其中有失败或取消的，这次不执行（error_code=upstream_failed）。
        串起几步时先用 wait=False 拿到前一步的 run_id。"""
        started = time.monotonic()
        server_wait = 0 if not wait else 300 if wait is True else min(float(wait), 300)
        body = {"task": task, "subtask": subtask, "service": service or self.service, "env": env or self.env,
                "input": input or {}, "memory": {"recall": recall, "save": save}, "wait": server_wait,
                "after": list(after or [])}
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
        accepted = self._call("POST", "/v1/runs", json=body, headers=headers)
        if not wait:
            return accepted
        # 服务端已经等过一段：总时长从提交那一刻算，不重新起算
        left = None if wait is True else max(0.0, float(wait) - (time.monotonic() - started))
        return self.wait(accepted["run_id"], timeout=left)

    def get(self, run_id: str) -> dict:
        return self._call("GET", f"/v1/runs/{run_id}")

    def wait(self, run_id: str, timeout: float | None = None) -> dict:
        """等到终态或超时，返回运行详情。timeout=None 一直等。"""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            run = self.get(run_id)
            if run["status"] in TERMINAL or (deadline is not None and time.monotonic() >= deadline):
                return run
            time.sleep(2 if deadline is None else max(0.0, min(2.0, deadline - time.monotonic())))

    def events(self, run_id: str, after: int = 0) -> list[dict]:
        return self._call("GET", f"/v1/runs/{run_id}/events", params={"after": after})

    def cancel(self, run_id: str) -> dict:
        return self._call("POST", f"/v1/runs/{run_id}/cancel")

    def rerun(self, run_id: str) -> dict:
        """同样的输入新开一次运行，返回回执。"""
        return self._call("POST", f"/v1/runs/{run_id}/rerun")

    def resume(self, run_id: str) -> dict:
        """失败的运行从断点续跑（同一个 run_id），返回回执。"""
        return self._call("POST", f"/v1/runs/{run_id}/resume")

    def correct(self, run_id: str, text: str) -> dict:
        """纠正一次结论：同会话开新一轮重答，纠正内容沉淀为人工知识。返回新运行的回执。"""
        return self._call("POST", f"/v1/runs/{run_id}/correct", json={"text": text})

    def feedback(self, run_id: str, score: int, *, reasons: list[str] | None = None, comment: str = "") -> dict:
        """评价一次运行：score 1 有用 / -1 有问题；reasons 是问题类型（取值见 /v1/meta 的 feedback_reasons）。
        同一个密钥再评一次就是覆盖。"""
        return self._call("PUT", f"/v1/runs/{run_id}/feedback",
                          json={"score": score, "reasons": reasons or [], "comment": comment})

    # —— 调度 ——

    def graph(self) -> dict:
        """任务图：{nodes: [任务…], edges: [{from, to, trigger_id, mode, on, …}]}（边 = 上游结束触发下游）。"""
        return self._call("GET", "/v1/tasks/_graph")

    def ticks(self, *, task: str | None = None, kind: str | None = None, outcome: str | None = None,
              env: str | None = None, hours: int | None = None, limit: int = 100) -> list[dict]:
        """触发记录（新的在前）：定时 / 事件 / 上游联动 / 自动重试每次判定建了哪条运行、为什么没建。"""
        params = {k: v for k, v in {"task": task, "kind": kind, "outcome": outcome, "env": env, "hours": hours,
                                    "limit": limit}.items() if v is not None}
        return self._call("GET", "/v1/ticks", params=params)["items"]

    # —— 事件 ——

    def emit(self, source: str, payload: dict, event: str | None = None) -> dict:
        """把一个事件推给平台（POST /v1/events/{source}），返回匹配到的任务与运行。"""
        headers = {"X-Event": event} if event else {}
        return self._call("POST", f"/v1/events/{source}", json=payload, headers=headers)

    # —— 底层 ——

    def _call(self, method: str, path: str, **kw: Any) -> Any:
        resp = self._http.request(method, path, **kw)
        if resp.status_code >= 400:
            raise _error(resp)
        return resp.json() if resp.content else None

    def _sse(self, path: str, body: dict) -> Iterator[dict]:
        with self._http.stream("POST", path, json=body, headers={"Accept": "text/event-stream"}) as resp:
            if resp.status_code >= 400:
                resp.read()
                raise _error(resp)
            for line in resp.iter_lines():
                if line.startswith("data: "):
                    yield json.loads(line[6:])


def _error(resp: httpx.Response) -> AgentError:
    try:
        err = resp.json()["error"]
        return AgentError(resp.status_code, err["code"], err["message"], err.get("detail"))
    except (ValueError, KeyError, TypeError):
        return AgentError(resp.status_code, f"http_{resp.status_code}", resp.text[:300])
