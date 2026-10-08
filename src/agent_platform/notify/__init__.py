"""通知层：钉钉单向中继（只发不收）。"""

from .dingtalk import DingTalkRelay, RelayError

__all__ = ["DingTalkRelay", "RelayError"]
