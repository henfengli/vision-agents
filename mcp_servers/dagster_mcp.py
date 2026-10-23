"""参考实现：Dagster 的 MCP server（FastMCP，stdio），只读查询线上部署的 Dagster。

把 Dagster GraphQL 包成带 schema 的类型化工具，agent 不再靠 curl 猜接口。高频、固定的查询放这里；
临时的、不常用的，agent 可以直接在 py 内核里用 dagster 自带的 GraphQL 客户端调。
运行：DAGSTER_URL=http://... python mcp_servers/dagster_mcp.py
接入：写在服务定义的 mcp 里（见 conf/seeds/services/vision-dagster.yaml），每个环境连该环境的线上部署。
"""

import os

import httpx
from fastmcp import FastMCP

DAGSTER_URL = os.environ.get("DAGSTER_URL", "http://127.0.0.1:3000")
# HTTPS 证书校验：默认用系统信任；内网 CA 写 CA 文件路径（如 /etc/ipa/ca.crt），实在不行写 false
_VERIFY_RAW = os.environ.get("DAGSTER_VERIFY", "true")
VERIFY = False if _VERIFY_RAW.lower() in ("false", "0", "no") else (_VERIFY_RAW if os.path.exists(_VERIFY_RAW) else True)

mcp = FastMCP("dagster")


async def _gql(query: str, variables: dict | None = None) -> dict:
    async with httpx.AsyncClient(base_url=DAGSTER_URL, timeout=15, verify=VERIFY) as c:
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


@mcp.tool
async def recent_runs(limit: int = 20, status: str = "") -> list[dict]:
    """最近的运行（新的在前）。status 可选 FAILURE / SUCCESS / STARTED / QUEUED / CANCELED，空 = 全部。"""
    run_filter = {"statuses": [status.upper()]} if status else {}
    data = await _gql(
        "query($f: RunsFilter, $l: Int){ runsOrError(filter:$f, limit:$l){ __typename "
        "... on Runs { results { runId status jobName startTime endTime } } ... on PythonError { message } } }",
        {"f": run_filter, "l": max(1, min(limit, 100))})
    runs = data["runsOrError"]
    return runs.get("results", []) if isinstance(runs, dict) else []


@mcp.tool
async def asset_info(asset_key: str) -> dict:
    """资产的定义：描述、分组、上游依赖、所属 job（asset_key 用 . 分隔层级，如 dwd.trade_order）。"""
    data = await _gql(
        "query($k: AssetKeyInput!){ assetOrError(assetKey:$k){ __typename ... on Asset { "
        "definition { description groupName jobNames dependencyKeys { path } } } } }",
        {"k": {"path": asset_key.split(".")}})
    asset = data["assetOrError"]
    return (asset.get("definition") or {}) if isinstance(asset, dict) else {}


if __name__ == "__main__":
    mcp.run()
