"""知识库 CRUD：写入、读取、网页编辑。

时序语义：upsert 同 key 整替换并刷新有效期；被取代（valid_to 非空）
与过期（expired）的条目不出现在检索结果中，但保留可审计。

内容版本管理：upsert/update_content 覆盖前把旧 (content, code_ref) 快照进
knowledge_history（内容没变不记）；回滚 = 历史版本写回主表（写回前当前
内容同样快照，回滚可逆）。跨 key 的取代走 superseded_by 演化链，是另一套。
"""

from __future__ import annotations

import json
import logging

from ..db import pool

log = logging.getLogger(__name__)
_vec_fallback_warned = False  # pgvector 缺失告警只报一次（每写一次报一次会刷屏）

# 内容历史：每个 key 保留最近 N 版（distill 高频写入，防表膨胀）
_HISTORY_KEEP = 20

# upsert 的两种形态写成两个具名常量，不用 format 拼（全库只此两处，
# 读一遍即可懂）：差别仅是有无 embedding 一列。
_SQL_UPSERT = (
    "INSERT INTO knowledge (env, service, task, key, content, source_run,"
    " code_ref, kind, fingerprint, category) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"
    " ON CONFLICT (env, service, key) DO UPDATE SET"
    " task=EXCLUDED.task,"
    " content=EXCLUDED.content, source_run=EXCLUDED.source_run,"
    " code_ref=EXCLUDED.code_ref, kind=EXCLUDED.kind,"
    " fingerprint=EXCLUDED.fingerprint, category=EXCLUDED.category,"
    " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
    " expired=false, created_at=now()")
_SQL_UPSERT_WITH_VEC = (
    "INSERT INTO knowledge (env, service, task, key, content, source_run,"
    " code_ref, kind, fingerprint, category, embedding) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::vector)"
    " ON CONFLICT (env, service, key) DO UPDATE SET"
    " task=EXCLUDED.task,"
    " content=EXCLUDED.content, source_run=EXCLUDED.source_run,"
    " code_ref=EXCLUDED.code_ref, kind=EXCLUDED.kind,"
    " fingerprint=EXCLUDED.fingerprint, category=EXCLUDED.category,"
    " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
    " expired=false, created_at=now(), embedding=EXCLUDED.embedding")


async def _put_history(conn, env: str, service: str, key: str, content: str,
                       code_ref: dict | None, source: str) -> None:
    """把旧内容快照进 knowledge_history（版本 = key 内递增）并裁剪到最近 N 版。"""
    cur = await conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_history"
        " WHERE env=%s AND service=%s AND key=%s", (env, service, key))
    version = (await cur.fetchone())[0]
    await conn.execute(
        "INSERT INTO knowledge_history (env, service, key, version, content,"
        " code_ref, source) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (env, service, key, version, content,
         json.dumps(code_ref) if code_ref else None, source))
    await conn.execute(
        "DELETE FROM knowledge_history"
        " WHERE env=%s AND service=%s AND key=%s AND version <= %s",
        (env, service, key, version - _HISTORY_KEEP))


async def _snapshot_if_changed(conn, env: str, service: str, key: str,
                               content: str, code_ref: dict | None,
                               source: str) -> None:
    """覆盖前快照旧内容（与本次写入相同则不记，防止重跑刷屏）。"""
    cur = await conn.execute(
        "SELECT content, code_ref FROM knowledge"
        " WHERE env=%s AND service=%s AND key=%s", (env, service, key))
    old = await cur.fetchone()
    if old and (old[0] != content or (old[1] or None) != (code_ref or None)):
        await _put_history(conn, env, service, key, old[0], old[1], source)


async def upsert(env: str, service: str, key: str, content: str,
                 source_run: str | None = None, code_ref: dict | None = None,
                 task: str = "", embedder=None, kind: str = "fact",
                 fingerprint: str | None = None, category: str | None = None) -> None:
    """幂等 upsert（同 key 整替换）；embedder 存在时同步写入向量。
    覆盖前旧内容快照进 knowledge_history（与 upsert 同事务）。
    env = '' 表示对该服务所有环境成立；task = 沉淀来源任务名（召回按任务谱系排序；手工/通用留空）。
    kind：fact 事实 / lesson 报错教训（带 fingerprint、category）/ handoff 交接摘要。"""
    vec = None
    if embedder is not None and kind != "handoff":
        vecs = await embedder([f"{key} {content}"])
        if vecs:
            vec = "[%s]" % ",".join(f"{x:.6f}" for x in vecs[0])
    params = (env, service, task, key, content, source_run,
              json.dumps(code_ref) if code_ref else None, kind, fingerprint, category)
    source = source_run or "upsert"
    if vec is not None:
        try:
            # 独立连接：失败后 PG 事务中止，不能在同一连接上继续
            async with pool().connection() as conn, conn.transaction():
                await _snapshot_if_changed(conn, env, service, key, content,
                                           code_ref, source)
                await conn.execute(_SQL_UPSERT_WITH_VEC, (*params, vec))
            return
        except Exception as e:  # noqa: BLE001 —— 无 pgvector 时退化为纯文本写
            global _vec_fallback_warned
            if not _vec_fallback_warned:
                _vec_fallback_warned = True
                log.warning("向量写入失败，知识库退化为纯文本检索（仅首次告警）：%s", e)
    async with pool().connection() as conn, conn.transaction():
        await _snapshot_if_changed(conn, env, service, key, content, code_ref,
                                   source)
        await conn.execute(_SQL_UPSERT, params)


