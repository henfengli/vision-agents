"""备用模型（第二套）：主模型重试完还失败，这一步换备用接着跑；主模型挂了一段时间内先用备用；超时单独限重试次数。
不需要 Postgres，也不连真的模型服务。"""

import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest import mock

import httpx
import openai

from agent_platform import config
from agent_platform.agent import factory
from agent_platform.agent import scope as run_scope
from agent_platform.config import ModelConfig
from agent_platform.model import pool as pool_mod
from agent_platform.model.fallback import FALLBACK, PRIMARY, ModelSwitch, is_outage, switch_for

run = asyncio.run
REQ = httpx.Request("POST", "http://model/v1/chat/completions")


def conn_error():
    return openai.APIConnectionError(request=REQ)


def status_error(cls, code):
    return cls("boom", response=httpx.Response(code, request=REQ), body=None)


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class ConfigTest(unittest.TestCase):
    def test_fallback_inherits_what_it_does_not_say(self):
        cfg = ModelConfig(url="http://kimi", name="k27", tokens=["a"], max_concurrency=3,
                          fallback={"name": "k26", "context_tokens": 200_000})
        fb = cfg.fallback_config()
        self.assertEqual((fb.url, fb.name, fb.tokens, fb.max_concurrency, fb.context_tokens), ("http://kimi", "k26", ["a"], 3, 200_000))
        self.assertIsNone(fb.fallback)
        self.assertEqual(cfg.compaction_tokens, 200_000)                 # 压缩按两个里小的

    def test_other_account(self):
        cfg = ModelConfig(url="http://kimi", name="k27", tokens=["a"],
                          fallback={"name": "ds", "url": "http://ds", "tokens": ["b"], "max_concurrency": 8})
        fb = cfg.fallback_config()
        self.assertNotEqual(pool_mod.account(fb), pool_mod.account(cfg))
        self.assertEqual(fb.max_concurrency, 8)
        self.assertEqual(cfg.compaction_tokens, 400_000)

    def test_empty_name_means_no_fallback(self):
        for fb in (None, {"name": ""}, {"name": "  ", "url": "http://x"}):
            cfg = ModelConfig(url="u", name="n", tokens=["t"], fallback=fb)
            self.assertIsNone(cfg.fallback_config())
            self.assertFalse(switch_for(cfg).enabled)

    def test_prod_profile_has_a_fallback(self):
        with mock.patch.dict(os.environ, {"AGENT_DB_PASSWORD": "x", "AGENT_DB_HOST": "h", "AGENT_ROOT_TOKEN": "r",
                                          "MODEL_TOKEN_A": "k"}), \
                mock.patch.object(config, "LOCAL_CONF", config.Path("/nonexistent/local.yaml")):
            s = config.load_settings("prod")
        fb = s.model.fallback_config()
        self.assertEqual((fb.name, fb.tokens, fb.url), ("kimi-k2.6", ["k"], s.model.url))    # 同一个账号换个模型
        self.assertEqual((s.model.timeout_s, s.model.timeout_retries, s.model.fallback_hold_s), (120, 1, 300))


class OutageTest(unittest.TestCase):
    def test_classification(self):
        self.assertTrue(is_outage(conn_error()))
        self.assertTrue(is_outage(openai.APITimeoutError(request=REQ)))
        self.assertTrue(is_outage(status_error(openai.RateLimitError, 429)))
        self.assertTrue(is_outage(status_error(openai.InternalServerError, 502)))
        self.assertTrue(is_outage(status_error(openai.AuthenticationError, 401)))
        self.assertTrue(is_outage(status_error(openai.NotFoundError, 404)))
        self.assertTrue(is_outage(httpx.ReadTimeout("stalled")))            # 流式读到一半没数据了
        self.assertFalse(is_outage(status_error(openai.BadRequestError, 400)))   # 请求本身的问题
        self.assertFalse(is_outage(ValueError("parse")))


class SwitchTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.sw = ModelSwitch("k27", "k26", hold_s=300, clock=self.clock)
        self.calls = []
        self.outages = []

        async def outage(p, f, e):
            self.outages.append((p, f, e))
        self.sw.on_outage = outage

    def attempts(self, fail=()):
        def make(which):
            async def go():
                self.calls.append(which)
                if which in fail:
                    raise fail[which]
                return which
            return go
        return {PRIMARY: make(PRIMARY), FALLBACK: make(FALLBACK)}

    def test_primary_first_then_fallback_and_hold(self):
        switched = []

        async def on_switch(frm, to, e):
            switched.append((frm, to))
        res, used = run(self.sw.call(self.attempts({PRIMARY: conn_error()}), on_switch=on_switch))
        self.assertEqual((res, used, self.calls, switched), (FALLBACK, FALLBACK, [PRIMARY, FALLBACK], [(PRIMARY, FALLBACK)]))
        self.assertEqual(len(self.outages), 1)
        self.assertTrue(self.sw.holding)
        self.calls.clear()
        run(self.sw.call(self.attempts()))                   # 先用备用的那段时间：主模型不碰
        self.assertEqual(self.calls, [FALLBACK])
        self.clock.t += 301                                  # 过了再试主模型
        self.calls.clear()
        run(self.sw.call(self.attempts({PRIMARY: conn_error()})))
        self.assertEqual(self.calls, [PRIMARY, FALLBACK])
        self.assertEqual(len(self.outages), 1)               # 同一次故障不重复通知
        self.clock.t += 301
        run(self.sw.call(self.attempts()))                   # 主模型好了
        self.assertIsNone(self.sw.down_since)
        self.assertFalse(self.sw.holding)
        run(self.sw.call(self.attempts({PRIMARY: conn_error()})))
        self.assertEqual(len(self.outages), 2)               # 恢复之后再挂是新的一次故障

    def test_bad_request_switches_once_without_holding(self):
        _, used = run(self.sw.call(self.attempts({PRIMARY: status_error(openai.BadRequestError, 400)})))
        self.assertEqual(used, FALLBACK)
        self.assertFalse(self.sw.holding)
        self.assertEqual(self.outages, [])

    def test_fallback_failing_while_holding_tries_primary(self):
        run(self.sw.call(self.attempts({PRIMARY: conn_error()})))
        self.calls.clear()
        _, used = run(self.sw.call(self.attempts({FALLBACK: conn_error()})))
        self.assertEqual((self.calls, used), ([FALLBACK, PRIMARY], PRIMARY))
        self.assertFalse(self.sw.holding)                    # 主模型能用了：切回来

    def test_both_fail_raises_the_last(self):
        e2 = status_error(openai.InternalServerError, 503)
        with self.assertRaises(openai.InternalServerError) as cm:
            run(self.sw.call(self.attempts({PRIMARY: conn_error(), FALLBACK: e2})))
        self.assertIs(cm.exception, e2)

    def test_control_flow_is_not_a_failure(self):
        from langgraph.errors import GraphInterrupt
        with self.assertRaises(GraphInterrupt):
            run(self.sw.call(self.attempts({PRIMARY: GraphInterrupt()})))
        self.assertEqual(self.calls, [PRIMARY])
        self.assertFalse(self.sw.holding)

    def test_without_fallback_only_primary(self):
        sw = ModelSwitch("k27")
        with self.assertRaises(openai.APIConnectionError):
            run(sw.call(self.attempts({PRIMARY: conn_error()})))
        self.assertEqual(self.calls, [PRIMARY])


class FakeCompletions:
    def __init__(self, name, fail=None):
        self.name, self.fail, self.calls = name, fail, 0

    async def create(self, model, messages, **kw):
        self.calls += 1
        if self.fail:
            raise self.fail
        usage = SimpleNamespace(prompt_tokens=10, completion_tokens=2, total_tokens=12)
        return SimpleNamespace(model=model, usage=usage, choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))])


