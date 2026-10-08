"""LinkedIn DataHub MCP server（FastMCP，stdio）：元数据/血缘查询工具集。

用途：数据口径问答（数据表 schema/描述/负责人/标签）、影响面分析
（上下游血缘）、按域浏览数据资产——data_searcher 角色的"查口径先查
DataHub"入口。对接 DataHub GMS 的 GraphQL API（/api/graphql）。

运行：python mcp_servers/datahub_mcp.py
配置：agent-platform 的 settings.mcp_servers = {"datahub": {"transport": "stdio",
      "command": "python", "args": ["mcp_servers/datahub_mcp.py"]}}
环境变量：DATAHUB_GMS_URL（默认 http://127.0.0.1:8080）/
      DATAHUB_TOKEN（Personal Access Token，无鉴权部署可留空）

设计要点：
- 只做只读查询（search/dataset/lineage/domains 四工具），不做元数据写
- GraphQL 查询是模块级常量，响应解析是纯函数——单测不需要真 DataHub
- 返回紧凑 dict（字段裁到模型够用），错误信息截断上交
"""

from __future__ import annotations

import os

import httpx

GMS_URL = os.environ.get("DATAHUB_GMS_URL", "http://127.0.0.1:8080").rstrip("/")
TOKEN = os.environ.get("DATAHUB_TOKEN", "")

# 搜索覆盖的实体类型（dataset 为主；dashboard/chart 只回 urn+type）
_SEARCHABLE = ["DATASET", "DATA_FLOW", "DATA_JOB", "GLOSSARY_TERM", "DOMAIN"]

_Q_SEARCH = """
query($input: SearchAcrossEntitiesInput!){
  searchAcrossEntities(input:$input){
    total
    searchResults{ entities{ urn type
      ... on Dataset { name properties { description } }
      ... on DataFlow { properties { name } }
      ... on DataJob { properties { name } }
      ... on GlossaryTerm { name properties { definition } }
      ... on Domain { properties { name description } } } } } }
"""

_Q_DATASET = """
query($urn: String!){
  dataset(urn:$urn){
    urn name platform { name }
    properties { description }
    schemaMetadata { fields { fieldPath type nullable description } }
    owners { owners { owner { __typename
      ... on CorpUser { urn username } ... on CorpGroup { urn name } } } }
    globalTags { tags { tag { urn name } } }
    glossaryTerms { terms { urn name } }
    domain { domain { urn properties { name } } } } }
"""

_Q_LINEAGE = """
query($input: SearchAcrossLineageInput!){
  searchAcrossLineage(input:$input){
    total
    searchResults{ degree entity{ urn type
      ... on Dataset { name } ... on DataJob { properties { name } }
      ... on DataFlow { properties { name } } } } } }
"""


async def _gql(query: str, variables: dict | None = None) -> dict:
    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
    async with httpx.AsyncClient(base_url=GMS_URL, timeout=20,
                                 headers=headers) as c:
        r = await c.post("/api/graphql",
                         json={"query": query, "variables": variables or {}})
        r.raise_for_status()
        data = r.json()
        if data.get("errors"):
            raise RuntimeError(str(data["errors"])[:500])
        return data["data"]


# ==================== 响应解析（纯函数，测试面） ====================

def _entity_summary(e: dict) -> dict:
    """实体 → 紧凑摘要：urn/type + 尽量拿到名字与一句描述。"""
    out = {"urn": e["urn"], "type": e["type"]}
    props = e.get("properties") or {}
    name = e.get("name") or props.get("name") or ""
    desc = props.get("description") or props.get("definition") or ""
    if name:
        out["name"] = name
    if desc:
        out["description"] = desc[:200]
    return out


def _parse_search(data: dict) -> dict:
    result = data.get("searchAcrossEntities") or {}
    return {"total": result.get("total", 0),
            "entities": [_entity_summary(e)
                         for e in result.get("searchResults") or []]}


