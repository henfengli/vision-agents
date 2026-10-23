"""代码同步的记账（code_sync_state）：服务 × 范围 × 键 → 摘要 + 详情。

- 步骤：scope = 环境名（shared 步骤是 python:<解释器>），key = step:<步骤摘要>，digest = 上次成功时 when 文件的内容摘要
- 配置：scope = 环境名，key = config:<固定路径模板>，digest = 已核对过的上游 blob
- 远端：scope = 环境名，key = remote，digest = 最近一次检查到的远端提交
"""

from __future__ import annotations

import json

from .db import pool


async def get(service: str, scope: str, key: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT digest, detail, updated_at FROM code_sync_state WHERE service=%s AND scope=%s AND key=%s",
            (service, scope, key))
        row = await cur.fetchone()
    return {"digest": row[0], "detail": row[1] or {}, "updated_at": row[2].isoformat()} if row else None


async def put(service: str, scope: str, key: str, *, digest: str | None = None, detail: dict | None = None) -> None:
    """digest 为 None 时只更新 detail（比如记一次失败，不动上次成功的摘要）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO code_sync_state (service, scope, key, digest, detail) VALUES (%s, %s, %s, COALESCE(%s, ''), %s)"
            " ON CONFLICT (service, scope, key) DO UPDATE SET digest=COALESCE(%s, code_sync_state.digest),"
            " detail=EXCLUDED.detail, updated_at=now()",
            (service, scope, key, digest, json.dumps(detail or {}, ensure_ascii=False, default=str), digest))
