"""Dagster 侧 sensor 接收端 + 规则先行分类器。

规则粗分类放这里（sensor 也可复用同一函数）：模式化报错直接出结论，
只有规则未命中的疑难报错才建 run 交给 agent——省钱、快、准。

规则与 episode 命名模板来自域包（conf/domains/dagster/），不在内核硬编码；
未配置规则时全部交给 agent（宁可多花钱，不乱判）。
"""

from __future__ import annotations

import datetime
import re

DEFAULT_SESSION_TEMPLATE = "dagster:{asset}:{error_class}:{date}"


def rule_classify(error: str, rules: list[dict]) -> dict | None:
    """规则先行：命中返回结论，未命中返回 None（交给 agent）。"""
    for rule in rules:
        if re.search(rule["pattern"], error, re.IGNORECASE):
            return {"category": rule["category"],
                    "conclusion": rule["conclusion"], "by": "rule"}
    return None


def error_class(error: str, rules: list[dict]) -> str:
    """粗粒度报错分类（仅取类别，不出结论）：session_id 维度用。
    同类故障历史连续，跨类自动开新线，避免旧历史带偏判断。"""
    hit = rule_classify(error, rules)
    return hit["category"] if hit else "unknown"


def session_id_for(asset_key: str, error: str, rules: list[dict],
                   template: str | None = None,
                   day: str | None = None) -> str:
    """episode 会话 id：模板来自域包（含 {asset}/{error_class}/{date}），
    thread 只装本次故障周期的上下文，连续性由记忆层承载。"""
    episode = day or datetime.date.today().isoformat()
    safe_asset = re.sub(r"[^A-Za-z0-9_.-]+", "_", asset_key)[:80]
    return (template or DEFAULT_SESSION_TEMPLATE).format(
        asset=safe_asset, error_class=error_class(error, rules), date=episode)


def make_router(submitter, notifier, auth=None,
                rules: list[dict] | None = None,
                session_template: str | None = None):
    from fastapi import APIRouter, Depends

    # auth：与 /v1 API 同一 bearer 依赖；webhook 也是服务间调用，不能裸奔
    router = APIRouter(dependencies=[Depends(auth)] if auth else [])
    rules = rules or []

    @router.post("/v1/hooks/dagster")
    async def dagster_hook(payload: dict):
        """Dagster run_failure_sensor 回调：{run_id, asset_key, error}。"""
        error = str(payload.get("error", ""))
        hit = rule_classify(error, rules)
        if hit and notifier is not None:
            await notifier.send_alert_card(
                f"[failure-analysis] {payload.get('asset_key', '')}",
                f"**规则判定**（{hit['category']}）：{hit['conclusion']}\n\n"
                f"报错摘要：{error[:500]}",
                dedup_hash=str(payload.get("run_id", "")))
            return {"status": "rule_resolved", "category": hit["category"]}
        return await submitter.submit(
            "failure-analysis", payload, trigger_source="sensor",
            session_id=session_id_for(str(payload.get("asset_key", "")),
                                      error, rules, session_template))

    return router
