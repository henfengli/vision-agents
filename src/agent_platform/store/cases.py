"""案例库：报错分析结论，按报错指纹召回同类历史。"""

from __future__ import annotations

import hashlib
import re

from .db import pool

# 归一化：抹掉报错里的易变部分（数字、十六进制、引号内容、路径），让同类报错指纹一致
_NORMALIZE_RULES = [
    (re.compile(r"0x[0-9a-fA-F]+"), "0x?"),
    (re.compile(r"\b\d+\b"), "?"),
    (re.compile(r"'[^']*'"), "'?'"),
    (re.compile(r'"[^"]*"'), '"?"'),
    (re.compile(r"[\w./-]+\.(py|sql|yaml|json):\d+"), "<file:line>"),
]


def fingerprint(error_text: str) -> str:
    """报错模式指纹：归一化后取末两行（堆栈头通常是噪音）做哈希。"""
    text = "\n".join(error_text.strip().splitlines()[-2:]) or error_text
    for pattern, repl in _NORMALIZE_RULES:
        text = pattern.sub(repl, text)
    return hashlib.sha1(text.encode()).hexdigest()[:16]


async def add(env: str, service: str | None, error_text: str, category: str,
              conclusion: str, source_run: str) -> None:
    """同 (环境, 服务, 指纹) 已有案例则覆盖结论并刷新时间，不重复建行。"""
    fp = fingerprint(error_text)
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO cases (env, service, fingerprint, category, conclusion, source_run)"
            " VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (env, service, fingerprint) DO UPDATE SET"
            " category=EXCLUDED.category, conclusion=EXCLUDED.conclusion, source_run=EXCLUDED.source_run,"
            " valid_to=NULL, superseded_by=NULL, created_at=now()",
            (env, service or "", fp, category, conclusion, source_run))


async def search_by_error(env: str, service: str | None, error_text: str) -> dict | None:
    fp = fingerprint(error_text)
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, category, conclusion, thumbs_up, thumbs_down, created_at"
            " FROM cases WHERE env=%s AND service=%s AND fingerprint=%s AND valid_to IS NULL",
            (env, service or "", fp))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "category": row[1], "conclusion": row[2],
            "thumbs_up": row[3], "thumbs_down": row[4], "date": row[5].isoformat()}


async def supersede_by_runs(env: str, run_ids: list[str], superseded_by: str) -> int:
    """事实时序化：把若干 run 沉淀的案例标记为被取代（软过期）。"""
    if not run_ids:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE cases SET valid_to=now(), superseded_by=%s"
            " WHERE env=%s AND source_run = ANY(%s) AND valid_to IS NULL",
            (superseded_by, env, run_ids))
        return cur.rowcount


async def list_entries(env: str | None = None, service: str | None = None, limit: int = 300) -> list[dict]:
    conds, params = [], []
    if env:
        conds.append("env=%s"); params.append(env)
    if service:
        conds.append("service=%s"); params.append(service)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, env, fingerprint, category, conclusion, source_run, thumbs_up, thumbs_down,"
            " valid_to IS NOT NULL, created_at FROM cases" + where + " ORDER BY created_at DESC LIMIT %s",
            (*params, limit))
        rows = await cur.fetchall()
    return [{"id": r[0], "service": r[1] or None, "env": r[2], "fingerprint": r[3], "category": r[4],
             "conclusion": r[5], "source_run": r[6], "thumbs_up": r[7], "thumbs_down": r[8],
             "status": "superseded" if r[9] else "active", "updated_at": r[10].isoformat()} for r in rows]


async def expire(case_id: int) -> bool:
    """人工作废一条案例（不再被召回）。"""
    async with pool().connection() as conn:
        cur = await conn.execute("UPDATE cases SET valid_to=COALESCE(valid_to, now()) WHERE id=%s", (case_id,))
        return bool(cur.rowcount)
