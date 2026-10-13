"""任务资产：run 产出的可复用产出——方法（procedure）/脚本/查询/基线。

定位：知识记事实、案例记教训、资产记方法。两类载体：
- 文本资产：content 列存全文（小文本，召回时直接注入）
- 文件资产：文件落 assets_dir 下的目录（path 列记路径），召回只注入引用卡，
  agent 用 bash 直接读/执行（沙箱全盘只读，天然可见）——代码不进上下文

PG 是唯一元数据源（scope/复用数/反馈/生命周期）；文件系统只是内容载体。
生命周期与知识库同款（upsert 幂等、软过期、反馈分），复用统计直接记行上
（use_count/last_used_at——资产的「被用」就是 prepare 注入那一刻）。
"""

from __future__ import annotations

import os
import shutil

from .db import pool

# recall 注入时的 kind 优先级：方法优先，基线次之，工具产物再次
_KIND_ORDER = {"procedure": 0, "baseline": 1, "query": 2, "script": 3}

# 收编护栏：单次收编的文件数/总字节上限（资产库在内网磁盘，防失控不收大文件）
_MAX_FILES = 200
_MAX_BYTES = 50 * 1024 * 1024


async def upsert(env: str, domain: str, task: str, kind: str, name: str,
                 summary: str, content: str,
                 source_run: str | None = None,
                 path: str | None = None) -> None:
    """幂等 upsert（同 (domain, task, kind, name) 整替换并刷新有效期）。"""
    async with pool().connection() as conn:
        await conn.execute(
            "INSERT INTO assets (env, domain, task, kind, name, summary,"
            " content, source_run, path) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (env, domain, task, kind, name) DO UPDATE SET"
            " summary=EXCLUDED.summary, content=EXCLUDED.content,"
            " source_run=EXCLUDED.source_run, path=EXCLUDED.path,"
            " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
            " created_at=now()",
            (env, domain, task, kind, name, summary, content, source_run,
             path))