async def list_content_history(env: str, service: str, key: str) -> list[dict]:
    """内容历史（新版本在前）：回滚选择与审计用。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT version, content, code_ref, source, created_at"
            " FROM knowledge_history WHERE env=%s AND service=%s AND key=%s"
            " ORDER BY version DESC", (env, service, key))
        rows = await cur.fetchall()
    return [{"version": r[0], "content": r[1], "code_ref": r[2],
             "source": r[3], "created_at": r[4].isoformat()} for r in rows]


async def restore_content(env: str, service: str, key: str, version: int,
                          embedder=None) -> None:
    """把历史版本写回主表（当前内容先快照，回滚可逆）。版本不存在 KeyError。

    embedder 存在时回滚后重算向量（只回文本不回向量会让语义召回继续按
    旧内容匹配）；向量失败不阻断回滚——退化为纯文本可检索。
    """
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT content, code_ref FROM knowledge_history"
            " WHERE env=%s AND service=%s AND key=%s AND version=%s",
            (env, service, key, version))
        hist = await cur.fetchone()
        if hist is None:
            raise KeyError(f"无历史版本 v{version}")
        cur = await conn.execute(
            "SELECT content, code_ref FROM knowledge"
            " WHERE env=%s AND service=%s AND key=%s", (env, service, key))
        cur_row = await cur.fetchone()
        if cur_row is None:
            raise KeyError("条目本体不存在")
        if (cur_row[0], cur_row[1]) != (hist[0], hist[1]):
            await _put_history(conn, env, service, key, cur_row[0], cur_row[1],
                               f"rollback-to-v{version}")
        await conn.execute(
            "UPDATE knowledge SET content=%s, code_ref=%s, valid_from=now(),"
            " valid_to=NULL, expired=false, superseded_by=NULL,"
            " created_at=now() WHERE env=%s AND service=%s AND key=%s",
            (hist[0], json.dumps(hist[1]) if hist[1] else None,
             env, service, key))
    if embedder is not None:
        try:
            vecs = await embedder([f"{key} {hist[0]}"])
            if vecs:
                vec = "[%s]" % ",".join(f"{x:.6f}" for x in vecs[0])
                async with pool().connection() as conn:
                    await conn.execute(
                        "UPDATE knowledge SET embedding=%s::vector"
                        " WHERE env=%s AND service=%s AND key=%s",
                        (vec, env, service, key))
        except Exception as e:  # noqa: BLE001 —— 向量失败退化为纯文本检索
            log.warning("回滚后重算向量失败（不影响回滚本身）：%s", e)


async def get_entry(entry_id: int) -> dict | None:
    """整行详情（记忆页抽屉用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, env, service, key, content, expired, valid_from, valid_to,"
            " superseded_by, feedback_score, source_run, code_ref, created_at, task"
            " FROM knowledge WHERE id=%s", (entry_id,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "env": row[1], "service": row[2], "key": row[3],
            "content": row[4], "expired": row[5],
            "valid_from": row[6].isoformat() if row[6] else None,
            "valid_to": row[7].isoformat() if row[7] else None,
            "superseded_by": row[8], "feedback_score": row[9],
            "source_run": row[10], "code_ref": row[11],
            "created_at": row[12].isoformat() if row[12] else None,
            "task": row[13]}


async def restore(entry_id: int) -> None:
    """恢复生效：撤销过期/取代标记（人工判定用）。superseded_by 链断开。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE knowledge SET expired=false, valid_to=NULL,"
            " superseded_by=NULL, valid_from=now() WHERE id=%s", (entry_id,))


async def service_stats(env: str) -> dict[str, dict]:
    """按域聚合条目数：{service: {active, inactive}}——记忆页侧栏角标。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT service,"
            " COUNT(*) FILTER (WHERE NOT expired AND valid_to IS NULL),"
            " COUNT(*) FILTER (WHERE expired OR valid_to IS NOT NULL)"
            " FROM knowledge WHERE env=%s GROUP BY service ORDER BY service",
            (env,))
        rows = await cur.fetchall()
    return {d: {"active": a, "inactive": i} for d, a, i in rows}


