"""可选的链路追踪：OTEL → Langfuse（或任何 OTLP 端点）。

只做后台观测：模型调用、工具调用自动成 span（LangChain 探针），每次运行一个根 span，
挂 run_id / 任务 / 服务 / 环境属性，在 Langfuse 里按这些属性检索。
页面不依赖它——运行详情的时间线来自平台自己的 run_events。未启用时全部空操作。
"""

from __future__ import annotations

import base64
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from .config import LangfuseConfig

log = logging.getLogger(__name__)

_tracer: Any = None


def setup(cfg: LangfuseConfig) -> None:
    global _tracer
    if not cfg.enabled or _tracer is not None:
        return
    try:
        from openinference.instrumentation.langchain import LangChainInstrumentor
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        log.warning("开启了 langfuse 但未安装 obs 依赖（pip install 'agent-platform[obs]'），链路追踪关闭")
        return
    auth = base64.b64encode(f"{cfg.public_key}:{cfg.secret_key}".encode()).decode()
    provider = TracerProvider(resource=Resource.create({"service.name": "agent-platform"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(
        endpoint=f"{cfg.host.rstrip('/')}/api/public/otel/v1/traces", headers={"Authorization": f"Basic {auth}"})))
    trace.set_tracer_provider(provider)
    LangChainInstrumentor().instrument(tracer_provider=provider)
    _tracer = trace.get_tracer("agent_platform")
    log.info("链路追踪已开启：%s", cfg.host)


@contextmanager
def run_span(name: str, **attrs: Any) -> Iterator[None]:
    if _tracer is None:
        yield
        return
    with _tracer.start_as_current_span(name, attributes={f"agent.{k}": str(v) for k, v in attrs.items() if v is not None}):
        yield
