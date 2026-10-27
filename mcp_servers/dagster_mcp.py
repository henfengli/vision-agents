"""参考实现：Dagster 的 MCP server（FastMCP，stdio），查询线上部署的 Dagster，并能在线上重跑作业。

把 Dagster GraphQL 包成带 schema 的类型化工具，agent 不再靠 curl 猜接口。高频、固定的查询放这里；
临时的、不常用的，agent 可以直接在 py 内核里用 dagster 自带的 GraphQL 客户端调。
运行：DAGSTER_URL=http://... python mcp_servers/dagster_mcp.py
接入：写在服务定义的 mcp 里（见 conf/seeds/services/vision-dagster.yaml），每个环境连该环境的线上部署。

重跑（launch_job / reexecute_run）是在线上那套部署里、用线上的真实配置跑：前提是作业可以重复运行（覆盖写同一分区）。
- DAGSTER_LAUNCH_JOBS：允许重跑的作业名（正则，整名匹配）；不设 = 不允许重跑，只能查
- 同一个作业的同一个分区已经在排队 / 运行时拒绝，避免和定时、传感器撞车
- launch_job 起的运行带标签 agent/launched_by=agent-platform，在 Dagster 页面里能筛出来（reexecute_run 沿用原运行的标签）；
  agent 那边的运行时间线里也有这次工具调用和返回的 run_id
"""

import json
import os
import re

import httpx
from fastmcp import FastMCP

DAGSTER_URL = os.environ.get("DAGSTER_URL", "http://127.0.0.1:3000")
# HTTPS 证书校验：默认用系统信任；内网 CA 写 CA 文件路径（如 /etc/ipa/ca.crt），实在不行写 false
_VERIFY_RAW = os.environ.get("DAGSTER_VERIFY", "true")
VERIFY = False if _VERIFY_RAW.lower() in ("false", "0", "no") else (_VERIFY_RAW if os.path.exists(_VERIFY_RAW) else True)
_ALLOW_RAW = os.environ.get("DAGSTER_LAUNCH_JOBS", "").strip()
ALLOW = re.compile(_ALLOW_RAW) if _ALLOW_RAW else None
ACTIVE = ["QUEUED", "NOT_STARTED", "STARTING", "STARTED"]
PARTITION_TAG = "dagster/partition"

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
        "events { __typename ... on MessageEvent { message stepKey timestamp level } } } } }", {"id": run_id})
    conn = data["logsForRun"]
    events = [e for e in (conn.get("events", []) if isinstance(conn, dict) else []) if e.get("message")]
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


@mcp.tool
async def list_jobs() -> list[dict]:
    """线上部署里有哪些作业（name、所在代码位置），以及哪些允许 agent 重跑（launchable）。"""
    return [{**j, "launchable": _allowed(j["name"])} for j in await _jobs()]


@mcp.tool
async def launch_job(job_name: str, partition: str = "", run_config: str = "") -> dict:
    """在线上部署里用线上配置跑一次作业（作业须在允许重跑的清单里）。partition：分区键（分区作业必填）；
    run_config：JSON 文本，一般不填。同一作业同一分区已经在跑时拒绝。返回新运行的 run_id，之后用 get_run 看结果。"""
    if not _allowed(job_name):
        return {"error": f"作业 {job_name} 不在允许重跑的清单里（DAGSTER_LAUNCH_JOBS）"}
    job = next((j for j in await _jobs() if j["name"] == job_name), None)
    if job is None:
        return {"error": f"线上没有作业 {job_name}（用 list_jobs 看有哪些）"}
    if busy := await _active(job_name, partition):
        return {"error": f"{job_name}{'（分区 ' + partition + '）' if partition else ''} 已经有运行在进行：{busy}"}
    try:
        config = json.loads(run_config) if run_config.strip() else {}
    except ValueError as e:
        return {"error": f"run_config 不是合法的 JSON：{e}"}
    tags = _tags(partition)
    data = await _gql(
        "mutation($p: ExecutionParams!){ launchRun(executionParams:$p){ __typename "
        "... on LaunchRunSuccess { run { runId status } } ... on PythonError { message } "
        "... on RunConfigValidationInvalid { errors { message } } ... on InvalidSubsetError { message } "
        "... on UnauthorizedError { message } } }",
        {"p": {"selector": {"repositoryLocationName": job["location"], "repositoryName": job["repository"],
                            "jobName": job_name},
               "runConfigData": config, "executionMetadata": {"tags": tags}}})
    return _launched(data["launchRun"])


