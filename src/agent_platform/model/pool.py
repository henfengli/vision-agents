"""模型连接：OpenAI 兼容协议（现在接的是 Kimi）。三件事集中在这里：

- 多 token 逐请求轮换（RotatingTokenAuth）
- 账号并发上限（Quota / SharedQuota）：同时在途的请求数（model.max_concurrency，流式响应读完才算结束）。
  有空位就立刻发，不按分钟限速。agent 的模型调用和平台的辅助调用共用一份；prod、test 两边共用一个账号时
  经库共用这几个名额（SharedQuota）；撞了 429 由 SDK 按 max_retries 退避重试
- ModelPool：平台自己发起的辅助调用（记忆沉淀、交接摘要、回归判定）；带 run_id 的调用结束后交给 on_call
  记一条 model_call 事件（耗时、token），运行详情里看得到

agent 用的聊天模型在 model/chat.py（同一个 httpx 客户端配置）。
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import time
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


Release = Callable[[], Awaitable[None]]


async def _noop() -> None:
    return None


class Quota:
    """账号并发上限（进程内）：同时在途最多 concurrency 个请求；<=0 表示不限。
    acquire 返回归还名额的函数：响应读完（流式读完）或出错时调用。"""

    def __init__(self, concurrency: int):
        self.concurrency = concurrency
        self._slots = asyncio.Semaphore(concurrency) if concurrency > 0 else None

    async def acquire(self) -> Release:
        t0 = time.monotonic()
        release = await self._slot()
        if (acc := queue_wait.get()) is not None:
            acc[0] += (time.monotonic() - t0) * 1000
        return release

    async def _slot(self) -> Release:
        if self._slots is None:
            return _noop
        await self._slots.acquire()

        async def release() -> None:
            self._slots.release()
        return release


_LOCK_CLASS = 0x4147               # 在途名额：PG 会话级 advisory lock（两个 int 的键：类别, 名额号）


class SharedQuota(Quota):
    """prod、test 两边共用的账号并发上限（经共用的库）：每个名额一把会话级 advisory lock，
    抢到的请求独占一条连接到响应读完；进程挂了连接断了锁就放了。名额都占着时每 0.2 秒再试。
    本进程先过一道同样大小的信号量：一台主机最多同时有 concurrency 个请求在抢 / 占名额，连接数有上限。"""

    async def _slot(self) -> Release:
        if self.concurrency <= 0:
            return _noop
        import psycopg

        from ..store import db
        assert self._slots is not None
        await self._slots.acquire()
        try:
            conn = await psycopg.AsyncConnection.connect(db.dsn(), autocommit=True)
        except BaseException:
            self._slots.release()
            raise
        try:
            while True:
                for slot in range(self.concurrency):
                    cur = await conn.execute("SELECT pg_try_advisory_lock(%s, %s)", (_LOCK_CLASS, slot))
                    if (await cur.fetchone())[0]:
                        async def release(conn=conn) -> None:
                            try:
                                await conn.close()      # 断开即释放会话级锁
                            finally:
                                self._slots.release()
                        return release
                await asyncio.sleep(0.2)
        except BaseException:
            await conn.close()
            self._slots.release()
            raise


_quotas: dict[int, Quota] = {}
_shared = False


def share_quota_via_db() -> None:
    """装配时（库连上之后）调用：之后建的客户端都走 SharedQuota。"""
    global _shared
    _shared = True
    _quotas.clear()


def quota(cfg: ModelConfig) -> Quota:
    """进程内共用一份（agent 与辅助调用一起算）；开了 share_quota_via_db 就是 prod、test 两边共用。"""
    key = cfg.max_concurrency
    if key not in _quotas:
        _quotas[key] = (SharedQuota if _shared else Quota)(key)
    return _quotas[key]


class _ReleaseOnClose(httpx.AsyncByteStream):
    def __init__(self, inner: httpx.AsyncByteStream, release: Release):
        self._inner = inner
        self._release: Release | None = release

    async def __aiter__(self):
        async for chunk in self._inner:
            yield chunk

    async def aclose(self) -> None:
        try:
            await self._inner.aclose()
        finally:
            if self._release is not None:
                release, self._release = self._release, None
                await release()


class QuotaClient(httpx.AsyncClient):
    """每次发送（含 SDK 的重试）先过配额；名额跟着响应体走，响应关闭时归还。"""

    def __init__(self, q: Quota, **kw: Any):
        super().__init__(**kw)
        self._quota = q

    async def send(self, request: httpx.Request, **kw: Any) -> httpx.Response:
        release = await self._quota.acquire()
        try:
            resp = await super().send(request, **kw)
        except BaseException:
            await release()
            raise
        if resp.is_closed:                      # 非流式：响应体已读完
            await release()
        else:
            resp.stream = _ReleaseOnClose(resp.stream, release)  # type: ignore[arg-type]
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
