"""Langfuse 集成：prompt 源头 + OTEL trace + 反馈回写。

三层职责：
1. **prompt 源头**：角色定义（prompt=系统提示文本 / config=工具等结构化配置）
   存 Langfuse，name="role:<角色名>"，label 区分灰度。读取路径：
   Langfuse API → 进程内缓存（TTL 秒级）→ PG definitions 表（写穿持久缓存）。
   Langfuse 挂了用缓存，缓存空用 PG——服务可独立存活。
2. **观测**：OTLP exporter 指向 Langfuse 的 OTEL 端点，LangChainInstrumentor
   自动覆盖模型/工具调用；run span 挂业务属性。
3. **反馈回写**：👍/👎/纠正文字写为 Langfuse score，评估侧直接可用。

enabled=false：全部空操作，角色定义直接读 PG definitions 表（降级模式）。
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any

from .config import LangfuseConfig

log = logging.getLogger(__name__)


class LangfuseClient:
    """Langfuse 门面：平台其余代码只跟它打交道。"""

    def __init__(self, cfg: LangfuseConfig):
        self._cfg = cfg
        self._prompt_cache: dict[str, tuple[float, dict]] = {}

    @property
    def enabled(self) -> bool:
        return self._cfg.enabled

    @property
    def host(self) -> str:
        return self._cfg.host

    # ---- prompt 源头 ----

    async def fetch_role(self, name: str, pg_fallback) -> dict | None:
        """取角色定义。pg_fallback: async get_cache(name)/put_cache(name, def)。

        返回 {"prompt": ..., "tools": [...], ...}；拿不到返回 None。
        """
        cache_key = f"role:{name}"
        hit = self._prompt_cache.get(cache_key)
        if hit and time.monotonic() - hit[0] < self._cfg.prompt_cache_ttl_s:
            return hit[1]
        definition = await self._fetch_remote(name)
        if definition is not None:
            self._prompt_cache[cache_key] = (time.monotonic(), definition)
            try:
                await pg_fallback.put_cache(name, definition)  # 写穿 PG
            except Exception:  # noqa: BLE001 —— 缓存写失败不影响主流程
                log.warning("role %s 写穿 PG 缓存失败", name)
            return definition
        # 远端失败：进程内过期缓存 → PG 持久缓存
        if hit:
            return hit[1]
        return await pg_fallback.get_cache(name)

    async def _fetch_remote(self, name: str) -> dict | None:
        if not self.enabled:
            return None
        try:
            import httpx
            url = (f"{self._cfg.host}/api/public/v2/prompts/role:{name}"
                   f"?label={self._cfg.prompt_label}")
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(url, headers=self._auth())
            if resp.status_code != 200:
                return None
            data = resp.json()
            definition = {"prompt": data.get("prompt", "")}
            definition.update(data.get("config") or {})
            return definition
        except Exception:  # noqa: BLE001
            log.warning("Langfuse 拉取 role:%s 失败，走缓存降级", name)
            return None

    async def put_role(self, name: str, definition: dict,
                       updated_by: str = "") -> None:
        """写角色定义到 Langfuse（产生新版本；label 提升由 Langfuse UI/API 管）。"""
        if not self.enabled:
            raise RuntimeError("Langfuse 未启用，角色定义只能写 PG（降级模式）")
        import httpx
        config = {k: v for k, v in definition.items() if k != "prompt"}
        body = {
            "name": f"role:{name}",
            "prompt": definition.get("prompt", ""),
            "config": config,
            "labels": [self._cfg.prompt_label],  # 新版本直接接管 label
            "type": "text",
        }
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{self._cfg.host}/api/public/v2/prompts",
                                     json=body, headers=self._auth())
            resp.raise_for_status()
        self._prompt_cache.pop(f"role:{name}", None)

    # ---- 反馈回写 ----

    async def score(self, trace_id: str, name: str, value: float,
                    comment: str = "") -> bool:
        """把反馈写为 Langfuse score（挂在 trace 上）。失败只记日志。"""
        if not self.enabled or not trace_id:
            return False
        try:
            import httpx
            body = {"traceId": trace_id, "name": name, "value": value,
                    "comment": comment}
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(f"{self._cfg.host}/api/public/scores",
                                         json=body, headers=self._auth())
            return resp.status_code < 400
        except Exception:  # noqa: BLE001
            log.warning("Langfuse score 写入失败")
            return False

    # ---- 内部 ----

    def _auth(self) -> dict[str, str]:
        token = base64.b64encode(
            f"{self._cfg.public_key}:{self._cfg.secret_key}".encode()).decode()
        return {"Authorization": f"Basic {token}"}


# ==================== 观测（OTEL → Langfuse） ====================

_tracer: Any = None


def setup_observability(cfg: LangfuseConfig) -> None:
    """注册 OTLP exporter（指向 Langfuse OTEL 端点）+ LangChain 自动探针。"""
    global _tracer
    if not cfg.enabled:
        return
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter)
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from openinference.instrumentation.langchain import LangChainInstrumentor

    auth = base64.b64encode(f"{cfg.public_key}:{cfg.secret_key}".encode()).decode()
    exporter = OTLPSpanExporter(
        endpoint=f"{cfg.host}/api/public/otel/v1/traces",
        headers={"Authorization": f"Basic {auth}"})
    provider = TracerProvider(resource=Resource.create(
        {"service.name": "agent-platform"}))
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    LangChainInstrumentor().instrument(tracer_provider=provider)
    _tracer = trace.get_tracer("agent_platform")
    log.info("Langfuse tracing enabled: %s", cfg.host)


def tracer() -> Any:
    """全局 tracer；未启用观测时为 None（调用方走空上下文）。"""
    return _tracer
