"""Langfuse 集成：prompt 源头 + OTEL trace + 反馈回写。

底层是官方 SDK（langfuse.Langfuse），平台只保留 SDK 没有的韧性层：

1. **prompt 源头**：角色定义存 Langfuse，name="role:<角色名>"，label 区分灰度。
   SDK 的 get_prompt(label=..., cache_ttl_seconds=...) 负责拉取与进程内 TTL
   缓存（create_prompt 会使对应缓存失效，写入即时生效）。SDK 失败时（服务挂
   了/网络断）SDK 直接抛错，这里补上两级降级：进程内 last-known-good
   （本进程拿到过的最后一份定义）→ PG definitions 写穿持久缓存。
   Langfuse 挂了服务可独立存活。
2. **观测**：OTLP exporter 指向 Langfuse 的 OTEL 端点（self-hosted 官方摄入
   路径），LangChainInstrumentor 自动覆盖模型/工具调用；run span 挂业务属性。
   SDK client 以 tracing_enabled=False 构造——tracing 由本模块的 OTEL 管线
   统一拥有，SDK 只负责 prompt/score 数据 API。
3. **反馈回写**：👍/👎/纠正文字经 SDK create_score 挂 trace；节点级反馈经
   match_observation 把步骤 seq 映射到 observation id，score 直接挂 span
   （等价 UI 的 Annotate，走 API 不需要登录态）。SDK 批量异步入队，关停前
   flush() 冲刷。

enabled=false：全部空操作（_client 为 None），角色定义直接读 PG（降级模式）。
"""

from __future__ import annotations

import asyncio
import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import LangfuseConfig

log = logging.getLogger(__name__)