def fake_client(name, fail=None):
    return SimpleNamespace(chat=SimpleNamespace(completions=FakeCompletions(name, fail)))


class ModelPoolTest(unittest.TestCase):
    def test_auxiliary_calls_fall_back(self):
        cfg = ModelConfig(url="http://kimi", name="k27", tokens=["a"], fallback={"name": "k26"})
        primary, fallback = fake_client("p", fail=conn_error()), fake_client("f")
        pool = pool_mod.ModelPool(cfg, client=primary, fallback_client=fallback)
        events = []

        async def on_call(run_id, ev):
            events.append(ev)
        pool.on_call = on_call
        resp = run(pool.chat([{"role": "user", "content": "x"}], run_id="r1", purpose="记忆沉淀"))
        self.assertEqual(resp.model, "k26")
        self.assertEqual((events[0]["model"], events[0]["fallback"]), ("k26", True))
        run(pool.chat([{"role": "user", "content": "x"}], run_id="r1"))
        self.assertEqual(primary.chat.completions.calls, 1)  # 主模型挂了那段时间不再先试它

    def test_both_fail_is_a_pool_error(self):
        cfg = ModelConfig(url="http://kimi", name="k27", tokens=["a"], fallback={"name": "k26"})
        pool = pool_mod.ModelPool(cfg, client=fake_client("p", conn_error()), fallback_client=fake_client("f", conn_error()))
        with self.assertRaises(pool_mod.ModelPoolError):
            run(pool.chat([{"role": "user", "content": "x"}]))


class TimeoutRetryTest(unittest.TestCase):
    """超时和别的错误分开算重试次数：超时只重试 timeout_retries 次，网关错误照样按 max_retries。"""

    def client(self, handler, timeout_retries=1, max_retries=6):
        http = pool_mod.QuotaClient(pool_mod.Quota(0), timeout_retries=timeout_retries,
                                    transport=httpx.MockTransport(handler))
        return openai.AsyncOpenAI(base_url="http://model/v1", api_key="k", http_client=http, max_retries=max_retries)

    def chat(self, client):
        async def go():
            with mock.patch.object(openai.AsyncOpenAI, "_calculate_retry_timeout", return_value=0):
                return await client.chat.completions.create(model="m", messages=[{"role": "user", "content": "x"}])
        return run(go())

    def test_timeouts_stop_after_timeout_retries(self):
        seen = []

        def handler(request):
            seen.append(request.headers.get("x-stainless-retry-count"))
            raise httpx.ReadTimeout("no data", request=request)
        with self.assertRaises(openai.APITimeoutError):
            self.chat(self.client(handler, timeout_retries=1, max_retries=6))
        self.assertEqual(seen, ["0", "1"])                   # 第一次 + 重试 1 次，不是 7 次

    def test_server_errors_use_max_retries(self):
        seen = []

        def handler(request):
            seen.append(1)
            return httpx.Response(502, json={"error": {"message": "bad gateway"}})
        with self.assertRaises(openai.InternalServerError):
            self.chat(self.client(handler, timeout_retries=1, max_retries=3))
        self.assertEqual(len(seen), 4)


class QuotaPerAccountTest(unittest.TestCase):
    def setUp(self):
        self.saved = dict(pool_mod._quotas)
        pool_mod._quotas.clear()

    def tearDown(self):
        pool_mod._quotas.clear()
        pool_mod._quotas.update(self.saved)

    def test_same_account_shares_slots(self):
        cfg = ModelConfig(url="http://kimi/", name="k27", tokens=["a"], fallback={"name": "k26", "max_concurrency": 9})
        q1 = pool_mod.quota(cfg)
        q2 = pool_mod.quota(cfg.fallback_config(), pool_mod.FALLBACK_SLOT_CLASS)
        self.assertIs(q1, q2)
        self.assertEqual((q1.concurrency, q1.slot_class), (3, 0x4147))
        other = ModelConfig(url="http://ds", name="ds", tokens=["b"])
        q3 = pool_mod.quota(other, pool_mod.FALLBACK_SLOT_CLASS)
        self.assertIsNot(q3, q1)
        self.assertEqual(q3.slot_class, 0x4148)


