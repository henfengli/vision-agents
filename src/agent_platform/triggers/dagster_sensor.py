"""Dagster 侧 sensor 接收端 + 规则先行分类器。

规则粗分类放这里（sensor 也可复用同一函数）：模式化报错直接出结论，
只有规则未命中的疑难报错才建 run 交给 agent——省钱、快、准。

规则库是平台顶层服务（agent_platform.rules）：存 definitions（版本化、
管理页可编辑、热生效），域包 rules.yaml 只是首次启动的种子。episode
命名模板仍来自域包（conf/domains/dagster/session.yaml）。
"""

from __future__ import annotations

import datetime
import logging
import re

from .. import rules as rules_svc

DEFAULT_SESSION_TEMPLATE = "dagster:{asset}:{error_class}:{date}"

# 兼容旧导入路径（测试与外部引用）：实现已迁到 rules 服务模块
rule_classify = rules_svc.classify
error_class = rules_svc.error_class


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
                classifier=None,
                session_template: str | None = None,
                domain_enabled=None):
    """classifier：async (domain, error) -> rules 列表（RuleProvider.rules_for
    的部分应用）；缺省 = 无规则全交 agent。
    domain_enabled：async (domain) -> bool，服务停用即拒收（429）。"""
    from fastapi import APIRouter, Depends

    # auth：与 /v1 API 同一 bearer 依赖；webhook 也是服务间调用，不能裸奔
    router = APIRouter(dependencies=[Depends(auth)] if auth else [])
    log = logging.getLogger(__name__)

    async def _rules(error: str) -> list[dict]:
        if classifier is None:
            return []
        try:
            return await classifier("dagster", error)
        except Exception as e:  # noqa: BLE001 —— 规则源故障退化为无规则
            log.warning("规则库读取失败，本次报错交 agent：%s", e)
            return []

    @router.post("/v1/hooks/dagster")
    async def dagster_hook(payload: dict):
        """Dagster run_failure_sensor 回调：{run_id, asset_key, error, env?}。

        env 是目标业务环境：多套 Dagster 环境共用一个 agent 实例时，
        sensor 侧按自己的环境标识上送（缺省 = 实例默认环境）。
        """
        # 服务停用即拒收：sensor 应降级或暂停，别把报错打进停用的域
        if domain_enabled is not None and not await domain_enabled("dagster"):
            from fastapi import HTTPException
            raise HTTPException(429, "服务 dagster 已停用")
        error = str(payload.get("error", ""))
        asset_key = str(payload.get("asset_key", ""))
        target_env = payload.get("env") or None
        # 本 webhook 即 dagster 域入口：补 domain 让 run 归属域，
        # 召回（域知识/案例）与记忆分区全部按域生效
        payload.setdefault("domain", "dagster")

        rules = await _rules(error)
        hit = rules_svc.classify(error, rules)
        if hit and notifier is not None:
            try:
                await notifier.send_alert_card(
                    f"[failure-analysis] {asset_key}",
                    f"**规则判定**（{hit['category']}）：{hit['conclusion']}\n\n"
                    f"报错摘要：{error[:500]}",
                    dedup_hash=str(payload.get("run_id", "")))
            except Exception:
                # 告警通道（relay 不可达等）挂了不能让 webhook 500：
                # 规则结论照样返回调用方，只标注通知未送达
                log.exception("规则判定告警卡发送失败（asset=%s）", asset_key)
                return {"status": "rule_resolved",
                        "category": hit["category"], "notify": "failed"}
            return {"status": "rule_resolved", "category": hit["category"]}
        return await submitter.submit(
            "failure-analysis", payload, trigger_source="sensor",
            session_id=session_id_for(asset_key, error, rules,
                                      session_template),
            target_env=target_env)

    return router
