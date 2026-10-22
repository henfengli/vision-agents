"""教训（kind=lesson）：报错 → 结论。和事实同表、同一套检索和审阅，另带报错指纹供同类报错精确命中。

key = lesson:<指纹>，同一服务同一指纹只有一条（新结论覆盖旧的，旧内容进历史）。
"""

from __future__ import annotations

import hashlib
import re

from ..db import pool
from .crud import upsert

# 归一化：抹掉报错里的易变部分，让同类报错指纹一致。file:line 要在纯数字之前处理，不然行号先被抹掉、规则失效
_NORMALIZE_RULES = [
    (re.compile(r"[\w./\\-]+\.(py|sql|yaml|yml|json|js|ts):\d+"), "<file:line>"),
    (re.compile(r'File "[^"]+", line \d+'), 'File "<file>", line ?'),
    (re.compile(r"0x[0-9a-fA-F]+"), "0x?"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<uuid>"),
    (re.compile(r"\b\d+\b"), "?"),
    (re.compile(r"'[^']*'"), "'?'"),
    (re.compile(r'"[^"]*"'), '"?"'),
]


def fingerprint(error_text: str) -> str:
    """报错模式指纹：归一化后取末两行（堆栈头通常是噪音）做哈希。"""
    text = "\n".join(error_text.strip().splitlines()[-2:]) or error_text
    for pattern, repl in _NORMALIZE_RULES:
        text = pattern.sub(repl, text)
    return hashlib.sha1(text.encode()).hexdigest()[:16]


async def add(env: str, service: str, error_text: str, category: str, conclusion: str,
              source_run: str | None, task: str = "", embedder=None) -> None:
    fp = fingerprint(error_text)
    first_line = next((ln.strip() for ln in reversed(error_text.strip().splitlines()) if ln.strip()), "")[:200]
    await upsert(env, service, f"lesson:{fp}", f"{conclusion}\n（报错：{first_line}）" if first_line else conclusion,
                 source_run=source_run, task=task, embedder=embedder, kind="lesson", fingerprint=fp,
                 category=category or "code")


async def search_by_error(env: str, service: str, error_text: str) -> dict | None:
    """同类报错的教训：本环境的优先，其次所有环境通用的。"""
    fp = fingerprint(error_text)
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, key, category, content, created_at, feedback_score FROM knowledge"
            " WHERE kind='lesson' AND service=%s AND env IN ('', %s) AND fingerprint=%s"
            " AND NOT expired AND valid_to IS NULL ORDER BY (env = %s) DESC, created_at DESC LIMIT 1",
            (service, env, fp, env))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "key": row[1], "category": row[2], "conclusion": row[3],
            "date": row[4].isoformat(), "feedback_score": row[5]}
