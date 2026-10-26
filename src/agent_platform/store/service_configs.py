"""给 agent 用的只读版配置：服务×环境×路径（定义里 configs 的一项），每次保存一个新版本，历史全留。

存在库里而不是文件里：控制台由哪个节点回答都能读写；执行运行的节点在起项目内核前把当前版本写到本机
（数据目录 agent-conf/，700），再 bind 到项目读配置的路径上。保存时带上打开时读到的 sha，期间别人改过就 409。
"""

from __future__ import annotations

import hashlib

from ..domain import Rejected
from .db import pool

MAX_BYTES = 1024 * 1024


def digest(content: str) -> str:
    return hashlib.sha1(content.encode("utf-8")).hexdigest()[:16]


def _row(r) -> dict:
    return {"version": r[0], "content": r[1], "updated_by": r[2], "updated_at": r[3].isoformat() if r[3] else None,
            "sha": digest(r[1])}


async def current(service: str, env: str, path: str) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT version, content, updated_by, created_at FROM service_configs"
            " WHERE service=%s AND env=%s AND path=%s ORDER BY version DESC LIMIT 1", (service, env, path))
        r = await cur.fetchone()
    return _row(r) if r else None


async def versions(service: str, env: str) -> dict[str, dict]:
    """该服务×环境每个路径的当前版本：{path: {version, updated_by, updated_at, sha}}（不带内容）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT DISTINCT ON (path) path, version, content, updated_by, created_at FROM service_configs"
            " WHERE service=%s AND env=%s ORDER BY path, version DESC", (service, env))
        rows = await cur.fetchall()
    return {r[0]: {k: v for k, v in _row(r[1:]).items() if k != "content"} for r in rows}


async def save(service: str, env: str, path: str, content: str, *, by: str, base_sha: str | None) -> dict:
    """base_sha：打开编辑时读到的 sha（还没有版本时传空串）；None 表示不检查。"""
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise Rejected("invalid_request", "配置超过 1MB", 422)
    async with pool().connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"cfg:{service}:{env}:{path}",))
        cur = await conn.execute(
            "SELECT version, content FROM service_configs WHERE service=%s AND env=%s AND path=%s"
            " ORDER BY version DESC LIMIT 1", (service, env, path))
        last = await cur.fetchone()
        if base_sha is not None and (digest(last[1]) if last else "") != base_sha:
            raise Rejected("conflict", f"{path} 在你打开之后被改过，刷新后再改", 409)
        if last and last[1] == content:
            return {"version": last[0], "sha": digest(content), "changed": False}
        version = (last[0] if last else 0) + 1
        await conn.execute(
            "INSERT INTO service_configs (service, env, path, version, content, updated_by) VALUES (%s,%s,%s,%s,%s,%s)",
            (service, env, path, version, content, by))
    return {"version": version, "sha": digest(content), "changed": True}


async def history(service: str, env: str, path: str) -> list[dict]:
    """[{version, updated_by, updated_at, size}]，新的在前。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT version, updated_by, created_at, octet_length(content) FROM service_configs"
            " WHERE service=%s AND env=%s AND path=%s ORDER BY version DESC", (service, env, path))
        return [{"version": r[0], "updated_by": r[1], "updated_at": r[2].isoformat() if r[2] else None, "size": r[3]}
                for r in await cur.fetchall()]


async def at_version(service: str, env: str, path: str, version: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT version, content, updated_by, created_at FROM service_configs"
            " WHERE service=%s AND env=%s AND path=%s AND version=%s", (service, env, path, version))
        r = await cur.fetchone()
    return _row(r) if r else None