async def search_active(env: str, domain: str, task: str,
                        limit: int = 8) -> list[dict]:
    """prepare 注入用：任务级资产优先，其次域级通用；同类内按复用数/反馈排。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, task, kind, name, summary, content, use_count,"
            " feedback_score, source_run, path FROM assets"
            " WHERE env=%s AND domain=%s AND task IN (%s, '')"
            " AND valid_to IS NULL"
            " ORDER BY CASE WHEN task=%s THEN 0 ELSE 1 END, use_count DESC,"
            " COALESCE(feedback_score,0) DESC, created_at DESC LIMIT %s",
            (env, domain, task, task, limit * 2))
        rows = await cur.fetchall()
    rows = sorted(rows, key=lambda r: (
        0 if r[1] == task else 1, _KIND_ORDER.get(r[2], 9)))[:limit]
    return [_row(r) for r in rows]


async def mark_used(ids: list[int]) -> None:
    """prepare 注入即记一次复用。"""
    if not ids:
        return
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET use_count=use_count+1, last_used_at=now()"
            " WHERE id = ANY(%s)", (ids,))


async def list_all(env: str, domain: str | None = None,
                   include_inactive: bool = True) -> list[dict]:
    where = "WHERE env=%s"
    params: list = [env]
    if domain:
        where += " AND domain=%s"
        params.append(domain)
    if not include_inactive:
        where += " AND valid_to IS NULL"
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, domain, task, kind, name, summary, use_count,"
            " last_used_at, feedback_score, valid_to IS NOT NULL,"
            " superseded_by, source_run, created_at, path FROM assets " + where +
            " ORDER BY kind, task, name LIMIT 500", tuple(params))
        rows = await cur.fetchall()
    return [{**_row_meta(r)} for r in rows]


async def kind_stats(env: str) -> dict[str, int]:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT kind, COUNT(*) FROM assets WHERE env=%s"
            " AND valid_to IS NULL GROUP BY kind ORDER BY kind", (env,))
        rows = await cur.fetchall()
    return {k: n for k, n in rows}


async def get_entry(asset_id: int) -> dict | None:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, env, domain, task, kind, name, summary, content,"
            " use_count, last_used_at, feedback_score, valid_to, source_run,"
            " created_at, path FROM assets WHERE id=%s", (asset_id,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "env": row[1], "domain": row[2], "task": row[3],
            "kind": row[4], "name": row[5], "summary": row[6],
            "content": row[7], "use_count": row[8],
            "last_used_at": row[9].isoformat() if row[9] else None,
            "feedback_score": row[10],
            "valid_to": row[11].isoformat() if row[11] else None,
            "source_run": row[12],
            "created_at": row[13].isoformat() if row[13] else None,
            "path": row[14]}


async def update(asset_id: int, summary: str, content: str) -> None:
    """网页编辑：改摘要/说明并刷新有效期（视为人工修正，重新生效）。
    文件类资产的文件本体不从网页改——重新跑 run 用 save_asset 覆盖。"""
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET summary=%s, content=%s, valid_from=now(),"
            " valid_to=NULL, superseded_by=NULL, created_at=now() WHERE id=%s",
            (summary, content, asset_id))


async def mark_expired(asset_id: int) -> None:
    async with pool().connection() as conn:
        await conn.execute("UPDATE assets SET valid_to=now() WHERE id=%s",
                           (asset_id,))


async def restore(asset_id: int) -> None:
    async with pool().connection() as conn:
        await conn.execute(
            "UPDATE assets SET valid_to=NULL, superseded_by=NULL,"
            " valid_from=now() WHERE id=%s", (asset_id,))


# ==================== 文件库（assets_dir 下的目录包） ====================


def asset_dir(root: str, env: str, domain: str, task: str, kind: str,
              name: str) -> str:
    """资产目录：<root>/<env>/<域>/<任务或_shared>/<kind>__<name>。
    名字可做目录名（中文没问题），只压掉路径分隔符与点前缀。"""
    def safe(s: str) -> str:
        s = s.strip().replace("/", "_").replace("\\", "_").lstrip(".")
        return s or "_"
    return os.path.join(root, safe(env), safe(domain), safe(task or "_shared"),
                        f"{safe(kind)}__{safe(name)}")


def collect_files(root: str, env: str, domain: str, task: str, kind: str,
                  name: str, files: list[str], scratch_dir: str
                  ) -> tuple[str, int, int]:
    """把 scratch 里的文件/目录收编进资产库（整替换）。返回 (目录, 文件数, 字节数)。

    护栏：来源必须解析在 scratch_dir 内（防路径穿越读到宿主任意文件）；
    文件数/总字节超上限直接报错——agent 收到错误可裁剪后重试。
    """
    scratch = os.path.realpath(scratch_dir)
    dest = asset_dir(root, env, domain, task, kind, name)
    staging = dest + ".staging"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging, exist_ok=True)
    try:
        for rel in files:
            src = os.path.realpath(os.path.join(scratch, rel))
            if not src.startswith(scratch + os.sep):
                raise ValueError(f"路径越出 scratch：{rel}")
            if not os.path.exists(src):
                raise ValueError(f"scratch 里不存在：{rel}")
            target = os.path.join(staging, os.path.basename(src.rstrip("/")))
            if os.path.isdir(src):
                shutil.copytree(src, target)
            else:
                shutil.copy2(src, target)
        count, total = 0, 0
        for dirpath, _dirs, fnames in os.walk(staging):
            for f in fnames:
                count += 1
                total += os.path.getsize(os.path.join(dirpath, f))
        if count > _MAX_FILES or total > _MAX_BYTES:
            raise ValueError(
                f"收编超上限（{count} 文件 / {total // 1024}KB；"
                f"上限 {_MAX_FILES} 文件 / {_MAX_BYTES // 1024 // 1024}MB）")
        shutil.rmtree(dest, ignore_errors=True)  # 整替换：清旧版文件
        os.replace(staging, dest)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return dest, count, total


def list_files(path: str, limit: int = 50) -> list[dict]:
    """资产目录的文件清单（相对路径 + 字节数），页面抽屉/注入卡用。"""
    out = []
    if not path or not os.path.isdir(path):
        return out
    for dirpath, _dirs, fnames in os.walk(path):
        for f in sorted(fnames):
            full = os.path.join(dirpath, f)
            out.append({"name": os.path.relpath(full, path),
                        "size": os.path.getsize(full)})
            if len(out) >= limit:
                return out
    return out


def read_asset_file(path: str, rel: str, limit: int = 100_000) -> str:
    """读资产目录里的单个文件（页面查看用）。越界/二进制给结构化回显。"""
    base = os.path.realpath(path)
    full = os.path.realpath(os.path.join(base, rel))
    if not full.startswith(base + os.sep) or not os.path.isfile(full):
        raise FileNotFoundError(rel)
    with open(full, "rb") as fh:
        raw = fh.read(limit + 1)
    try:
        text = raw[:limit].decode("utf-8")
    except UnicodeDecodeError:
        return f"[二进制文件，{os.path.getsize(full)} 字节，不可在线查看]"
    if len(raw) > limit:
        text += f"\n…[截断，共 {os.path.getsize(full)} 字节]"
    return text


def _row(r) -> dict:
    return {"id": r[0], "task": r[1], "kind": r[2], "name": r[3],
            "summary": r[4], "content": r[5], "use_count": r[6],
            "feedback_score": r[7], "source_run": r[8], "path": r[9]}


def _row_meta(r) -> dict:
    return {"id": r[0], "domain": r[1], "task": r[2], "kind": r[3],
            "name": r[4], "summary": r[5], "use_count": r[6],
            "last_used_at": r[7].isoformat() if r[7] else None,
            "feedback_score": r[8], "expired": r[9],
            "superseded_by": r[10], "source_run": r[11],
            "created_at": r[12].isoformat() if r[12] else None,
            "path": r[13]}
