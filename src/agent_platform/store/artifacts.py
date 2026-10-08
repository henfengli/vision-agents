"""产物存储：资产化任务图的物化结果（血缘与重跑复用的事实源）。

一个节点一次物化 = 一行：内容 + 输入 hash。重跑复用规则：
同任务同节点输入 hash 未变 → 直接沿用最新产物（本 run 优先，跨 run 取最新），
这就是选择性再物化——只跑失败节点和下游脏节点。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .db import pool


def input_hash(node_def: dict, payload: dict) -> str:
    """节点输入指纹：定义 + 实际输入（deps 内容 / map item）规范化后 sha256。"""
    raw = json.dumps({"node": node_def, "payload": payload},
                     ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


async def put(run_id: str, task_type: str, name: str, content: Any,
              hash_: str | None, status: str = "materialized") -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO artifacts (run_id, task_type, name, content, input_hash, status)"
            " VALUES (%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (run_id, name) DO UPDATE SET"
            " content=EXCLUDED.content, input_hash=EXCLUDED.input_hash,"
            " status=EXCLUDED.status, created_at=now()",
            (run_id, task_type, name,
             json.dumps(content, ensure_ascii=False, default=str), hash_, status))


async def mark(run_id: str, task_type: str, name: str, status: str) -> None:
    """只记状态（skipped/rejected），无产物内容。"""
    await put(run_id, task_type, name, None, None, status=status)


async def get(run_id: str, name: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT name, content, input_hash, status, created_at"
            " FROM artifacts WHERE run_id=%s AND name=%s", (run_id, name))
        row = await cur.fetchone()
    return _row(row) if row else None


async def list_by_run(run_id: str) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT name, content, input_hash, status, created_at"
            " FROM artifacts WHERE run_id=%s ORDER BY created_at, name", (run_id,))
        rows = await cur.fetchall()
    return [_row(r) for r in rows]


async def find_reusable(task_type: str, name: str, hash_: str,
                        prefer_run: str | None = None) -> dict | None:
    """输入 hash 未变的最新产物：本 run 已有优先，否则跨 run 取最近一次。"""
    async with pool().connection() as conn:
        if prefer_run:
            cur = await conn.execute(
                "SELECT name, content, input_hash, status, created_at FROM artifacts"
                " WHERE run_id=%s AND name=%s AND input_hash=%s"
                " AND status IN ('materialized','reused')",
                (prefer_run, name, hash_))
            row = await cur.fetchone()
            if row:
                return _row(row)
        cur = await conn.execute(
            "SELECT name, content, input_hash, status, created_at FROM artifacts"
            " WHERE task_type=%s AND name=%s AND input_hash=%s"
            " AND status IN ('materialized','reused')"
            " ORDER BY created_at DESC LIMIT 1", (task_type, name, hash_))
        row = await cur.fetchone()
    return _row(row) if row else None


def _row(r) -> dict:
    # psycopg3 读 JSONB 已自动解析成 Python 对象，不要再 json.loads
    # （字符串产物如 "ok" 会被误当 JSON 文本解析而报错）
    return {"name": r[0], "content": r[1],
            "input_hash": r[2], "status": r[3], "created_at": r[4].isoformat()}