async def evolution_chain(env: str, service: str, key: str) -> list[dict]:
    """演化链：同域内沿 superseded_by 双向走，返回时间序的整条链
    （含被取代/过期历史），当前 key 的条目带 current 标记。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, key, expired, valid_to IS NOT NULL, superseded_by,"
            " feedback_score, created_at FROM knowledge"
            " WHERE env=%s AND service=%s ORDER BY created_at", (env, service))
        rows = await cur.fetchall()
    by_key = {r[1]: r for r in rows}
    if key not in by_key:
        return []
    # 反向找链头：谁的 superseded_by 指向当前 key
    head = key
    seen = {head}
    while True:
        prev = next((r[1] for r in rows if r[4] == head and r[1] not in seen),
                    None)
        if prev is None:
            break
        head, seen = prev, seen | {prev}
    chain = []
    cur_key: str | None = head
    while cur_key is not None and cur_key in by_key:
        r = by_key[cur_key]
        chain.append({"id": r[0], "key": r[1], "expired": r[2],
                      "superseded": r[3], "feedback_score": r[5],
                      "created_at": r[6].isoformat() if r[6] else None,
                      "current": cur_key == key})
        nxt = r[4]
        cur_key = nxt if nxt and nxt not in {c["key"] for c in chain} else None
    return chain


async def update_content(entry_id: int, content: str,
                         embedder=None) -> None:
    """网页编辑：改内容并刷新有效期（视为人工纠正，重新生效）。

    embedder 存在时同步重算向量——只改文本不改向量会让语义召回/矛盾
    检测继续按旧内容匹配（静默错配）。向量写失败退化纯文本更新。
    覆盖前旧内容快照进 knowledge_history（source=web-edit）。
    """
    vec = None
    if embedder is not None:
        async with pool().connection() as conn:
            cur = await conn.execute("SELECT key FROM knowledge WHERE id=%s", (entry_id,))
            row = await cur.fetchone()
        vecs = await embedder([f"{row[0] if row else ''} {content}"])     # 与 upsert 同口径：key + 内容
        if vecs:
            vec = "[%s]" % ",".join(f"{x:.6f}" for x in vecs[0])

    async def _snapshot(conn) -> None:
        cur = await conn.execute(
            "SELECT env, service, key, content, code_ref FROM knowledge"
            " WHERE id=%s", (entry_id,))
        old = await cur.fetchone()
        if old and old[3] != content:
            await _put_history(conn, old[0], old[1], old[2], old[3], old[4],
                               "web-edit")

    async with pool().connection() as conn:
        if vec is not None:
            try:
                async with conn.transaction():
                    await _snapshot(conn)
                    await conn.execute(
                        "UPDATE knowledge SET content=%s, valid_from=now(),"
                        " valid_to=NULL, expired=false, created_at=now(),"
                        " embedding=%s::vector WHERE id=%s",
                        (content, vec, entry_id))
                return
            except Exception as e:  # noqa: BLE001 —— 无 pgvector 退化
                log.warning("编辑重算向量失败，退化为纯文本更新：%s", e)
        async with conn.transaction():
            await _snapshot(conn)
            await conn.execute(
                "UPDATE knowledge SET content=%s, valid_from=now(),"
                " valid_to=NULL, expired=false, created_at=now() WHERE id=%s",
                (content, entry_id))


async def list_by_service(env: str, service: str) -> list[dict]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, key, content, expired FROM knowledge"
            " WHERE env=%s AND service=%s ORDER BY key", (env, service))
        rows = await cur.fetchall()
    return [{"id": i, "key": k, "content": c, "expired": e} for i, k, c, e in rows]


async def list_all(env: str, service: str | None = None,
                   include_inactive: bool = False, with_code_ref: bool = False) -> list[dict]:
    """全量列出某环境适用的条目（env 本身 + 所有环境通用的）。园丁巡检用 with_code_ref 只取带 code_ref 的，不限条数。"""
    where = "WHERE env IN ('', %s)"
    params: list = [env]
    if service:
        where += " AND service=%s"
        params.append(service)
    if not include_inactive:
        where += " AND expired=false AND valid_to IS NULL"
    if with_code_ref:
        where += " AND code_ref IS NOT NULL"
    limit = "" if with_code_ref else " LIMIT 500"
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, key, content, expired, valid_to IS NOT NULL,"
            " feedback_score, code_ref, created_at, task FROM knowledge " + where +
            " ORDER BY service, key" + limit, tuple(params))
        rows = await cur.fetchall()
    return [{"id": r[0], "service": r[1], "key": r[2], "content": r[3],
             "expired": r[4], "superseded": r[5], "feedback_score": r[6],
             "code_ref": r[7],  # JSONB 已被 psycopg3 解析成 dict/None
             "created_at": r[8].isoformat(), "task": r[9]} for r in rows]


async def by_source_run(run_id: str) -> list[dict]:
    """反查：某次 run 沉淀了哪些知识条目（run 详情「本次沉淀」用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, key, kind FROM knowledge WHERE source_run=%s"
            " ORDER BY id", (run_id,))
        rows = await cur.fetchall()
    return [{"id": r[0], "service": r[1], "key": r[2], "kind": r[3]} for r in rows]


async def supersede_entry(entry_id: int, superseded_by: str) -> None:
    """把一条记忆标为被取代（升格进档案后用：档案里已经有了，召回不再重复注入）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE knowledge SET valid_to=now(), superseded_by=%s WHERE id=%s AND valid_to IS NULL",
            (superseded_by, entry_id))
