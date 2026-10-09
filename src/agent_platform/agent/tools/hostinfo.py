"""host_metrics 薄工具：查业务域部署主机的实时资源状况（内存/负载/根盘）。

链路：domain+env → 域包登记的主机列表（domain.yaml 的 hosts 字段）
→ Grafana datasource proxy → Prometheus(node_exporter) → markdown 表。

不让 agent 用 bash curl 查监控的原因（与 sql_query 同理）：
LLM 现场拼命令，审查层只有正则，管不住"该访问哪个地址、什么方法"；
薄工具把数据源、指标集、输出格式固化，LLM 只能选域和环境。

可测性：HTTP 只有一个 grafana_query()；collect() 注入 fetch 纯函数测试。
"""

from __future__ import annotations

import re

import httpx

_TIMEOUT_S = 10.0


def instance_regex(hosts: list[str]) -> str:
    """主机列表 → instance 标签的正则（匹配 "1.2.3.4" 与 "1.2.3.4:9100" 两种登记法）。"""
    alts = "|".join(re.escape(h) for h in hosts)
    return f"^({alts})(:\\d+)?$"


# 指标集即全部护栏：LLM 碰不到 PromQL，只在这几组固定查询里出数
def _queries(inst_re: str) -> dict[str, str]:
    m = f'{{instance=~"{inst_re}"}}'
    fs = f'{{instance=~"{inst_re}",mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}}'
    return {
        "mem_total": f"node_memory_MemTotal_bytes{m}",
        "mem_avail": f"node_memory_MemAvailable_bytes{m}",
        "load1": f"node_load1{m}",
        "cores": f'count by (instance) (node_cpu_seconds_total{{mode="system",'
                 f'instance=~"{inst_re}"}})',
        "disk_size": f"node_filesystem_size_bytes{fs}",
        "disk_avail": f"node_filesystem_avail_bytes{fs}",
    }


async def grafana_query(base_url: str, datasource_uid: str, token: str,
                        expr: str) -> dict[str, float]:
    """经 Grafana datasource proxy 发一次 instant query；返回 {instance: value}。

    用 proxy 而不是直连 Prometheus：Grafana 已是内网统一入口，后端地址/认证
    收在 Grafana 侧，平台只要一个 service account token。
    """
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    url = f"{base_url.rstrip('/')}/api/datasources/proxy/uid/{datasource_uid}/api/v1/query"
    async with httpx.AsyncClient(timeout=_TIMEOUT_S, headers=headers) as c:
        r = await c.get(url, params={"query": expr})
        r.raise_for_status()
        payload = r.json()
    if payload.get("status") != "success":
        raise RuntimeError(str(payload)[:300])
    out = {}
    for item in payload["data"]["result"]:
        inst = item["metric"].get("instance", "")
        out[inst] = float(item["value"][1])
    return out


def _host_of(instance: str, hosts: list[str]) -> str:
    """instance（可能带 :9100 端口）归一到域包登记的主机名。"""
    bare = instance.rsplit(":", 1)[0] if ":" in instance else instance
    return bare if bare in hosts else instance


def collect_render(results: dict[str, dict[str, float]],
                   hosts: list[str]) -> str:
    """各指标查询结果 → 每台主机一行 markdown。无数据的主机显式列出（不漏报）。"""
    def pick(key: str, host: str) -> float | None:
        for inst, v in results.get(key, {}).items():
            if _host_of(inst, hosts) == host:
                return v
        return None

    gb = 1024 ** 3
    lines = ["| 主机 | 内存 | 负载(load1/核) | 根盘 |", "|---|---|---|---|"]
    for h in hosts:
        mt, ma = pick("mem_total", h), pick("mem_avail", h)
        load, cores = pick("load1", h), pick("cores", h)
        ds, da = pick("disk_size", h), pick("disk_avail", h)
        if mt is None and load is None and ds is None:
            lines.append(f"| {h} | 无数据 | 无数据 | 无数据 |")
            continue
        mem = (f"{(mt - ma) / mt * 100:.0f}%（{(mt - ma) / gb:.1f}/{mt / gb:.0f}G）"
               if mt and ma is not None else "—")
        ld = (f"{load:.2f} / {cores:.0f} 核"
              if load is not None and cores else "—")
        disk = (f"{(ds - da) / ds * 100:.0f}%（{(ds - da) / gb:.0f}/{ds / gb:.0f}G）"
                if ds and da is not None else "—")
        lines.append(f"| {h} | {mem} | {ld} | {disk} |")
    return "\n".join(lines)


async def collect(fetch, hosts: list[str]) -> str:
    """对每个指标并发查询并渲染。fetch: expr → {instance: value}。"""
    import asyncio

    qs = _queries(instance_regex(hosts))

    async def one(key: str, expr: str) -> tuple[str, dict[str, float]]:
        return key, await fetch(expr)

    pairs = await asyncio.gather(*[one(k, e) for k, e in qs.items()])
    return collect_render(dict(pairs), hosts)
