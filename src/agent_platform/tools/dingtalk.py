"""agent 侧薄工具：发钉钉通知。

第一天就做的薄工具——中继接口的 msgtype/折叠/hash 聚合由本模块处理，
agent 只传标题和正文。实际发送逻辑复用 notify/dingtalk.py 的 RelayClient。
"""

from __future__ import annotations


def make_dingtalk_tool(relay):
    """工厂：注入 DingTalkRelay，返回 agent 可用的工具函数。"""

    async def dingtalk_send(title: str, content: str) -> str:
        """向业务群发送钉钉通知。title 为标题，content 支持 markdown。"""
        await relay.send_markdown(title, content)
        return "已发送"

    dingtalk_send.__name__ = "dingtalk_send"
    return dingtalk_send
