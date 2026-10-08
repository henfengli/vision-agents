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


async def add(env: str, domain: str | None, error_text: str, category: str,
              conclusion: str, source_run: str) -> None:
    """同指纹已有案例则覆盖结论并刷新时间，不重复建行。"""
    fp = fingerprint(error_text)
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM cases WHERE env=%s AND fingerprint=%s", (env, fp))
        row = await cur.fetchone()
        if row:
            await conn.execute(
                "UPDATE cases SET conclusion=%s, source_run=%s, created_at=now()"
                " WHERE id=%s", (conclusion, source_run, row[0]))
        else:
            await conn.execute(
                "INSERT INTO cases (env, domain, fingerprint, category, conclusion, source_run)"
                " VALUES (%s,%s,%s,%s,%s,%s)",
                (env, domain, fp, category, conclusion, source_run))


async def search_by_error(env: str, error_text: str) -> dict | None:
    fp = fingerprint(error_text)
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT category, conclusion, thumbs_up, thumbs_down, created_at"
            " FROM cases WHERE env=%s AND fingerprint=%s AND valid_to IS NULL",
            (env, fp))
        row = await cur.fetchone()
    if not row:
        return None
    return {"category": row[0], "conclusion": row[1],
            "thumbs_up": row[2], "thumbs_down": row[3],
            "date": row[4].isoformat()}


async def supersede_by_runs(env: str, run_ids: list[str],
                            superseded_by: str) -> int:
    """事实时序化：把若干 run 沉淀的案例标记为被取代（软过期）。"""
    if not run_ids:
        return 0
    async with pool().connection() as conn:
        cur = await conn.execute(
            "UPDATE cases SET valid_to=now(), superseded_by=%s"
            " WHERE env=%s AND source_run = ANY(%s) AND valid_to IS NULL",
            (superseded_by, env, run_ids))
        return cur.rowcount
