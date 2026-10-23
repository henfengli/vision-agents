"""API 密钥：每个调用方（项目 / 脚本 / 人）一把。库里只存 sha256，明文只在创建时返回一次。

name 就是调用身份，写进 runs.caller，运行列表里一眼看出是谁调的。密钥只标识身份，不分权限。
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from .db import pool

PREFIX = "ap_"
_COLS = "id, name, prefix, note, created_by, created_at, expires_at, last_used_at, revoked_at"


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def _row(r) -> dict:
    return {"id": r[0], "name": r[1], "prefix": r[2], "note": r[3], "created_by": r[4], "created_at": r[5].isoformat(),
            "expires_at": _iso(r[6]), "last_used_at": _iso(r[7]), "revoked_at": _iso(r[8])}


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create(*, name: str, note: str, by: str, expires_at: str | None) -> tuple[dict, str]:
    """返回 (密钥信息, 明文)。"""
    token = PREFIX + secrets.token_urlsafe(32)
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"INSERT INTO api_keys (name, prefix, hash, note, created_by, expires_at)"
            f" VALUES (%s,%s,%s,%s,%s,%s) RETURNING {_COLS}",
            (name, token[:len(PREFIX) + 6], digest(token), note, by, expires_at))
        return _row(await cur.fetchone()), token


async def listing() -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(f"SELECT {_COLS} FROM api_keys ORDER BY revoked_at IS NOT NULL, created_at DESC")
        return [_row(r) for r in await cur.fetchall()]


async def update(key_id: int, *, note: str, expires_at: str | None) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"UPDATE api_keys SET note=%s, expires_at=%s WHERE id=%s RETURNING {_COLS}", (note, expires_at, key_id))
        row = await cur.fetchone()
    return _row(row) if row else None


async def revoke(key_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"UPDATE api_keys SET revoked_at=COALESCE(revoked_at, now()) WHERE id=%s RETURNING {_COLS}", (key_id,))
        row = await cur.fetchone()
    return _row(row) if row else None


async def authenticate(token_digest: str) -> dict | None:
    """按 sha256 找有效（未吊销、未过期）的密钥；顺手记最后使用时间。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            f"UPDATE api_keys SET last_used_at=now() WHERE hash=%s AND revoked_at IS NULL"
            f" AND (expires_at IS NULL OR expires_at > now()) RETURNING {_COLS}", (token_digest,))
        row = await cur.fetchone()
    return _row(row) if row else None
