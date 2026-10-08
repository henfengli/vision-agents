"""Dagster 侧 sensor 接收端 + 规则先行分类器。

规则粗分类放这里（sensor 也可复用同一函数）：模式化报错直接出结论，
只有规则未命中的疑难报错才建 run 交给 agent——省钱、快、准。
"""

from __future__ import annotations

import datetime
import re

# (正则, 分类, 结论模板)；命中即直接回复，不消耗模型
_RULES: list[tuple[str, str, str]] = [
    (r"connection.*(refused|timeout|reset)", "infra", "数据库/服务连接失败，检查目标服务存活与网络"),
    (r"duplicate key|唯一约束|unique constraint", "data", "数据主键冲突：上游重复投递或任务重复跑"),
    (r"out of memory|oom|memoryerror", "infra", "内存不足：检查资源配额或拆分任务粒度"),
    (r"upstream.*fail|上游.*失败", "upstream", "上游 asset 失败级联，根因在上游"),
]


def rule_classify(error: str) -> dict | None:
    """规则先行：命中返回结论，未命中返回 None（交给 agent）。"""
    for pattern, category, conclusion in _RULES:
        if re.search(pattern, error, re.IGNORECASE):
            return {"category": category, "conclusion": conclusion, "by": "rule"}
    return None


def error_class(error: str) -> str:
    """粗粒度报错分类（仅取类别，不出结论）：session_id 维度用。
    同类故障历史连续，跨类自动开新线，避免旧历史带偏判断。"""
    hit = rule_classify(error)
    return hit["category"] if hit else "unknown"


def session_id_for(asset_key: str, error: str, day: str | None = None) -> str:
    """dagster:{asset}:{error_class}:{episode}——episode 按天滚动，
    thread 只装本次故障周期的上下文，连续性由记忆层承载。"""
    episode = day or datetime.date.today().isoformat()
    safe_asset = re.sub(r"[^A-Za-z0-9_.-]+", "_", asset_key)[:80]
    return f"dagster:{safe_asset}:{error_class(error)}:{episode}"


def make_router(submitter, notifier, auth=None):
    from fastapi import APIRouter, Depends

    # auth：与 /v1 API 同一 bearer 依赖；webhook 也是服务间调用，不能裸奔
    router = APIRouter(dependencies=[Depends(auth)] if auth else [])

    @router.post("/v1/hooks/dagster")
    async def dagster_hook(payload: dict):
        """Dagster run_failure_sensor 回调：{run_id, asset_key, error}。"""
        error = str(payload.get("error", ""))
        hit = rule_classify(error)
        if hit and notifier is not None:
            await notifier.send_alert_card(
                f"[failure-analysis] {payload.get('asset_key', '')}",
                f"**规则判定**（{hit['category']}）：{hit['conclusion']}\n\n"
                f"报错摘要：{error[:500]}",
                dedup_hash=str(payload.get("run_id", "")))
            return {"status": "rule_resolved", "category": hit["category"]}
        return await submitter.submit(
            "failure-analysis", payload, trigger_source="sensor",
            session_id=session_id_for(str(payload.get("asset_key", "")), error))

    return router
