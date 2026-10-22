"""事件来源：把各系统的回调原文翻译成统一的 Event（事件名 + 扁平字段）。

新接一个系统 = 在这里加一个函数并登记到 SOURCES。字段说明会显示在控制台的触发器编辑器里。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class Event:
    name: str
    data: dict[str, Any]


@dataclass
class Source:
    name: str
    title: str
    events: dict[str, tuple[str, list[str]]]          # 事件名 → (标题, 字段)
    parse: Callable[[dict, dict], list[Event]]       # (请求体, 请求头) → 事件
    notes: str = ""

    def info(self) -> dict:
        return {"name": self.name, "title": self.title, "notes": self.notes,
                "events": [{"name": n, "title": t, "fields": f} for n, (t, f) in self.events.items()]}


def _dagster(body: dict, _headers: dict) -> list[Event]:
    """Dagster run_failure_sensor 回调：{run_id, asset_key, error, env?, subtask?}。"""
    return [Event("run_failure", {k: body.get(k) for k in ("run_id", "asset_key", "error", "env", "subtask", "job")
                                  if body.get(k) is not None})]


def _gitlab(body: dict, headers: dict) -> list[Event]:
    """GitLab Deployment 事件：只认部署成功；environment 即平台环境名。"""
    if body.get("object_kind") != "deployment" or body.get("status") != "success":
        return []
    project = body.get("project") or {}
    return [Event("deployment", {
        "project": project.get("name") or project.get("path_with_namespace"), "ref": body.get("ref"),
        "env": body.get("environment"), "sha": body.get("short_sha"),
        "url": body.get("environment_external_url"), "user": (body.get("user") or {}).get("username")})]


def _webhook(body: dict, headers: dict) -> list[Event]:
    """通用：事件名取请求头 X-Event 或请求体 event 字段，其余字段原样作为事件数据。"""
    name = headers.get("x-event") or body.get("event") or "message"
    return [Event(str(name), {k: v for k, v in body.items() if k != "event"})]


SOURCES: dict[str, Source] = {s.name: s for s in [
    Source("dagster", "Dagster", {"run_failure": ("运行失败", ["run_id", "asset_key", "error", "env", "subtask", "job"])},
           _dagster, "在 Dagster 里配 run_failure_sensor 回调 POST /v1/events/dagster"),
    Source("gitlab", "GitLab", {"deployment": ("部署成功", ["project", "ref", "env", "sha", "url", "user"])},
           _gitlab, "项目 Webhook 勾选 Deployment events，地址 /v1/events/gitlab"),
    Source("webhook", "通用 Webhook", {"*": ("任意事件", [])},
           _webhook, "事件名放请求头 X-Event 或请求体 event；可带 env / service / subtask 字段"),
]}