@mcp.tool
async def reexecute_run(run_id: str, from_failure: bool = True) -> dict:
    """在线上部署里重跑一次已有的运行（默认只从失败的步骤开始，from_failure=false 全部重跑）。
    原运行的作业须在允许重跑的清单里；同一作业同一分区已经在跑时拒绝。返回新运行的 run_id。"""
    data = await _gql("query($id: ID!){ runOrError(runId:$id){ __typename ... on Run { jobName status "
                      "tags { key value } } ... on PythonError { message } } }", {"id": run_id})
    run = data["runOrError"]
    if run.get("__typename") != "Run":
        return {"error": f"找不到运行 {run_id}：{run.get('message', run.get('__typename'))}"}
    if not _allowed(run["jobName"]):
        return {"error": f"作业 {run['jobName']} 不在允许重跑的清单里（DAGSTER_LAUNCH_JOBS）"}
    partition = next((t["value"] for t in run.get("tags") or [] if t["key"] == PARTITION_TAG), "")
    if busy := await _active(run["jobName"], partition):
        return {"error": f"{run['jobName']}{'（分区 ' + partition + '）' if partition else ''} 已经有运行在进行：{busy}"}
    data = await _gql(
        "mutation($p: ReexecutionParams!){ launchRunReexecution(reexecutionParams:$p){ __typename "
        "... on LaunchRunSuccess { run { runId status } } ... on PythonError { message } "
        "... on RunConfigValidationInvalid { errors { message } } ... on UnauthorizedError { message } } }",
        {"p": {"parentRunId": run_id, "strategy": "FROM_FAILURE" if from_failure else "ALL_STEPS"}})
    return _launched(data["launchRunReexecution"])


def _allowed(job: str) -> bool:
    return bool(ALLOW and ALLOW.fullmatch(job))


def _tags(partition: str) -> list[dict]:
    tags = [{"key": "agent/launched_by", "value": "agent-platform"}]
    if partition:
        tags.append({"key": PARTITION_TAG, "value": partition})
    return tags


def _launched(res: dict) -> dict:
    if res.get("__typename") == "LaunchRunSuccess":
        return {"run_id": res["run"]["runId"], "status": res["run"]["status"]}
    detail = res.get("message") or "；".join(e["message"] for e in res.get("errors") or []) or res.get("__typename")
    return {"error": f"发起失败：{detail}"}


async def _jobs() -> list[dict]:
    data = await _gql("{ repositoriesOrError { __typename ... on RepositoryConnection { nodes { name "
                      "location { name } jobs { name isAssetJob } } } ... on PythonError { message } } }")
    repos = data["repositoriesOrError"]
    out = []
    for r in repos.get("nodes", []) if isinstance(repos, dict) else []:
        for j in r.get("jobs") or []:
            if not j["name"].startswith("__"):
                out.append({"name": j["name"], "repository": r["name"], "location": r["location"]["name"]})
    return out


async def _active(job: str, partition: str) -> str:
    """同一作业（同一分区）还在排队 / 运行的 run id，用逗号连起来；没有返回空串。"""
    run_filter: dict = {"pipelineName": job, "statuses": ACTIVE}
    if partition:
        run_filter["tags"] = [{"key": PARTITION_TAG, "value": partition}]
    data = await _gql("query($f: RunsFilter){ runsOrError(filter:$f, limit:5){ __typename "
                      "... on Runs { results { runId } } } }", {"f": run_filter})
    runs = data["runsOrError"]
    return "、".join(r["runId"] for r in (runs.get("results", []) if isinstance(runs, dict) else []))


if __name__ == "__main__":
    mcp.run()
