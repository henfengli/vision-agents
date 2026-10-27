"""任务资产：run 产出的可复用产出——方法（procedure）/脚本/查询/基线。

定位：知识记事实、案例记教训、资产记方法。两类载体：
- 文本资产：content 列存全文（小文本，召回时直接注入）
- 文件资产：文件落 assets_dir 下的目录（path 列记路径），召回只注入引用卡，
  agent 用 bash 直接读/执行（沙箱全盘只读，天然可见）——代码不进上下文

PG 是唯一元数据源（scope/复用数/反馈/生命周期）；文件系统只是内容载体。
生命周期与知识库同款（upsert 幂等、软过期、反馈分），复用统计直接记行上
（use_count/last_used_at——资产的「被用」就是 prepare 注入那一刻）。

内容版本管理：upsert/update 覆盖前把旧 (summary, content, path) 快照进
asset_history（内容没变不记，防止重复保存刷屏）；回滚 = 历史版本写回主表
（写回前当前内容同样快照，回滚可逆）。文件本体的版本是另一套：
<资产目录>.revs/ 留档（collect_files / restore_revision）。
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime

from .db import pool

# recall 注入时的 kind 优先级：方法优先，基线次之，工具产物再次
_KIND_ORDER = {"procedure": 0, "baseline": 1, "query": 2, "script": 3}

# 收编护栏：单次收编的文件数/总字节上限（资产库在内网磁盘，防失控不收大文件）
_MAX_FILES = 200
_MAX_BYTES = 50 * 1024 * 1024
# 整替换留档（后悔药）：旧版目录整体挪到 <资产目录>.revs/<时间戳>/，保留最近 N 版
_KEEP_REVISIONS = 5
# 内容历史：每个自然键保留最近 N 版（distill/run 高频写入，防表膨胀）
_HISTORY_KEEP = 20


async def _put_history(conn, env: str, service: str, task: str, kind: str,
                       name: str, summary: str, content: str,
                       path: str | None, source: str) -> None:
    """把旧内容快照进 asset_history（版本 = 键内递增）并裁到最近 N 版。"""
    cur = await conn.execute(
        "SELECT COALESCE(MAX(version), 0) + 1 FROM asset_history"
        " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s",
        (env, service, task, kind, name))
    version = (await cur.fetchone())[0]
    await conn.execute(
        "INSERT INTO asset_history (env, service, task, kind, name, version,"
        " summary, content, path, source) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (env, service, task, kind, name, version, summary, content, path,
         source))
    await conn.execute(
        "DELETE FROM asset_history"
        " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s"
        " AND version <= %s",
        (env, service, task, kind, name, version - _HISTORY_KEEP))


async def upsert(env: str, service: str, task: str, kind: str, name: str,
                 summary: str, content: str,
                 source_run: str | None = None,
                 path: str | None = None) -> None:
    """幂等 upsert（同 (service, task, kind, name) 整替换并刷新有效期）。
    覆盖前旧内容快照进 asset_history（内容没变不记）。"""
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT summary, content, path FROM assets"
            " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s",
            (env, service, task, kind, name))
        old = await cur.fetchone()
        if old and (old[0], old[1], old[2]) != (summary, content, path):
            await _put_history(conn, env, service, task, kind, name,
                               old[0], old[1], old[2],
                               source_run or "upsert")
        await conn.execute(
            "INSERT INTO assets (env, service, task, kind, name, summary,"
            " content, source_run, path) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)"
            " ON CONFLICT (env, service, task, kind, name) DO UPDATE SET"
            " summary=EXCLUDED.summary, content=EXCLUDED.content,"
            " source_run=EXCLUDED.source_run, path=EXCLUDED.path,"
            " valid_from=now(), valid_to=NULL, superseded_by=NULL,"
            " created_at=now()",
            (env, service, task, kind, name, summary, content, source_run,
             path))


async def list_content_history(env: str, service: str, task: str, kind: str,
                               name: str) -> list[dict]:
    """内容历史（新版本在前）：回滚选择与审计用。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT version, summary, content, path, source, created_at"
            " FROM asset_history"
            " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s"
            " ORDER BY version DESC", (env, service, task, kind, name))
        rows = await cur.fetchall()
    return [{"version": r[0], "summary": r[1], "content": r[2], "path": r[3],
             "source": r[4], "created_at": r[5].isoformat()} for r in rows]


