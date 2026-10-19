"""资产目录（catalog）：业务对象的一等档案。

定位：知识条目记"通用事实"（靠检索召回），目录记"这个资产是谁/在哪/怎么
修"（按 asset_key 确定性挂载）。run 输入带 asset_key 时档案整段注入
prompt 顶部——归因不靠向量召回的运气；webhook 首次上报未知资产时自动
登记占位条目，人再补全负责人/依赖/runbook。

写入全部 upsert 幂等（env+domain+asset_key 唯一）；统计查询供目录页聚合。
"""

from __future__ import annotations

import json

from .db import pool

_FIELDS = ("id, env, domain, asset_key, name, owner, tier, upstream,"
           " downstream, code_refs, tags, runbook, created_by, created_at,"
           " updated_by, updated_at")


def _row(r) -> dict:
    d = dict(zip(("id", "env", "domain", "asset_key", "name", "owner",
                  "tier", "upstream", "downstream", "code_refs", "tags",
                  "runbook", "created_by", "created_at", "updated_by",
                  "updated_at"), r))
    for k in ("upstream", "downstream", "code_refs", "tags"):
        v = d[k]
        d[k] = v if isinstance(v, list) else json.loads(v or "[]")
    d["created_at"] = d["created_at"].isoformat() if d["created_at"] else None
    d["updated_at"] = d["updated_at"].isoformat() if d["updated_at"] else None
    return d


async def upsert(env: str, domain: str, asset_key: str, *,
                 name: str = "", owner: str = "", tier: str = "",
                 upstream: list | None = None, downstream: list | None = None,
                 code_refs: list | None = None, tags: list | None = None,
                 runbook: str = "", by: str = "") -> dict:
    """整条目 upsert：存在即更新全部字段（空串/None 字段保持原值不覆盖）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "INSERT INTO catalog_entry (env, domain, asset_key, name, owner,"
            " tier, upstream, downstream, code_refs, tags, runbook,"
            " created_by, updated_by)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (env, domain, asset_key) DO UPDATE SET"
            " name=CASE WHEN EXCLUDED.name='' THEN catalog_entry.name ELSE EXCLUDED.name END,"
            " owner=CASE WHEN EXCLUDED.owner='' THEN catalog_entry.owner ELSE EXCLUDED.owner END,"
            " tier=CASE WHEN EXCLUDED.tier='' THEN catalog_entry.tier ELSE EXCLUDED.tier END,"
            " upstream=CASE WHEN EXCLUDED.upstream='[]' THEN catalog_entry.upstream ELSE EXCLUDED.upstream END,"
            " downstream=CASE WHEN EXCLUDED.downstream='[]' THEN catalog_entry.downstream ELSE EXCLUDED.downstream END,"
            " code_refs=CASE WHEN EXCLUDED.code_refs='[]' THEN catalog_entry.code_refs ELSE EXCLUDED.code_refs END,"
            " tags=CASE WHEN EXCLUDED.tags='[]' THEN catalog_entry.tags ELSE EXCLUDED.tags END,"
            " runbook=CASE WHEN EXCLUDED.runbook='' THEN catalog_entry.runbook ELSE EXCLUDED.runbook END,"
            " updated_by=EXCLUDED.updated_by, updated_at=now()"
            f" RETURNING {_FIELDS}",
            (env, domain, asset_key, name, owner, tier,
             json.dumps(upstream or []), json.dumps(downstream or []),
             json.dumps(code_refs or []), json.dumps(tags or []),
             runbook, by, by))
        row = await cur.fetchone()
    return _row(row)


async def register_stub(env: str, domain: str, asset_key: str,
                        by: str = "auto") -> dict:
    """webhook 自动登记：仅在不存在时建占位条目（名字先用 asset_key）。

    已存在则原样返回——自动通道永不覆盖人填的内容。"""
    existing = await get(env, domain, asset_key)
    if existing is not None:
        return existing
    return await upsert(env, domain, asset_key, name=asset_key, by=by)


async def get(env: str, domain: str, asset_key: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_FIELDS} FROM catalog_entry"
            " WHERE env=%s AND domain=%s AND asset_key=%s",
            (env, domain, asset_key))
        row = await cur.fetchone()
    return _row(row) if row else None


async def get_by_id(entry_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_FIELDS} FROM catalog_entry WHERE id=%s", (entry_id,))
        row = await cur.fetchone()
    return _row(row) if row else None


async def list_entries(env: str, domain: str | None = None,
                       q: str | None = None) -> list[dict]:
    conds, params = ["env=%s"], [env]
    if domain:
        conds.append("domain=%s")
        params.append(domain)
    if q:
        conds.append("(asset_key ILIKE %s OR name ILIKE %s OR owner ILIKE %s)")
        params += [f"%{q}%"] * 3
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"SELECT {_FIELDS} FROM catalog_entry"
            f" WHERE {' AND '.join(conds)} ORDER BY domain, asset_key",
            params)
        rows = await cur.fetchall()
    return [_row(r) for r in rows]


async def delete(entry_id: int) -> None:
    async with pool().connection() as conn:
        await conn.execute("DELETE FROM catalog_entry WHERE id=%s",
                           (entry_id,))


def render_block(entry: dict) -> str:
    """档案 → 注入 prompt 的文本块（逐字保留，置顶，优先级最高）。"""
    lines = [f"资产：{entry['asset_key']}"]
    if entry["name"] and entry["name"] != entry["asset_key"]:
        lines.append(f"名称：{entry['name']}")
    if entry["owner"]:
        lines.append(f"负责人：{entry['owner']}")
    if entry["tier"]:
        lines.append(f"等级：{entry['tier']}")
    if entry["upstream"]:
        lines.append("上游依赖：" + "、".join(entry["upstream"]))
    if entry["downstream"]:
        lines.append("下游影响：" + "、".join(entry["downstream"]))
    if entry["code_refs"]:
        lines.append("代码位置：" + "、".join(entry["code_refs"]))
    if entry["runbook"]:
        lines.append("运维档案（逐字）：\n" + entry["runbook"])
    return "[资产档案——本资产的一手事实，优先级最高]\n" + "\n".join(lines)
