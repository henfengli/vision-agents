"""可选的链路追踪：OTEL → 任意 OTLP/HTTP 后端（Jaeger、Tempo、各家 APM）。

只做后台观测：LangChain 探针把模型调用、工具调用自动做成 span，每次运行一个根 span，
挂 run_id / 任务 / 服务 / 环境属性，在后端里按这些属性检索；平台自己发起的辅助模型调用
（记忆沉淀、交接摘要、回归判定）也各包一个 span。
页面不依赖它——运行详情的时间线（含每次模型调用的耗时与 token）来自平台自己的 run_events。未启用时全部空操作。
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterator

from .config import OtelConfig

log = logging.getLogger(__name__)

_tracer: Any = None


def setup(cfg: OtelConfig) -> None:
    global _tracer
    if not cfg.enabled or _tracer is not None:
        return
    try:
        from openinference.instrumentation.langchain import LangChainInstrumentor
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        log.warning("开启了 otel 但未安装 obs 依赖（pip install 'agent-platform[obs]'），链路追踪关闭")
        return
    provider = TracerProvider(resource=Resource.create({"service.name": "agent-platform"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=cfg.endpoint, headers=cfg.headers)))
    trace.set_tracer_provider(provider)
    LangChainInstrumentor().instrument(tracer_provider=provider)
    _tracer = trace.get_tracer("agent_platform")
    log.info("链路追踪已开启：%s", cfg.endpoint)


@contextmanager
def run_span(name: str, **attrs: Any) -> Iterator[None]:
    if _tracer is None:
        yield
        return
    with _tracer.start_as_current_span(name, attributes={f"agent.{k}": str(v) for k, v in attrs.items() if v is not None}):
        yield