async def restore_content(env: str, service: str, task: str, kind: str,
                          name: str, version: int) -> None:
    """把历史版本写回主表（当前内容先快照，回滚可逆）。版本不存在 KeyError。"""
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT summary, content FROM asset_history"
            " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s"
            " AND version=%s", (env, service, task, kind, name, version))
        hist = await cur.fetchone()
        if hist is None:
            raise KeyError(f"无历史版本 v{version}")
        cur = await conn.execute(
            "SELECT summary, content, path FROM assets"
            " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s",
            (env, service, task, kind, name))
        cur_row = await cur.fetchone()
        if cur_row is None:
            raise KeyError("资产本体不存在")
        if (cur_row[0], cur_row[1]) != (hist[0], hist[1]):
            await _put_history(conn, env, service, task, kind, name,
                               cur_row[0], cur_row[1], cur_row[2],
                               f"rollback-to-v{version}")
        # 文件载体不回滚（文件版本走 .revs 那套）；只回文本内容
        await conn.execute(
            "UPDATE assets SET summary=%s, content=%s, valid_from=now(),"
            " valid_to=NULL, superseded_by=NULL, created_at=now()"
            " WHERE env=%s AND service=%s AND task=%s AND kind=%s AND name=%s",
            (hist[0], hist[1], env, service, task, kind, name))


