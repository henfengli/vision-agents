"""通知：按设置里的规则把平台事件发到钉钉 / Webhook 渠道（router），钉钉中继封装（dingtalk）。"""

from .dingtalk import DingTalkRelay, RelayError
from .router import Message, Notifier

__all__ = ["DingTalkRelay", "Message", "Notifier", "RelayError"]
