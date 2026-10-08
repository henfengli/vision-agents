"""模型连接池：职责仅三——token 轮询、信号量限并发、失败换 token 重试。

client_factory 可注入，测试不依赖 openai 包。
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any, Awaitable, Callable


class ModelPoolError(RuntimeError):
    pass


def _default_factory(url: str):
    from openai import AsyncOpenAI  # 延迟导入

    return lambda token: AsyncOpenAI(base_url=url, api_key=token)


class ModelPool:
    def __init__(self, url: str, name: str, tokens: list[str],
                 max_concurrency: int = 10,
                 embedding_name: str | None = None,
                 client_factory: Callable[[str], Any] | None = None):
        if not tokens:
            raise ModelPoolError("至少配置一个模型 token")
        factory = client_factory or _default_factory(url)
        self._clients = [factory(t) for t in tokens]
        self._name = name
        self._embedding_name = embedding_name
        self._sem = asyncio.Semaphore(max_concurrency)
        self._rr = itertools.count()

    def _next_client(self) -> Any:
        return self._clients[next(self._rr) % len(self._clients)]

    async def chat(self, messages: list[dict], max_retries: int = 3, **kw: Any) -> Any:
        """限并发调用；限流类错误自动换下一个 token 重试。"""
        async with self._sem:
            last_err: Exception | None = None
            for _ in range(min(max_retries, len(self._clients)) + 1):
                client = self._next_client()
                try:
                    return await client.chat.completions.create(
                        model=self._name, messages=messages, **kw)
                except Exception as e:  # 限流/服务端错误换 token；参数错误直接抛
                    if _is_retryable(e):
                        last_err = e
                        continue
                    raise
            raise ModelPoolError(f"所有 token 均不可用：{last_err}")

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        """文本嵌入：未配置 embedding 模型或调用失败返回 None（检索降级 trgm）。"""
        if not self._embedding_name:
            return None
        async with self._sem:
            try:
                resp = await self._next_client().embeddings.create(
                    model=self._embedding_name, input=texts)
                return [d.embedding for d in resp.data]
            except Exception:  # noqa: BLE001 —— 嵌入是增强项，失败不阻塞主流程
                return None


def _is_retryable(e: Exception) -> bool:
    name = type(e).__name__
    return name in {"RateLimitError", "InternalServerError", "APIConnectionError",
                    "APITimeoutError"}
