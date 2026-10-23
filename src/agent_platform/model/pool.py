"""模型连接：OpenAI 兼容协议（现在接的是 Kimi）。三件事集中在这里：

- 多 token 逐请求轮换（RotatingTokenAuth）
- 账号配额排队（Quota）：同时在途的请求数（model.max_concurrency，流式响应读完才算结束）和每分钟请求数（model.rpm）。
  agent 的模型调用和平台的辅助调用共用一份，到点再发，不撞 429；撞了也由 SDK 按 max_retries 退避重试
- ModelPool：平台自己发起的辅助调用（记忆沉淀、交接摘要、回归判定）；带 run_id 的调用结束后交给 on_call
  记一条 model_call 事件（耗时、token），运行详情里看得到

agent 用的聊天模型在 model/chat.py（同一个 httpx 客户端配置）。
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections import deque
from contextvars import ContextVar
from typing import Any, Awaitable, Callable

import httpx

from .. import observability
from ..config import ModelConfig

log = logging.getLogger(__name__)


class ModelPoolError(RuntimeError):
    pass


# 排队累计（毫秒）：agent 执行时设一个 [0.0]，这次执行里的模型请求排队多久都加进去（子任务共享同一个列表），
# 时间线的 model_call 用它把耗时里的排队拆出来（factory._stream）
queue_wait: ContextVar[list[float] | None] = ContextVar("queue_wait", default=None)


class Quota:
    """账号配额：同时在途最多 concurrency 个请求，任意 60 秒内最多 rpm 次请求；<=0 表示不限。
    先占在途名额再等分钟窗口；名额在响应读完（流式读完）或出错时归还。"""

    def __init__(self, rpm: int, concurrency: int):
        self.rpm = rpm
        self._slots = asyncio.Semaphore(concurrency) if concurrency > 0 else None
        self._sent: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        t0 = time.monotonic()
        if self._slots is not None:
            await self._slots.acquire()
        try:
            await self._window()
        except BaseException:
            self.release()
            raise
        if (acc := queue_wait.get()) is not None:
            acc[0] += (time.monotonic() - t0) * 1000

    def release(self) -> None:
        if self._slots is not None:
            self._slots.release()

    async def _window(self) -> None:
        if self.rpm <= 0:
            return
        async with self._lock:
            while True:
                now = time.monotonic()
                while self._sent and now - self._sent[0] >= 60:
                    self._sent.popleft()
                if len(self._sent) < self.rpm:
                    self._sent.append(now)
                    return
                await asyncio.sleep(60 - (now - self._sent[0]) + 0.05)


_quotas: dict[tuple[int, int], Quota] = {}


def quota(cfg: ModelConfig) -> Quota:
    """进程内共用一份（agent 与辅助调用一起算）。"""
    key = (cfg.rpm, cfg.max_concurrency)
    if key not in _quotas:
        _quotas[key] = Quota(*key)
    return _quotas[key]


class _ReleaseOnClose(httpx.AsyncByteStream):
    def __init__(self, inner: httpx.AsyncByteStream, release: Callable[[], None]):
        self._inner = inner
        self._release: Callable[[], None] | None = release

    async def __aiter__(self):
        async for chunk in self._inner:
            yield chunk

    async def aclose(self) -> None:
        try:
            await self._inner.aclose()
        finally:
            if self._release is not None:
                release, self._release = self._release, None
                release()


class QuotaClient(httpx.AsyncClient):
    """每次发送（含 SDK 的重试）先过配额；名额跟着响应体走，响应关闭时归还。"""

    def __init__(self, q: Quota, **kw: Any):
        super().__init__(**kw)
        self._quota = q

    async def send(self, request: httpx.Request, **kw: Any) -> httpx.Response:
        await self._quota.acquire()
        try:
            resp = await super().send(request, **kw)
        except BaseException:
            self._quota.release()
            raise
        if resp.is_closed:                      # 非流式：响应体已读完
            self._quota.release()
        else:
            resp.stream = _ReleaseOnClose(resp.stream, self._quota.release)  # type: ignore[arg-type]
        return resp


class RotatingTokenAuth(httpx.Auth):
    """每请求轮换 bearer token。SDK 的重试是新请求，自然换 token。"""

    def __init__(self, tokens: list[str]):
        if not tokens:
            raise ModelPoolError("至少配置一个模型 token")
        self._tokens = tokens
        self._rr = itertools.count()

    def auth_flow(self, request):
        request.headers["Authorization"] = f"Bearer {self._tokens[next(self._rr) % len(self._tokens)]}"
        yield request


def http_client(cfg: ModelConfig) -> httpx.AsyncClient:
    return QuotaClient(quota(cfg), auth=RotatingTokenAuth(cfg.tokens), timeout=600)


OnCall = Callable[[str, dict], Awaitable[None]]


class ModelPool:
    def __init__(self, cfg: ModelConfig, client: Any = None):
        """client 可注入（测试）；默认是指向 cfg.url 的 AsyncOpenAI。"""
        if not cfg.tokens:
            raise ModelPoolError("至少配置一个模型 token")
        self._cfg = cfg
        self._http: httpx.AsyncClient | None = None
        if client is None:
            from openai import AsyncOpenAI
            self._http = http_client(cfg)
            client = AsyncOpenAI(base_url=cfg.url, api_key=cfg.tokens[0], http_client=self._http,
                                 max_retries=cfg.max_retries)
        self._client = client
        self.on_call: OnCall | None = None       # 装配时接到 run_events（runtime.py）

    async def close(self) -> None:
        if self._http is not None:
            await self._http.aclose()

    async def chat(self, messages: list[dict], *, run_id: str | None = None, purpose: str = "", **kw: Any) -> Any:
        """配额排队与重试在客户端里。purpose 是给人看的用途（"记忆沉淀"…）。"""
        t0 = time.monotonic()
        waited = [0.0]
        token = queue_wait.set(waited)
        with observability.run_span("model.chat", purpose=purpose, run_id=run_id):
            try:
                resp = await self._client.chat.completions.create(model=self._cfg.name, messages=messages, **kw)
            except Exception as e:  # noqa: BLE001 —— 重试也没成：统一成一种错误给调用方
                raise ModelPoolError(f"模型调用失败（{purpose or '辅助调用'}）：{type(e).__name__}: {e}") from e
            finally:
                queue_wait.reset(token)
        if run_id and self.on_call is not None:
            usage = getattr(resp, "usage", None)
            event = {"purpose": purpose, "model": self._cfg.name, "ms": int((time.monotonic() - t0) * 1000),
                     "input_tokens": getattr(usage, "prompt_tokens", None),
                     "output_tokens": getattr(usage, "completion_tokens", None),
                     "tokens": getattr(usage, "total_tokens", None)}
            if waited[0] >= 500:
                event["queued_ms"] = int(waited[0])
            try:
                await self.on_call(run_id, event)
            except Exception:  # noqa: BLE001 —— 记账失败不影响调用结果
                log.exception("记录模型调用失败（%s）", run_id)
        return resp

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        """文本嵌入：未配置 embedding 模型或调用失败返回 None（检索降级 trgm）。"""
        if not self._cfg.embedding_name:
            return None
        try:
            resp = await self._client.embeddings.create(model=self._cfg.embedding_name, input=texts)
            return [d.embedding for d in resp.data]
        except Exception:  # noqa: BLE001 —— 嵌入是增强项，失败不阻塞主流程
            return None
