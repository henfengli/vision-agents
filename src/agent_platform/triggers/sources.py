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


_DAGSTER_FIELDS = {
    "run_failure": ["run_id", "asset_key", "error", "env", "subtask", "job"],
    "run_success": ["run_id", "asset_key", "asset_keys", "env", "subtask", "job", "partition"],
    "asset_check_failed": ["asset_key", "check", "severity", "description", "run_id", "env", "subtask"],
}


def _dagster(body: dict, headers: dict) -> list[Event]:
    """Dagster 传感器回调。事件名取请求体 event 或请求头 X-Event；不写 = run_failure（老的 run_failure_sensor 回调不用改）：
    - run_failure：{run_id, asset_key, error, env, subtask?, job?}（run_failure_sensor）
    - run_success：{run_id, asset_key?, asset_keys?, env, job?, partition?}（run_status_sensor，SUCCESS）
    - asset_check_failed：{asset_key, check, severity, description, run_id?, env}（asset check 失败，比如新鲜度检查）
    asset_keys 是列表时拼成逗号分隔的一串，过滤、映射都按文本处理。"""
    name = str(body.get("event") or headers.get("x-event") or "run_failure")
    fields = _DAGSTER_FIELDS.get(name, _DAGSTER_FIELDS["run_failure"])
    data = {k: body.get(k) for k in fields if body.get(k) is not None}
    if isinstance(data.get("asset_keys"), list):
        data["asset_keys"] = ",".join(map(str, data["asset_keys"]))
    return [Event(name, data)]


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
    Source("dagster", "Dagster", {
        "run_failure": ("运行失败", _DAGSTER_FIELDS["run_failure"]),
        "run_success": ("运行成功", _DAGSTER_FIELDS["run_success"]),
        "asset_check_failed": ("资产检查失败", _DAGSTER_FIELDS["asset_check_failed"]),
    }, _dagster, "在 Dagster 里配传感器回调 POST /v1/events/dagster；请求体带 event（不写 = run_failure）"),
    Source("gitlab", "GitLab", {"deployment": ("部署成功", ["project", "ref", "env", "sha", "url", "user"])},
           _gitlab, "项目 Webhook 勾选 Deployment events，地址 /v1/events/gitlab"),
    Source("webhook", "通用 Webhook", {"*": ("任意事件", [])},
           _webhook, "事件名放请求头 X-Event 或请求体 event；可带 env / service / subtask 字段"),
]}
