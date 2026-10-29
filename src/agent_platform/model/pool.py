"""模型连接：OpenAI 兼容协议（现在接的是 Kimi）。三件事集中在这里：

- 多 token 逐请求轮换（RotatingTokenAuth）
- 账号并发上限（Quota / SharedQuota）：同时在途的请求数（model.max_concurrency，流式响应读完才算结束）。
  有空位就立刻发，不按分钟限速。agent 的模型调用和平台的辅助调用共用一份；prod、test 两边共用一个账号时
  经库共用这几个名额（SharedQuota）；撞了 429 由 SDK 按 max_retries 退避重试
- ModelPool：平台自己发起的辅助调用（记忆沉淀、交接摘要、回归判定）；带 run_id 的调用结束后交给 on_call
  记一条 model_call 事件（耗时、token），运行详情里看得到
- 超时：连上之后 timeout_s 秒收不到数据算超时，超时最多重试 timeout_retries 次（和别的错误的 max_retries 分开）
- 备用模型（model.fallback）：主模型重试完还失败换它，见 model/fallback.py。并发名额按账号算：同一个账号共用一份

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
from .fallback import LABELS, PRIMARY, ModelSwitch, describe, endpoints, switch_for

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
        self.slot_class = _LOCK_CLASS
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
                    cur = await conn.execute("SELECT pg_try_advisory_lock(%s, %s)", (self.slot_class, slot))
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


FALLBACK_SLOT_CLASS = _LOCK_CLASS + 1     # 另一个账号的备用模型的在途名额

_quotas: dict[tuple, Quota] = {}
_shared = False


def share_quota_via_db() -> None:
    """装配时（库连上之后）调用：之后建的客户端都走 SharedQuota。"""
    global _shared
    _shared = True
    _quotas.clear()


def account(cfg: ModelConfig) -> tuple:
    """账号 = 地址 + 这组 token：并发上限是按账号算的。备用模型和主模型同一个账号时共用一份名额。"""
    return cfg.url.rstrip("/"), tuple(cfg.tokens)


def quota(cfg: ModelConfig, slot_class: int = _LOCK_CLASS) -> Quota:
    """进程内每个账号一份（agent 与辅助调用一起算）；开了 share_quota_via_db 就是各台主机经库共用。
    slot_class：库里那组 advisory lock 的类别号，不同账号要不同（主模型 0x4147，另一个账号的备用模型 0x4148）。
    同一个账号第二次来拿到的是第一次建的那份（并发上限、类别号都按第一次的）。"""
    key = account(cfg)
    if key not in _quotas:
        q = (SharedQuota if _shared else Quota)(cfg.max_concurrency)
        q.slot_class = slot_class
        _quotas[key] = q
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
    """每次发送（含 SDK 的重试）先过配额；名额跟着响应体走，响应关闭时归还。
    超时另算重试次数：SDK 对超时和别的错误用同一个 max_retries，可超时一次就要等 timeout_s，重试 6 次就是半小时，
    配了备用模型也要等这么久才切。第 timeout_retries 次重试还超时就抛 SDK 自己的 APITimeoutError（SDK 对它不再重试）。"""

    def __init__(self, q: Quota, timeout_retries: int | None = None, **kw: Any):
        super().__init__(**kw)
        self._quota = q
        self._timeout_retries = timeout_retries

    async def send(self, request: httpx.Request, **kw: Any) -> httpx.Response:
        release = await self._quota.acquire()
        try:
            resp = await super().send(request, **kw)
        except httpx.TimeoutException as e:
            await release()
            if self._timeout_retries is not None and _retries_taken(request) >= self._timeout_retries:
                import openai
                raise openai.APITimeoutError(request=request) from e
            raise
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


def _retries_taken(request: httpx.Request) -> int:
    """SDK 在每次请求的头里写第几次重试（0 = 第一次）。"""
    try:
        return int(request.headers.get("x-stainless-retry-count") or 0)
    except ValueError:
        return 0


def timeout(cfg: ModelConfig) -> httpx.Timeout:
    """连上之后多久收不到数据算超时（流式是两段之间）；连接 15 秒。"""
    return httpx.Timeout(cfg.timeout_s, connect=min(15.0, cfg.timeout_s))


def http_client(cfg: ModelConfig, slot_class: int = _LOCK_CLASS) -> httpx.AsyncClient:
    return QuotaClient(quota(cfg, slot_class), timeout_retries=cfg.timeout_retries,
                       auth=RotatingTokenAuth(cfg.tokens), timeout=timeout(cfg))


OnCall = Callable[[str, dict], Awaitable[None]]


def openai_client(cfg: ModelConfig, slot_class: int = _LOCK_CLASS) -> tuple[Any, httpx.AsyncClient]:
    from openai import AsyncOpenAI
    http = http_client(cfg, slot_class)
    return AsyncOpenAI(base_url=cfg.url, api_key=cfg.tokens[0], http_client=http, max_retries=cfg.max_retries,
                       timeout=timeout(cfg)), http


class ModelPool:
    def __init__(self, cfg: ModelConfig, client: Any = None, *, switch: ModelSwitch | None = None,
                 fallback_client: Any = None):
        """client / fallback_client 可注入（测试）；默认是指向各自 url 的 AsyncOpenAI。
        switch：和 agent 共用的主 / 备用切换状态（runtime 装配时传同一个）。"""
        if not cfg.tokens:
            raise ModelPoolError("至少配置一个模型 token")
        self._cfgs = endpoints(cfg)
        self.switch = switch or switch_for(cfg)
        self._http: list[httpx.AsyncClient] = []
        self._clients: dict[str, Any] = {}
        for which, c in self._cfgs.items():
            given = client if which == PRIMARY else fallback_client
            if given is None:
                slot = _LOCK_CLASS if which == PRIMARY or account(c) == account(cfg) else FALLBACK_SLOT_CLASS
                given, http = openai_client(c, slot)
                self._http.append(http)
            self._clients[which] = given
        self._cfg = cfg
        self.on_call: OnCall | None = None       # 装配时接到 run_events（runtime.py）

    async def close(self) -> None:
        for http in self._http:
            await http.aclose()

    async def chat(self, messages: list[dict], *, run_id: str | None = None, purpose: str = "", **kw: Any) -> Any:
        """配额排队与重试在客户端里；主模型重试完还失败换备用模型（model/fallback.py）。purpose 是给人看的用途（"记忆沉淀"…）。"""
        t0 = time.monotonic()
        waited = [0.0]
        token = queue_wait.set(waited)

        def attempt(which: str) -> Callable[[], Awaitable[Any]]:
            return lambda: self._clients[which].chat.completions.create(model=self._cfgs[which].name, messages=messages, **kw)

        async def switched(frm: str, to: str, e: BaseException) -> None:
            log.warning("%s %s 调用失败（%s），%s换%s %s", LABELS[frm], self._cfgs[frm].name, describe(e),
                        f"「{purpose}」" if purpose else "", LABELS[to], self._cfgs[to].name)

        with observability.run_span("model.chat", purpose=purpose, run_id=run_id):
            try:
                resp, used = await self.switch.call({w: attempt(w) for w in self._clients}, on_switch=switched)
            except Exception as e:  # noqa: BLE001 —— 重试也没成：统一成一种错误给调用方
                raise ModelPoolError(f"模型调用失败（{purpose or '辅助调用'}）：{type(e).__name__}: {e}") from e
            finally:
                queue_wait.reset(token)
        if run_id and self.on_call is not None:
            usage = getattr(resp, "usage", None)
            event = {"purpose": purpose, "model": self._cfgs[used].name, "ms": int((time.monotonic() - t0) * 1000),
                     "input_tokens": getattr(usage, "prompt_tokens", None),
                     "output_tokens": getattr(usage, "completion_tokens", None),
                     "tokens": getattr(usage, "total_tokens", None)}
            if waited[0] >= 500:
                event["queued_ms"] = int(waited[0])
            if used != PRIMARY:
                event["fallback"] = True             # 用的是备用模型（主模型失败了，或正处在先用备用的那段时间）
            try:
                await self.on_call(run_id, event)
            except Exception:  # noqa: BLE001 —— 记账失败不影响调用结果
                log.exception("记录模型调用失败（%s）", run_id)
        return resp

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        """文本嵌入：未配置 embedding 模型或调用失败返回 None（检索降级 trgm）。"""
        if not self._cfg.embedding_name:
            return None
        try:     # 只用主模型的嵌入：换了嵌入模型，向量和库里已有的对不上
            resp = await self._clients[PRIMARY].embeddings.create(model=self._cfg.embedding_name, input=texts)
            return [d.embedding for d in resp.data]
        except Exception:  # noqa: BLE001 —— 嵌入是增强项，失败不阻塞主流程
            return None