def _parse_dataset(d: dict | None, urn: str) -> dict:
    if not d:
        raise RuntimeError(f"数据集不存在或无权访问：{urn}")
    owners = []
    for o in (d.get("owners") or {}).get("owners") or []:
        who = o.get("owner") or {}
        owners.append(who.get("username") or who.get("name") or who.get("urn", ""))
    fields = (d.get("schemaMetadata") or {}).get("fields") or []
    return {
        "urn": d["urn"], "name": d.get("name", ""),
        "platform": (d.get("platform") or {}).get("name", ""),
        "description": (d.get("properties") or {}).get("description", ""),
        "domain": ((d.get("domain") or {}).get("domain") or {})
        .get("properties", {}).get("name", ""),
        "owners": owners,
        "tags": [t["tag"].get("name", "")
                 for t in (d.get("globalTags") or {}).get("tags") or []],
        "glossary_terms": [t.get("name", "")
                           for t in (d.get("glossaryTerms") or {}).get("terms") or []],
        "fields": [{"name": f["fieldPath"], "type": f.get("type", ""),
                    "nullable": f.get("nullable", True),
                    "description": (f.get("description") or "")[:100]}
                   for f in fields],
    }


def _parse_lineage(data: dict) -> dict:
    result = data.get("searchAcrossLineage") or {}
    return {"total": result.get("total", 0),
            "entities": [{"degree": r.get("degree", 0),
                          **_entity_summary(r["entity"])}
                         for r in result.get("searchResults") or []]}


# ==================== 工具（FastMCP 注册在 main()） ====================

async def datahub_search(query: str, types: str = "", limit: int = 10) -> dict:
    """按关键字搜数据资产（表/任务/术语/域）。types 逗号分隔实体类型过滤
    （如 "DATASET,DASHBOARD"，缺省搜常用类型）。返回 total + 实体摘要列表。"""
    type_list = ([t.strip().upper() for t in types.split(",") if t.strip()]
                 or _SEARCHABLE)
    data = await _gql(_Q_SEARCH, {"input": {
        "types": type_list, "query": query, "start": 0, "count": limit}})
    return _parse_search(data)


async def datahub_get_dataset(urn: str) -> dict:
    """拿数据集详情：schema 字段/描述/负责人/标签/术语/所属域。
    urn 形如 urn:li:dataset:(urn:li:dataPlatform:hive,db.table,PROD)。"""
    return _parse_dataset((await _gql(_Q_DATASET, {"urn": urn})).get("dataset"),
                          urn)


async def datahub_get_lineage(urn: str, direction: str = "UPSTREAM",
                              limit: int = 20) -> dict:
    """血缘遍历：UPSTREAM 看上游依赖 / DOWNSTREAM 看下游影响面。
    返回实体列表，degree 是与起点的距离（1=直接相邻）。"""
    direction = direction.upper()
    if direction not in ("UPSTREAM", "DOWNSTREAM"):
        raise ValueError("direction 只能是 UPSTREAM 或 DOWNSTREAM")
    data = await _gql(_Q_LINEAGE, {"input": {
        "urn": urn, "direction": direction, "query": "*",
        "start": 0, "count": limit}})
    return _parse_lineage(data)


async def datahub_list_domains(limit: int = 50) -> dict:
    """列出数据域（DataHub Domain）：按业务域浏览资产的入口。"""
    data = await _gql(_Q_SEARCH, {"input": {
        "types": ["DOMAIN"], "query": "*", "start": 0, "count": limit}})
    return _parse_search(data)


_TOOLS = (datahub_search, datahub_get_dataset, datahub_get_lineage,
          datahub_list_domains)


def build_server():
    """装配 FastMCP 实例（延迟导入：工具逻辑不依赖 mcp 包，可直接单测）。"""
    from fastmcp import FastMCP
    server = FastMCP("datahub")
    for fn in _TOOLS:
        server.tool(fn)
    return server


if __name__ == "__main__":
    build_server().run()