class FakeRequest:
    def __init__(self, model="primary-model"):
        self.model = model

    def override(self, **kw):
        return FakeRequest(kw.get("model", self.model))


class AgentFallbackTest(unittest.TestCase):
    def setUp(self):
        self.events = []

        async def log_event(run_id, kind, payload):
            self.events.append((kind, payload))
            return len(self.events)
        self.patch = mock.patch.object(factory.runs, "log_event", log_event)
        self.patch.start()
        self.scope = run_scope.bind(run_scope.RunScope(run_id="r", session_id="s", task="ask", env="test", protected=False))
        self.scope.__enter__()

    def tearDown(self):
        self.scope.__exit__(None, None, None)
        self.patch.stop()

    def test_step_retried_on_fallback_model(self):
        sw = ModelSwitch("k27", "k26")
        mw = factory._fallback_middleware(sw, {PRIMARY: "primary-model", FALLBACK: "fallback-model"})
        seen = []

        async def handler(req):
            seen.append(req.model)
            if req.model == "primary-model":
                raise conn_error()
            return f"answer from {req.model}"
        token = factory._BUDGET.set({"calls": 0, "max": 80})
        try:
            out = run(mw.awrap_model_call(FakeRequest(), handler))
            self.assertEqual(out, "answer from fallback-model")
            self.assertEqual(seen, ["primary-model", "fallback-model"])
            stage = [p for k, p in self.events if k == "stage"]
            self.assertEqual(stage[0]["stage"], "model_fallback")
            self.assertIn("k26", stage[0]["title"])
            seen.clear()
            run(mw.awrap_model_call(FakeRequest(), handler))       # 先用备用的时间里：直接用备用，说一次为什么
            run(mw.awrap_model_call(FakeRequest(), handler))
            self.assertEqual(seen, ["fallback-model", "fallback-model"])
            notes = [p for k, p in self.events if k == "stage" and "先用备用模型" in p["title"]]
            self.assertEqual(len(notes), 1)
        finally:
            factory._BUDGET.reset(token)

    def test_summarizer_falls_back(self):
        sw = ModelSwitch("k27", "k26")

        class M:
            def __init__(self, fail):
                self.fail, self.prompts = fail, []

            async def ainvoke(self, prompt):
                self.prompts.append(prompt)
                if self.fail:
                    raise conn_error()
                return SimpleNamespace(content="  摘要  ")
        p, f = M(True), M(False)
        from langchain_core.messages import HumanMessage
        summarize = factory._summarizer(sw, {PRIMARY: p, FALLBACK: f}, "压缩：{messages}")
        self.assertEqual(run(summarize([HumanMessage("你好")])), "摘要")
        self.assertTrue(f.prompts[0].startswith("压缩："))
        self.assertIn("你好", f.prompts[0])

    def test_model_call_event_marks_fallback(self):
        msg = SimpleNamespace(usage_metadata={"total_tokens": 5, "input_tokens": 4, "output_tokens": 1}, tool_calls=[],
                              content="hi", additional_kwargs={})
        started = {"x": (0.0, 0.0)}
        ev = {"event": "on_chat_model_end", "run_id": "x", "data": {"output": msg},
              "metadata": {"ls_model_name": "k26", "agent_model": FALLBACK}}
        run(factory._record("r", ev, started, [0.0]))
        call = [p for k, p in self.events if k == "model_call"][0]
        self.assertEqual((call["model"], call.get("fallback")), ("k26", True))


if __name__ == "__main__":
    unittest.main()
