"""报错规则库：顶层服务模块。

规则先行分类是平台级能力（dagster webhook、后续的 gitlab/告警接入都走它），
不再埋在域包 yaml 里：存 definitions（kind=rules，name=域名），与角色/任务/
策略同一套「写即新版本、历史全留、可回滚、热生效」；管理页可视化编辑；
域包 rules.yaml 退化为首次启动的种子（库里已有则不覆盖）。

规则结构：[{pattern, category, conclusion, enabled?}]，按序匹配，首个命中
生效。未配置规则的域全部交给 agent（宁可多花钱，不乱判）。
"""

from __future__ import annotations

import logging
import re

log = logging.getLogger(__name__)


def validate(rules) -> list[dict]:
    """定义校验（admin 保存入口用）；返回规范化后的列表。不合法抛 ValueError。"""
    if not isinstance(rules, list):
        raise ValueError("规则库必须是列表")
    out = []
    for i, r in enumerate(rules):
        if not isinstance(r, dict):
            raise ValueError(f"第 {i + 1} 条不是对象")
        pattern, category = str(r.get("pattern", "")), str(r.get("category", ""))
        conclusion = str(r.get("conclusion", ""))
        if not pattern or not category or not conclusion:
            raise ValueError(f"第 {i + 1} 条缺 pattern/category/conclusion")
        try:
            re.compile(pattern)
        except re.error as e:
            raise ValueError(f"第 {i + 1} 条正则不合法：{e}") from None
        out.append({"pattern": pattern, "category": category,
                    "conclusion": conclusion,
                    "enabled": bool(r.get("enabled", True))})
    return out


def classify(error: str, rules: list[dict]) -> dict | None:
    """规则先行：命中返回 {category, conclusion, by:rule}，未命中 None。"""
    for rule in rules or []:
        if rule.get("enabled", True) is False:
            continue
        try:
            if re.search(rule["pattern"], error, re.IGNORECASE):
                return {"category": rule["category"],
                        "conclusion": rule["conclusion"], "by": "rule"}
        except re.error:  # 存量脏数据不挡主链路（保存入口已校验）
            log.warning("规则正则不合法，跳过：%r", rule.get("pattern"))
    return None


def error_class(error: str, rules: list[dict]) -> str:
    """粗粒度报错分类（只取类别）：episode session 命名维度用。"""
    hit = classify(error, rules)
    return hit["category"] if hit else "unknown"


class RuleProvider:
    """运行期规则源：优先 definitions（热、版本化），回退域包种子。

    每次调用都过 DefinitionStore 的短 TTL 缓存——管理页保存后秒级生效，
    webhook 热路径无额外 DB 压力（缓存命中不走库）。
    """

    def __init__(self, defs, env: str, fallback: dict[str, list[dict]]):
        self._defs = defs
        self._env = env
        self._fallback = fallback or {}

    async def rules_for(self, domain: str) -> list[dict]:
        if self._defs is not None:
            try:
                stored = await self._defs.get_active("rules", self._env, domain)
                if stored is not None:
                    return stored.get("rules") or []
            except Exception as e:  # noqa: BLE001 —— 读失败退种子，不挡 webhook
                log.warning("规则库读取失败，回退域包种子：%s", e)
        return self._fallback.get(domain) or []


async def seed_from_domain_packs(defs, env: str, domains: dict) -> int:
    """首次启动把域包 rules.yaml 灌进 definitions；已有定义的域不覆盖。"""
    seeded = 0
    for name, pack in (domains or {}).items():
        rules = getattr(pack, "rules", None) or []
        if not rules:
            continue
        try:
            rules = validate(rules)
        except ValueError as e:
            log.warning("域包 %s 规则不合法，跳过播种：%s", name, e)
            continue
        if await defs.get_active("rules", env, name) is not None:
            from ..store.definitions import seed_drifted
            if await seed_drifted(defs, "rules", env, name, {"rules": rules}):
                log.warning("域包 %s 的 rules.yaml 自播种后有改动，但规则库以"
                            "定义库为准，文件改动未生效——请到 /services/%s 编辑",
                            name, name)
            continue
        await defs.put("rules", env, name, {"rules": rules},
                       updated_by="seed")
        seeded += 1
    return seeded
