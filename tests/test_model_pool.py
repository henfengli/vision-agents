"""模型连接池测试：轮询、限并发、可重试错误换 token、不可重试直接抛。

注入 fake client_factory，不依赖 openai 包和网络。
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from agent_platform.model.pool import ModelPool, ModelPoolError


class RateLimitError(Exception):
    pass  # 名字匹配 _is_retryable 的白名单


class FakeCompletions:
    def __init__(self, behavior):
        self.behavior = behavior
        self.calls = 0

    async def create(self, model, messages, **kw):
        self.calls += 1
        if self.behavior == "rate_limit":
            raise RateLimitError("429")
        if self.behavior == "bad_request":
            raise ValueError("bad request")
        return f"ok:{model}"


class FakeClient:
    def __init__(self, behavior):
        self.chat = type("Chat", (), {"completions": FakeCompletions(behavior)})()


def make_pool(behaviors, max_concurrency=10):
    clients = [FakeClient(b) for b in behaviors]
    return ModelPool("http://x", "m", ["t"] * len(behaviors),
                     max_concurrency, client_factory=lambda t: clients.pop(0)), None


class TestModelPool(unittest.TestCase):
    def test_round_robin(self):
        pool = ModelPool("http://x", "m", ["a", "b", "c"],
                         client_factory=lambda t: FakeClient("ok"))
        results = asyncio.run(self._chat_n(pool, 6))
        self.assertEqual(results, ["ok:m"] * 6)

    async def _chat_n(self, pool, n):
        return [await pool.chat([{"role": "user", "content": "hi"}]) for _ in range(n)]

    def test_retry_on_rate_limit_switches_token(self):
        clients = [FakeClient("rate_limit"), FakeClient("ok")]
        pool = ModelPool("http://x", "m", ["a", "b"],
                         client_factory=lambda t: clients.pop(0))
        result = asyncio.run(pool.chat([{"role": "user", "content": "hi"}]))
        self.assertEqual(result, "ok:m")

    def test_non_retryable_raises_immediately(self):
        pool, _ = make_pool(["bad_request"])
        with self.assertRaises(ValueError):
            asyncio.run(pool.chat([{"role": "user", "content": "hi"}]))

    def test_all_tokens_fail_raises_pool_error(self):
        pool, _ = make_pool(["rate_limit", "rate_limit"])
        with self.assertRaises(ModelPoolError):
            asyncio.run(pool.chat([{"role": "user", "content": "hi"}]))

    def test_empty_tokens_rejected(self):
        with self.assertRaises(ModelPoolError):
            ModelPool("http://x", "m", [])

    def test_concurrency_limited(self):
        running, peak = 0, 0

        class SlowCompletions(FakeCompletions):
            async def create(self, model, messages, **kw):
                nonlocal running, peak
                running += 1
                peak = max(peak, running)
                await asyncio.sleep(0.05)
                running -= 1
                return "ok"

        def factory(_):
            c = FakeClient("ok")
            c.chat = type("Chat", (), {"completions": SlowCompletions("ok")})()
            return c

        pool = ModelPool("http://x", "m", ["a"], max_concurrency=2,
                         client_factory=factory)

        async def burst():
            await asyncio.gather(*[pool.chat([{"role": "u", "content": "x"}])
                                   for _ in range(8)])

        asyncio.run(burst())
        self.assertLessEqual(peak, 2)


class TestDefaultFactory(unittest.TestCase):
    """默认 openai 工厂：每个 token 独立 client（防闭包/变量名回归）。"""

    def test_default_factory_binds_token(self):
        try:
            from agent_platform.model.pool import ModelPool
            pool = ModelPool("http://llm/v1", "m", ["tok-a", "tok-b"])
        except ImportError:
            self.skipTest("openai 包不可用")
        keys = [str(c.api_key) for c in pool._clients]
        self.assertEqual(keys, ["tok-a", "tok-b"])


if __name__ == "__main__":
    unittest.main()