async def search_active(env: str, service: str, task: str,
                        limit: int = 8, exclude_run: str | None = None) -> list[dict]:
    """prepare 注入用：任务级资产优先，其次服务通用；同类内按复用数/反馈排。
    exclude_run：回归重放时去掉原运行沉淀的。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, task, kind, name, summary, content, use_count,"
            " feedback_score, source_run, path FROM assets"
            " WHERE env=%s AND service=%s AND task IN (%s, '')"
            # 不重放时参数是 NULL：整个条件为真（人工登记的 source_run 也是 NULL，不能被滤掉）
            " AND valid_to IS NULL AND (%s::text IS NULL OR source_run IS DISTINCT FROM %s)"
            " ORDER BY CASE WHEN task=%s THEN 0 ELSE 1 END, use_count DESC,"
            " COALESCE(feedback_score,0) DESC, created_at DESC LIMIT %s",
            (env, service, task, exclude_run, exclude_run, task, limit * 2))
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


async def list_all(env: str, service: str | None = None,
                   include_inactive: bool = True) -> list[dict]:
    rows, _, _ = await list_filtered(env, service=service,
                                     active=None if include_inactive else True,
                                     limit=500)
    return rows


async def list_filtered(env: str, service: str | None = None,
                        q: str | None = None, kind: str | None = None,
                        active: bool | None = None, offset: int = 0,
                        limit: int = 50) -> tuple[list[dict], int, int]:
    """资产页列表：过滤（域/关键词/类型/生效状态）+ offset 分页。

    返回 (rows, total, offset)。资产是低频小表，offset 足够；
    高 churn 的 runs 表才用 keyset（见 store/runs.py）。
    """
    conds, params = ["env=%s"], [env]
    if service:
        conds.append("service=%s")
        params.append(service)
    if kind:
        conds.append("kind=%s")
        params.append(kind)
    if active is True:
        conds.append("valid_to IS NULL")
    elif active is False:
        conds.append("valid_to IS NOT NULL")
    if q:
        conds.append("(name ILIKE %s OR summary ILIKE %s)")
        params += ["%" + q + "%", "%" + q + "%"]
    where = " WHERE " + " AND ".join(conds)
    cols = ("id, service, task, kind, name, summary, use_count, last_used_at,"
            " feedback_score, valid_to IS NOT NULL, superseded_by, source_run,"
            " created_at, path")
    async with pool().connection() as conn:
        cur = await conn.execute("SELECT count(*) FROM assets" + where, params)
        total = (await cur.fetchone())[0]
        cur = await conn.execute(
            f"SELECT {cols} FROM assets" + where +
            " ORDER BY valid_to IS NOT NULL, kind, task, name"
            " LIMIT %s OFFSET %s", (*params, limit, offset))
        rows = await cur.fetchall()
    return [{**_row_meta(r)} for r in rows], total, offset


async def service_counts(env: str) -> dict[str, dict]:
    """侧栏域计数（生效/失效），与列表过滤解耦。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT service, valid_to IS NOT NULL, count(*) FROM assets"
            " WHERE env=%s GROUP BY service, valid_to IS NOT NULL", (env,))
        rows = await cur.fetchall()
    side: dict[str, dict] = {}
    for dom, expired, n in rows:
        s = side.setdefault(dom, {"active": 0, "inactive": 0})
        s["inactive" if expired else "active"] += n
    return side


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
            "SELECT id, env, service, task, kind, name, summary, content,"
            " use_count, last_used_at, feedback_score, valid_to, source_run,"
            " created_at, path FROM assets WHERE id=%s", (asset_id,))
        row = await cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "env": row[1], "service": row[2], "task": row[3],
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
    文件类资产的文件本体不从网页改——重新跑 run 用 save_asset 覆盖。
    覆盖前旧内容快照进 asset_history（source=web-edit）。"""
    async with pool().connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT env, service, task, kind, name, summary, content, path"
            " FROM assets WHERE id=%s", (asset_id,))
        old = await cur.fetchone()
        if old is None:
            raise KeyError(asset_id)
        if (old[5], old[6]) != (summary, content):
            await _put_history(conn, *old[:5], old[5], old[6], old[7],
                               "web-edit")
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


def asset_dir(root: str, env: str, service: str, task: str, kind: str,
              name: str) -> str:
    """资产目录：<root>/<env>/<域>/<任务或_shared>/<kind>__<name>。
    名字可做目录名（中文没问题），只压掉路径分隔符与点前缀。"""
    def safe(s: str) -> str:
        s = s.strip().replace("/", "_").replace("\\", "_").lstrip(".")
        return s or "_"
    return os.path.join(root, safe(env), safe(service), safe(task or "_shared"),
                        f"{safe(kind)}__{safe(name)}")


def collect_files(root: str, env: str, service: str, task: str, kind: str,
                  name: str, files: list[str], scratch_dir: str
                  ) -> tuple[str, int, int]:
    """把 scratch 里的文件/目录收编进资产库（整替换）。返回 (目录, 文件数, 字节数)。

    整替换不留空窗：新内容先落 staging，旧版目录改名进 <dest>.revs/ 留档
    （保留最近 _KEEP_REVISIONS 版，os.replace 原子换入）。
    护栏：来源必须解析在 scratch_dir 内（防路径穿越读到宿主任意文件）；
    文件数/总字节超上限直接报错——agent 收到错误可裁剪后重试。
    """
    scratch = os.path.realpath(scratch_dir)
    dest = asset_dir(root, env, service, task, kind, name)
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
            # 按相对路径保目录结构落 staging：basename 拍平会让
            # files=["a/run.sh","b/run.sh"] 静默互相覆盖
            target = os.path.join(staging, os.path.relpath(src, scratch))
            os.makedirs(os.path.dirname(target), exist_ok=True)
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
        if os.path.isdir(dest):
            # 后悔药：整替换不清旧版，整体挪到 <dest>.revs/<时间戳>/ 留档
            rev = _new_revision_path(dest)
            os.makedirs(os.path.dirname(rev), exist_ok=True)
            os.replace(dest, rev)
            _prune_revisions(dest, _KEEP_REVISIONS)
        elif os.path.lexists(dest):
            os.remove(dest)  # 同名残留文件（异常态），清掉保证 replace 成功
        os.replace(staging, dest)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return dest, count, total


def _new_revision_path(dest: str) -> str:
    """留档路径：<dest>.revs/<微秒时间戳>——名字字典序即时间序，prune 按名
    排序不会误删新版（不能用同秒序号复用旧名：旧名被 prune 后序号名归零，
    新留档反而排到最前被当最旧删掉）。同微秒撞名加序号兜底。"""
    base = os.path.join(dest + ".revs",
                        datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    path, i = base, 0
    while os.path.exists(path):
        i += 1
        path = f"{base}-{i}"
    return path


def _prune_revisions(dest: str, keep: int) -> None:
    """只留最近 keep 版。时间戳命名（含同秒序号），字典序即时间序。"""
    revs = dest + ".revs"
    for name in sorted(os.listdir(revs))[:-keep]:  # len<=keep 时切片为空
        shutil.rmtree(os.path.join(revs, name), ignore_errors=True)


def list_revisions(path: str) -> list[dict]:
    """资产的历史版本留档（新的在前）——/v1/assets/{id} 详情展示后悔药。"""
    revs = (path or "") + ".revs"
    if not path or not os.path.isdir(revs):
        return []
    out = []
    for name in sorted(os.listdir(revs), reverse=True):
        full = os.path.join(revs, name)
        if not os.path.isdir(full):
            continue
        count, total = 0, 0
        for dirpath, _dirs, fnames in os.walk(full):
            for f in fnames:
                count += 1
                total += os.path.getsize(os.path.join(dirpath, f))
        out.append({"ts": name, "path": full, "files": count, "bytes": total})
    return out


def restore_revision(path: str, ts: str) -> None:
    """把留档版本 ts 恢复为资产当前版本（后悔药的出口）。

    当前版先整体留档——回滚本身也可回滚；指定留档挪回原位。
    FileNotFoundError：留档不存在；ValueError：资产无文件载体 / ts 非法。
    """
    if not path:
        raise ValueError("该资产没有文件载体")
    if not ts or "/" in ts or "\\" in ts or ts.startswith("."):
        raise ValueError(f"非法版本标识：{ts!r}")
    dest = os.path.realpath(path)
    revs_root = dest + ".revs"
    rev = os.path.realpath(os.path.join(revs_root, ts))
    if not rev.startswith(revs_root + os.sep) or not os.path.isdir(rev):
        raise FileNotFoundError(ts)
    if os.path.isdir(dest):
        cur = _new_revision_path(dest)  # 当前版留档，回滚可逆
        os.makedirs(os.path.dirname(cur), exist_ok=True)
        os.replace(dest, cur)
    os.replace(rev, dest)
    _prune_revisions(dest, _KEEP_REVISIONS)


def python_lint_errors(scratch_dir: str, files: list[str]) -> list[str]:
    """收编前检查：files 里的 .py（目录递归）逐个 compile()，返回错误清单。

    空列表=通过。路径护栏与 collect_files 同款（必须落在 scratch 内）；
    不存在/越界的路径交给 collect_files 报错，这里跳过——lint 只管
    「能读到的 .py 必须能编译」。
    """
    scratch = os.path.realpath(scratch_dir)
    targets: list[str] = []
    for rel in files:
        src = os.path.realpath(os.path.join(scratch, rel))
        if not src.startswith(scratch + os.sep) or not os.path.exists(src):
            continue
        if os.path.isdir(src):
            for dirpath, _dirs, fnames in os.walk(src):
                targets += [os.path.join(dirpath, f) for f in sorted(fnames)
                            if f.endswith(".py")]
        elif src.endswith(".py"):
            targets.append(src)
    errors = []
    for full in sorted(set(targets)):
        try:
            with open(full, "rb") as fh:
                compile(fh.read(), full, "exec")  # bytes 入参自动探测编码
        except (SyntaxError, ValueError) as e:
            errors.append(f"{os.path.relpath(full, scratch)}: {e}")
    return errors


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
    return {"id": r[0], "service": r[1], "task": r[2], "kind": r[3],
            "name": r[4], "summary": r[5], "use_count": r[6],
            "last_used_at": r[7].isoformat() if r[7] else None,
            "feedback_score": r[8], "expired": r[9],
            "superseded_by": r[10], "source_run": r[11],
            "created_at": r[12].isoformat() if r[12] else None,
            "path": r[13]}


async def by_ids(ids: list[int]) -> list[dict]:
    """按 id 批量取（run 详情还原「本次召回的任务资产」用）。"""
    if not ids:
        return []
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, task, kind, name, summary, use_count,"
            " last_used_at, feedback_score,"
            " (valid_to IS NOT NULL) AS expired, superseded_by, source_run,"
            " created_at, path"
            " FROM assets WHERE id = ANY(%s) ORDER BY id", (list(ids),))
        rows = await cur.fetchall()
    return [_row_meta(r) for r in rows]


async def by_source_run(run_id: str) -> list[dict]:
    """反查：某次 run 沉淀了哪些资产（run 详情「本次沉淀」用）。"""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, task, kind, name, summary, use_count,"
            " last_used_at, feedback_score,"
            " (valid_to IS NOT NULL) AS expired, superseded_by, source_run,"
            " created_at, path"
            " FROM assets WHERE source_run=%s ORDER BY id", (run_id,))
        rows = await cur.fetchall()
    return [_row_meta(r) for r in rows]


async def list_entries(env: str | None = None, service: str | None = None, task: str | None = None,
                       kind: str | None = None, status: str | None = None, entry_id: int | None = None,
                       q: str | None = None, limit: int = 300) -> list[dict]:
    """控制台方法页：跨环境可选，带文件清单（文件类资产）。task 含其子任务；status：active / superseded（已停用）/ all；
    q：名字、摘要、内容里不分大小写地找。"""
    conds, params = [], []
    for col, val in (("env", env), ("service", service), ("kind", kind), ("id", entry_id)):
        if val:
            conds.append(f"{col}=%s")
            params.append(val)
    if task:
        conds.append("(task=%s OR task LIKE %s)")
        params += [task, task + ":%"]
    if status == "active":
        conds.append("valid_to IS NULL")
    elif status == "superseded":
        conds.append("valid_to IS NOT NULL")
    if q and q.strip():
        like = f"%{q.strip()}%"
        conds.append("(name ILIKE %s OR summary ILIKE %s OR content ILIKE %s)")
        params += [like, like, like]
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT id, service, env, task, kind, name, summary, content, path, source_run, use_count, last_used_at,"
            " feedback_score, valid_to IS NOT NULL, created_at FROM assets" + where +
            " ORDER BY valid_to IS NOT NULL, use_count DESC, name LIMIT %s", (*params, limit))
        rows = await cur.fetchall()
    out = []
    for r in rows:
        files = list_files(r[8]) if r[8] else []
        out.append({"id": r[0], "service": r[1], "env": r[2], "task": r[3], "kind": r[4], "name": r[5],
                    "summary": r[6], "content": r[7], "files": [{"name": f["name"], "size": f.get("size", 0)} for f in files],
                    "source_run": r[9], "use_count": r[10], "last_used_at": r[11].isoformat() if r[11] else None,
                    "feedback_score": r[12], "status": "superseded" if r[13] else "active", "updated_at": r[14].isoformat()})
    return out