class LangfuseClient:
    """Langfuse 门面：平台其余代码只跟它打交道。

    client_factory 可注入（测试不依赖 langfuse 包/服务）；缺省是官方
    langfuse.Langfuse，延迟导入——langfuse 在 obs extra 里，属可选依赖。
    """

    def __init__(self, cfg: LangfuseConfig, client_factory: Any = None):
        self._cfg = cfg
        self._client: Any = None
        # 进程内 last-known-good：SDK 缓存过期且远端失败时的中间降级层
        self._last_known: dict[str, dict] = {}
        self._pid: str | None = None  # trace 页 URL 用，首次解析后缓存
        self._published: set[str] = set()  # 已设为公开链接的 trace id（幂等去重）
        if not cfg.enabled:
            return
        if client_factory is None:
            from langfuse import Langfuse
            client_factory = Langfuse
        self._client = client_factory(
            public_key=cfg.public_key,
            secret_key=cfg.secret_key,
            host=cfg.host,
            # tracing 由 setup_observability 的 OTEL 管线拥有；SDK 只当数据客户端
            tracing_enabled=False,
        )

    @property
    def enabled(self) -> bool:
        return self._client is not None

    @property
    def host(self) -> str:
        return self._cfg.host

    @property
    def embed(self) -> bool:
        return self._cfg.embed

    @property
    def publish(self) -> bool:
        return self._cfg.publish

    # ---- prompt 源头 ----

    async def fetch_role(self, name: str, pg_fallback) -> dict | None:
        """取角色定义。pg_fallback: async get_cache(name)/put_cache(name, def)。

        返回 {"prompt": ..., "tools": [...], ...}；拿不到返回 None。
        降级链：SDK（自带 TTL 缓存）→ 进程内 last-known-good → PG 持久缓存。
        """
        if self._client is None:
            return await pg_fallback.get_cache(name)
        definition = await self._fetch_remote(name)
        if definition is not None:
            self._last_known[name] = definition
            try:
                await pg_fallback.put_cache(name, definition)  # 写穿 PG
            except Exception:  # noqa: BLE001 —— 缓存写失败不影响主流程
                log.warning("role %s 写穿 PG 缓存失败", name)
            return definition
        if name in self._last_known:
            return self._last_known[name]
        return await pg_fallback.get_cache(name)

    async def _fetch_remote(self, name: str) -> dict | None:
        try:
            prompt = await asyncio.to_thread(
                self._client.get_prompt,
                f"role:{name}",
                label=self._cfg.prompt_label,
                cache_ttl_seconds=max(1, int(self._cfg.prompt_cache_ttl_s)),
                fetch_timeout_seconds=5,
            )
        except Exception:  # noqa: BLE001 —— 远端任何失败都走降级链
            log.warning("Langfuse 拉取 role:%s 失败，走缓存降级", name)
            return None
        return {"prompt": prompt.prompt, **(prompt.config or {})}

    async def put_role(self, name: str, definition: dict,
                       updated_by: str = "") -> None:
        """写角色定义到 Langfuse（产生新版本并接管 label）。

        SDK create_prompt 会使该 prompt 的缓存失效，下一次 fetch 即读到新版；
        进程内 last-known 同步更新，不等下一次拉取。
        """
        if self._client is None:
            raise RuntimeError("Langfuse 未启用，角色定义只能写 PG（降级模式）")
        config = {k: v for k, v in definition.items() if k != "prompt"}
        await asyncio.to_thread(
            self._client.create_prompt,
            name=f"role:{name}",
            prompt=definition.get("prompt", ""),
            config=config,
            labels=[self._cfg.prompt_label],  # 新版本直接接管 label
            type="text",
            commit_message=f"by {updated_by}" if updated_by else None,
        )
        self._last_known[name] = definition

    # ---- trace 直达 ----

    async def trace_url(self, trace_id: str) -> str:
        """Langfuse trace 页直达链接（/project/{pid}/traces/{tid}）。

        未启用 / project id 解析失败返回空串——调用方降级为"手动搜索"文案。
        """
        if self._client is None or not trace_id:
            return ""
        pid = await self._project_id()
        if not pid:
            return ""
        return f"{self._cfg.host}/project/{pid}/traces/{trace_id}"

    async def _project_id(self) -> str:
        """public API 解析 project id（自托管单项目，解析一次进程内缓存）。"""
        if self._pid is not None:
            return self._pid
        try:
            auth = base64.b64encode(
                f"{self._cfg.public_key}:{self._cfg.secret_key}"
                .encode()).decode()
            data = await asyncio.to_thread(
                _http_get_json, f"{self._cfg.host}/api/public/projects",
                {"Authorization": f"Basic {auth}"})
            items = data.get("data") or []
            self._pid = items[0].get("id", "") if items else ""
        except Exception:  # noqa: BLE001 —— 解析失败不影响详情页其余部分
            log.warning("Langfuse project id 解析失败，trace 链接降级为手动搜索")
            self._pid = ""
        return self._pid

    # ---- trace 内嵌（公开链接 + frame 探测） ----

    async def publish_trace(self, trace_id: str) -> bool:
        """把 trace 设为公开链接（免登可查看）——iframe 内嵌的前提。

        走 ingestion API 的 trace-create 更新（与 Langfuse UI"分享"按钮同一
        数据通路：同 id 合并，只动 public 字段）；幂等，进程内去重。失败返回
        False——调用方降级为外链，不影响详情页其余部分。"""
        if (self._client is None or not trace_id or not self._cfg.embed
                or not self._cfg.publish or trace_id in self._published):
            # publish=false（同站点登录态部署）：视为"已就绪"，不公开 trace
            return not self._cfg.publish or trace_id in self._published
        try:
            auth = base64.b64encode(
                f"{self._cfg.public_key}:{self._cfg.secret_key}"
                .encode()).decode()
            await asyncio.to_thread(
                _http_post_json, f"{self._cfg.host}/api/public/ingestion",
                {"batch": [{
                    "id": uuid.uuid4().hex,          # 事件 id 每次唯一（去重键）
                    "type": "trace-create",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "body": {"id": trace_id, "public": True},
                }]},
                {"Authorization": f"Basic {auth}"})
            self._published.add(trace_id)
            return True
        except Exception:  # noqa: BLE001 —— 公开设置失败只降级，不放大
            log.warning("Langfuse trace 公开设置失败，内嵌降级为外链")
            return False

    async def frame_check(self, url: str) -> bool:
        """探测 Langfuse 是否允许被 iframe 嵌入（响应头无 X-Frame-Options /
        CSP frame-ancestors 限制）。自托管默认带 SAMEORIGIN——网关剥头后
        本探测自动转 True（结果不缓存，修好即生效）。异常一律 False。"""
        try:
            headers = await asyncio.to_thread(_http_headers, url)
        except Exception:  # noqa: BLE001 —— 不可达/超时都按不可嵌入处理
            return False
        if "x-frame-options" in headers:
            return False
        return "frame-ancestors" not in headers.get(
            "content-security-policy", "").lower()

    # ---- 反馈回写 ----

    async def observations(self, trace_id: str) -> list[dict]:
        """拉 trace 的全部 observation（span）：id/name/type/startTime。

        用途单一：节点级反馈把 step seq 映射到 span id（Annotate 的 API 等价
        物——score 带 observation_id 即挂在那个 span 上）。失败返回空表，
        调用方降级为 trace 级 score。"""
        if self._client is None or not trace_id:
            return []
        try:
            auth = base64.b64encode(
                f"{self._cfg.public_key}:{self._cfg.secret_key}"
                .encode()).decode()
            data = await asyncio.to_thread(
                _http_get_json,
                f"{self._cfg.host}/api/public/observations?traceId={trace_id}",
                {"Authorization": f"Basic {auth}"})
            return data.get("data") or []
        except Exception:  # noqa: BLE001 —— 拉不到就降级，不放大
            log.warning("Langfuse observations 拉取失败，步骤反馈降级 trace 级")
            return []

    async def score(self, trace_id: str, name: str, value: float,
                    comment: str = "",
                    observation_id: str | None = None) -> bool:
        """把反馈写为 Langfuse score。给 observation_id 即挂到对应 span
        （等价 UI 的 Annotate），否则挂 trace。失败只记日志。"""
        if self._client is None or not trace_id:
            return False
        try:
            kw = dict(trace_id=trace_id, name=name, value=value,
                      data_type="NUMERIC", comment=comment or None)
            if observation_id:
                kw["observation_id"] = observation_id
            await asyncio.to_thread(self._client.create_score, **kw)
            return True
        except Exception:  # noqa: BLE001
            log.warning("Langfuse score 写入失败")
            return False

    # ---- 生命周期 ----

    async def flush(self) -> None:
        """关停前冲刷 SDK 队列（score 批量异步入队，不冲刷会丢尾部反馈）。"""
        if self._client is not None:
            try:
                await asyncio.to_thread(self._client.flush)
            except Exception:  # noqa: BLE001 —— 关停路径不再放大故障
                log.warning("Langfuse flush 失败")


