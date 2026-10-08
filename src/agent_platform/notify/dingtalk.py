"""钉钉中继封装（纯输出，单向只发不收）。

中继接口：POST {relay_url}?access_token=...
四种消息形态按场景选择：
- markdown + card（折叠卡片）：报错分析结论，hash=run_id 聚合，不占配额
- noticeCard：巡检/周报，支持签收
- actionCard：审批/详情跳转，按钮带 Run Viewer 链接
- text：简单通知

注意：text/markdown 正文超 4000 字符会被中继截断——长内容只发摘要，全文走链接。
"""

from __future__ import annotations

from typing import Any

import httpx

RELAY_MAX_CHARS = 4000


class RelayError(RuntimeError):
    pass


def _clip(text: str, max_chars: int = RELAY_MAX_CHARS - 200) -> str:
    """留 200 字符余量给省略提示，避免中继截断破坏 markdown 结构。"""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n\n…（内容过长已省略，完整版见 Run Viewer 链接）"


class DingTalkRelay:
    def __init__(self, relay_url: str, access_token: str, timeout: float = 10.0):
        self._url = relay_url
        self._token = access_token
        self._timeout = timeout

    async def _send(self, payload: dict[str, Any]) -> dict:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(
                self._url, params={"access_token": self._token}, json=payload)
        if resp.status_code != 200:
            raise RelayError(f"中继返回 {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    async def send_text(self, content: str, at_all: bool = False) -> dict:
        return await self._send({"msgtype": "text",
                                 "text": {"content": _clip(content)},
                                 "at": {"isAtAll": at_all}})

    async def send_markdown(self, title: str, text: str) -> dict:
        return await self._send({"msgtype": "markdown",
                                 "markdown": {"title": title, "text": _clip(text)}})

    async def send_alert_card(self, title: str, content: str, *,
                              dedup_hash: str, severity: int = 3,
                              handlers: list[str] | None = None,
                              viewer_url: str | None = None) -> dict:
        """报错分析结论卡：hash 聚合同一 run 的多次更新；折叠卡片不占中继配额。"""
        body = _clip(content)
        if viewer_url:
            body += f"\n\n[查看完整分析]({viewer_url})"
        return await self._send({
            "msgtype": "markdown",
            "markdown": {"title": title, "text": body},
            "card": {
                "title": title,
                "max_char_display": 300,
                "hash": dedup_hash,            # 聚合键：同一 run 更新为一张卡
                "dedup_hash": dedup_hash,      # 幂等键：同 run 同状态不重复发
                "severity": severity,
                "handlers": handlers or [],
                "show_claim_button": True,
                "enable_ding_notify": severity <= 2,
                "enable_voice_call": False,    # agent 分析结论永远不打电话
            },
        })

    async def send_notice_card(self, title: str, content: str, *,
                               group_hash: str,
                               notifiers: list[str] | None = None) -> dict:
        """巡检/周报：noticeCard 支持签收与超长折叠。"""
        return await self._send({
            "msgtype": "noticeCard",
            "noticeCard": {
                "title": title, "content": _clip(content, 3800),
                "hash": group_hash, "max_char_display": 300,
                "show_sign_button": True,
            },
            "notifiers": notifiers or [],
        })

    async def send_action_card(self, title: str, text: str,
                               btn_title: str, btn_url: str) -> dict:
        """审批/详情跳转：按钮 actionURL 指向 Run Viewer，交互闭环在页面上完成。"""
        return await self._send({
            "msgtype": "actionCard",
            "actionCard": {
                "title": title, "text": _clip(text),
                "btnOrientation": "0",
                "btns": [{"title": btn_title, "actionURL": btn_url}],
            },
        })
