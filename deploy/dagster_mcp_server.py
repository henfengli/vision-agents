"""参考实现：Dagster 内部 MCP server（FastMCP，stdio）。

把 Dagster GraphQL 包成带 schema 的类型化工具，agent 不再靠 curl 猜接口。
运行：fastmcp run deploy/dagster_mcp_server.py  （或 python deploy/dagster_mcp_server.py）
配置：agent-platform 的 settings.mcp_servers = {"dagster": {"transport": "stdio",
      "command": "python", "args": ["deploy/dagster_mcp_server.py"]}}
"""

import os

import httpx
from fastmcp import FastMCP

DAGSTER_URL = os.environ.get("DAGSTER_URL", "http://127.0.0.1:3000")

mcp = FastMCP("dagster")


async def _gql(query: str, variables: dict | None = None) -> dict:
    async with httpx.AsyncClient(base_url=DAGSTER_URL, timeout=15) as c:
        r = await c.post("/graphql",
                         json={"query": query, "variables": variables or {}})
        r.raise_for_status()
        data = r.json()
        if data.get("errors"):
            raise RuntimeError(str(data["errors"])[:500])
        return data["data"]


@mcp.tool
async def get_run(run_id: str) -> dict:
    """拿一次 Dagster run 的状态、失败步骤与报错摘要。"""
    data = await _gql(
        "query($id: ID!){ runOrError(runId:$id){ __typename ... on Run { "
        "status runId jobName startTime endTime } ... on PythonError { message } } }",
        {"id": run_id})
    return data["runOrError"]


@mcp.tool
async def get_run_logs(run_id: str, limit: int = 50) -> list[dict]:
    """拿 run 的事件日志（错误/物料化），按时间倒序截取。"""
    data = await _gql(
        "query($id: ID!){ logsForRun(runId:$id){ __typename ... on EventConnection { "
        "events { message stepKey timestamp } } } }", {"id": run_id})
    conn = data["logsForRun"]
    events = conn.get("events", []) if isinstance(conn, dict) else []
    return events[-limit:]


@mcp.tool
async def get_asset_materializations(asset_key: str, limit: int = 5) -> list[dict]:
    """拿资产最近的物料化记录（判断"上次成功是什么时候"）。"""
    data = await _gql(
        "query($k: AssetKeyInput!, $l: Int!){ assetOrError(assetKey:$k){ "
        "__typename ... on Asset { assetMaterializations(limit:$l){ timestamp runId } } } }",
        {"k": {"path": asset_key.split(".")}, "l": limit})
    asset = data["assetOrError"]
    return asset.get("assetMaterializations", []) if isinstance(asset, dict) else []


if __name__ == "__main__":
    mcp.run()