def match_observation(events: list[dict], seq: int,
                      observations: list[dict]) -> str | None:
    """把时间线步骤（run_events.seq）映射到 Langfuse observation id。

    对齐规则（OTEL 探针的 span 命名）：
    - 工具步骤（tool_call/tool_result）→ observation.name == 工具名
    - 模型步骤（llm/final）→ observation.type == GENERATION
    同名多次出现按 startTime 排序后取第 n 次（n = 该事件在同类事件中的
    次序）。映射不上（思考/备注/trace 行、名称对不上）返回 None——调用方
    降级为 trace 级 score，绝不瞎挂。
    """
    target = next((e for e in events if e.get("seq") == seq), None)
    if target is None:
        return None
    kind = target.get("kind")
    payload = target.get("payload") if isinstance(
        target.get("payload"), dict) else {}
    if kind in ("tool_call", "tool_result") and payload.get("tool"):
        cands = [o for o in observations if o.get("name") == payload["tool"]]
        # tool_call/tool_result 是同一次工具执行的两条台账事件：第几次执行
        # 按它之前同工具的 tool_call 条数算；tool_result 会把本对儿的 call
        # 也数进去，减一回退到同一次执行
        idx = sum(1 for e in events
                  if e.get("seq", 0) < seq and e.get("kind") == "tool_call"
                  and isinstance(e.get("payload"), dict)
                  and e["payload"].get("tool") == payload["tool"])
        if kind == "tool_result":
            idx = max(0, idx - 1)
    elif kind in ("llm", "final"):
        cands = [o for o in observations if o.get("type") == "GENERATION"]
        idx = sum(1 for e in events
                  if e.get("seq", 0) < seq and e.get("kind") in ("llm", "final"))
    else:
        return None
    cands.sort(key=lambda o: o.get("startTime") or "")
    return cands[idx].get("id") if 0 <= idx < len(cands) else None


def _http_get_json(url: str, headers: dict) -> dict:
    """极简 GET JSON（测试可替身）；public API 用，不走 SDK。"""
    import json as _json
    import urllib.request
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return _json.loads(resp.read())


def _http_post_json(url: str, payload: dict, headers: dict) -> int:
    """极简 POST JSON（测试可替身）；ingestion 用，207/2xx 即成功。"""
    import json as _json
    import urllib.request
    req = urllib.request.Request(
        url, data=_json.dumps(payload).encode(), method="POST",
        headers={**headers, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status


def _http_headers(url: str) -> dict:
    """GET 只取响应头（小写键，测试可替身）；body 不读——trace 页是 SSR 大页。"""
    import urllib.request
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=5) as resp:
        return {k.lower(): v for k, v in resp.headers.items()}


# ==================== 观测（OTEL → Langfuse） ====================
# 这一层用的全是官方组件：OTEL SDK + openinference 的 LangChain 探针 +
# Langfuse 的 OTEL 摄入端点（self-hosted 官方接入路径）。

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
