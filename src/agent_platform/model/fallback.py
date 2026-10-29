"""主模型 / 备用模型的切换（部署配置 model.fallback）。

一次模型调用：先用主模型（SDK 按 max_retries / timeout_retries 重试），重试完还失败就换备用模型重试这一次调用，
任务接着跑，不用从头来。agent 的调用（factory 的 FallbackMiddleware）、上下文压缩、平台的辅助调用（ModelPool）都走这里。

主模型是「服务出了问题」（连不上、超时、5xx、限流、鉴权 / 余额、模型不存在）失败的，之后 fallback_hold_s 秒内新的调用
直接用备用，不再让每次调用都先在主模型上耗一轮重试；过了这段时间再试主模型，好了就切回来。备用也失败时反过来再试一次主模型。
请求本身的问题（400 / 422：参数、上下文太长）只对这一次调用换备用，不算主模型挂了。

状态在本进程里（每台主机各自判断，不经库）。从「正常」变成「挂了」的那一刻调 on_outage 一次（通知用），
同一次故障里反复探测失败不重复。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Awaitable, Callable

log = logging.getLogger(__name__)

PRIMARY, FALLBACK = "primary", "fallback"
LABELS = {PRIMARY: "主模型", FALLBACK: "备用模型"}

OnOutage = Callable[[str, str, str], Awaitable[None]]       # (主模型名, 备用模型名, 错误说明)


def is_outage(e: BaseException) -> bool:
    """是不是模型服务本身出了问题（而不是这次请求的内容有问题）。"""
    try:
        import openai
    except ImportError:          # pragma: no cover
        return True
    if isinstance(e, (openai.BadRequestError, openai.UnprocessableEntityError)):
        return False             # 400 / 422：请求本身不对（参数、上下文太长），换备用试这一次，不算挂了
    if isinstance(e, openai.APIStatusError):
        return True              # 401 / 403（鉴权、余额）、404（模型不存在）、409、429、5xx
    if isinstance(e, (openai.APIConnectionError, openai.APITimeoutError)):
        return True
    import httpx
    return isinstance(e, (httpx.TransportError, TimeoutError))   # 流式读到一半超时 / 断开


def describe(e: BaseException, limit: int = 300) -> str:
    text = f"{type(e).__name__}: {e}"
    return text if len(text) <= limit else text[:limit] + "…"


class ModelSwitch:
    """哪套模型先用。没配备用模型时只有主模型，和以前一样。"""

    def __init__(self, primary: str, fallback: str | None = None, hold_s: float = 300,
                 clock: Callable[[], float] = time.monotonic):
        self.names = {PRIMARY: primary, **({FALLBACK: fallback} if fallback else {})}
        self.hold_s = hold_s
        self._clock = clock
        self._hold_until = 0.0
        self.down_since: float | None = None       # 这次故障从什么时候开始（主模型成功一次就清掉）
        self.last_error = ""
        self.on_outage: OnOutage | None = None

    @property
    def enabled(self) -> bool:
        return FALLBACK in self.names

    @property
    def holding(self) -> bool:
        """主模型挂了、还在「先用备用」的时间里。"""
        return self.enabled and self._clock() < self._hold_until

    def order(self) -> list[str]:
        if not self.enabled:
            return [PRIMARY]
        return [FALLBACK, PRIMARY] if self.holding else [PRIMARY, FALLBACK]

    def hold_left_s(self) -> int:
        return max(0, int(self._hold_until - self._clock()))

    async def failed(self, which: str, e: BaseException) -> None:
        if which != PRIMARY or not self.enabled or not is_outage(e):
            return
        self.last_error = describe(e)
        self._hold_until = self._clock() + self.hold_s
        if self.down_since is None:
            self.down_since = self._clock()
            log.warning("主模型 %s 调用失败（%s）：之后 %d 秒内先用备用模型 %s", self.names[PRIMARY], self.last_error,
                        self.hold_s, self.names[FALLBACK])
            if self.on_outage is not None:
                try:
                    await self.on_outage(self.names[PRIMARY], self.names[FALLBACK], self.last_error)
                except Exception:  # noqa: BLE001 —— 通知失败不影响调用
                    log.exception("模型切换的通知发送失败")

    def succeeded(self, which: str) -> None:
        if which == PRIMARY and self.down_since is not None:
            log.info("主模型 %s 恢复了（挂了 %d 秒），切回主模型", self.names[PRIMARY], int(self._clock() - self.down_since))
            self.down_since = None
            self._hold_until = 0.0

    async def call(self, attempts: dict[str, Callable[[], Awaitable[Any]]],
                   on_switch: Callable[[str, str, BaseException], Awaitable[None]] | None = None) -> tuple[Any, str]:
        """按 order() 依次试，第一个成功的结果 → (结果, 用的哪套)。都失败抛最后一个错误。
        取消（CancelledError）和 LangGraph 的控制流异常（GraphBubbleUp）原样往上抛，不当成失败。"""
        try:
            from langgraph.errors import GraphBubbleUp
        except ImportError:      # pragma: no cover
            GraphBubbleUp = ()   # type: ignore[assignment]  # noqa: N806
        order = [w for w in self.order() if w in attempts]
        last: BaseException | None = None
        for i, which in enumerate(order):
            try:
                result = await attempts[which]()
            except GraphBubbleUp:
                raise
            except Exception as e:  # noqa: BLE001
                last = e
                await self.failed(which, e)
                if i + 1 < len(order) and on_switch is not None:
                    await on_switch(which, order[i + 1], e)
                continue
            self.succeeded(which)
            return result, which
        assert last is not None
        raise last


def endpoints(cfg: Any) -> dict[str, Any]:
    """{primary: 主模型的 ModelConfig, fallback: 备用的（配了才有）}。"""
    out = {PRIMARY: cfg}
    if (fb := cfg.fallback_config()) is not None:
        out[FALLBACK] = fb
    return out


def switch_for(cfg: Any) -> ModelSwitch:
    fb = cfg.fallback_config()
    return ModelSwitch(cfg.name, fb.name if fb else None, cfg.fallback_hold_s)
