"""通知路由：平台里发生了什么 → 按设置里的规则 → 发到哪些渠道。

两个入口：
- emit(event, …)   平台事件（运行失败/成功、等待审批、进程退出），按规则匹配渠道，可能一个都不发
- send(channel, …) 指名发到某个渠道（任务的结果投递、agent 的 notify 工具）

通知是旁路：发送失败只记日志，不影响运行本身。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from ..domain import Channel, NotificationsConfig, Rejected
from ..registry import Registry
from .dingtalk import DingTalkRelay

log = logging.getLogger(__name__)


@dataclass
class Message:
    title: str
    text: str                  # markdown
    link: str | None = None    # 控制台链接（"去审批" / "查看运行"）
    link_title: str = "查看详情"


class Notifier:
    def __init__(self, registry: Registry, public_url: str):
        self._reg = registry
        self._base = public_url.rstrip("/")

    def link(self, path: str) -> str:
        return f"{self._base}{path}"

    async def emit(self, event: str, msg: Message, *, service: str | None = None, env: str | None = None,
                   task: str | None = None, trigger: str | None = None) -> list[str]:
        """按规则投递，返回实际发出的渠道名。"""
        cfg: NotificationsConfig = await self._reg.config("notifications")
        channels = []
        for rule in cfg.rules:
            if rule.covers(event, service=service, env=env, task=task, trigger=trigger) and rule.channel not in channels:
                channels.append(rule.channel)
        sent = []
        for name in channels:
            try:
                await _deliver(cfg.channels[name], msg, event)
                sent.append(name)
            except Exception:  # noqa: BLE001 —— 通知是旁路
                log.exception("通知渠道 %s 发送失败（事件 %s）", name, event)
        return sent

    async def send(self, channel: str, msg: Message) -> None:
        """指名发送；渠道不存在或发送失败都抛出（调用方决定怎么处理）。"""
        cfg: NotificationsConfig = await self._reg.config("notifications")
        if channel not in cfg.channels:
            raise Rejected("unknown_channel", f"通知渠道 {channel} 不存在（设置 → 通知）")
        await _deliver(cfg.channels[channel], msg, "message")

    async def channel_names(self) -> list[str]:
        cfg: NotificationsConfig = await self._reg.config("notifications")
        return list(cfg.channels)


async def _deliver(ch: Channel, msg: Message, event: str) -> None:
    if ch.type == "dingtalk":
        relay = DingTalkRelay(ch.url, ch.token)
        if msg.link:
            await relay.send_action_card(msg.title, msg.text, msg.link_title, msg.link)
        else:
            await relay.send_markdown(msg.title, msg.text)
        return
    headers = {"Authorization": f"Bearer {ch.token}"} if ch.token else {}
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(ch.url, headers=headers, json={
            "event": event, "title": msg.title, "text": msg.text, "link": msg.link})
        resp.raise_for_status()
