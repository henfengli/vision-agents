"""db_query：查本服务本环境登记的只读库。一个工具覆盖几种库，连接串的 scheme 决定类型：

    postgresql:// postgres://       PostgreSQL（psycopg）
    mysql:// mariadb://             MySQL / MariaDB（pymysql）
    doris://                        Apache Doris（MySQL 协议，默认端口 9030）
    clickhouse:// clickhouses://    ClickHouse（HTTP 接口，默认 8123；clickhouses = HTTPS，默认 8443）
    mongodb:// mongodb+srv://       MongoDB（查询写成 JSON，见 MONGO_HELP）

只读：单条语句、开头必须是查询类关键字；PG 用只读事务，MySQL / MariaDB 用只读事务会话，ClickHouse 用 readonly=2，
MongoDB 只允许 find / aggregate（不含 $out / $merge）/ count / distinct / 列集合。兜底的是服务定义里配的只读账号。
限时：每条 QUERY_TIMEOUT_S 秒（库侧的执行超时 + 客户端读超时）。

结果：20 行以内直接返回表格；更多时全部写进工作目录的文件（SQL 库 CSV、MongoDB JSONL），只返回行数、列和前 20 行，
agent 按需用 bash（head / grep / awk）或 py（pandas.read_csv）读。最多取 MAX_ROWS 行、MAX_FILE_BYTES 字节。
驱动在线程里跑（同步驱动、互不影响），一个连接只跑一条查询。
"""

from __future__ import annotations

import asyncio
import csv
import datetime as dt
import decimal
import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Iterator
from urllib.parse import parse_qsl, unquote, urlsplit

from ...domain.services import db_kind

QUERY_TIMEOUT_S = 30
MAX_ROWS = 100_000
MAX_FILE_BYTES = 50 * 1024 * 1024
PREVIEW_ROWS = 20
CELL_CHARS = 120
OUTPUT_CHARS = 6000
LABELS = {"postgres": "PostgreSQL", "mysql": "MySQL/MariaDB", "doris": "Doris", "clickhouse": "ClickHouse",
          "mongo": "MongoDB"}

MONGO_HELP = ('MongoDB 的 query 写 JSON（支持扩展 JSON，如 {"$oid": …}、{"$date": "2026-10-01T00:00:00Z"}）：'
              '{"collection": "c", "filter": {...}, "projection": {...}, "sort": {"f": -1}, "limit": 100} 查文档；'
              '{"collection": "c", "pipeline": [...]} 聚合；{"collection": "c", "count": {...}} 计数；'
              '{"collection": "c", "distinct": "字段", "filter": {...}}；{"collections": true} 列出集合')

# 允许的开头关键字（按库）；EXPLAIN 在 PG 里可以带 ANALYZE（只读事务里照样只读）
_LEADING = {
    "postgres": {"select", "with", "explain", "show", "values", "table"},
    "mysql": {"select", "with", "explain", "show", "describe", "desc"},
    "doris": {"select", "with", "explain", "show", "describe", "desc"},
    "clickhouse": {"select", "with", "explain", "show", "describe", "desc", "exists"},
}
# 开头已经限定是查询；除 PG（只读事务挡得住）以外，去掉字符串与注释之后还出现这些词就拒绝
# （挡 WITH … UPDATE、SELECT … INTO OUTFILE、SELECT … FOR UPDATE 这类藏在查询里的写操作）
_WRITE = re.compile(r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|rename|outfile|dumpfile)\b",
                    re.IGNORECASE)
_STRIP = re.compile(r"'(?:[^'\\]|\\.|'')*'|\"(?:[^\"\\]|\\.)*\"|`[^`]*`|--[^\n]*|#[^\n]*|/\*.*?\*/", re.DOTALL)


class QueryError(Exception):
    pass


def check_sql(sql: str, kind: str) -> str:
    """→ 规整后的语句；不合规抛 QueryError。"""
    text = sql.strip().rstrip(";").strip()
    if not text:
        raise QueryError("语句为空")
    bare = _STRIP.sub(" ", text)
    if ";" in bare:
        raise QueryError("一次只能执行一条语句")
    first = (bare.split() or [""])[0].lower().lstrip("(")
    allowed = _LEADING[kind]
    if first not in allowed:
        raise QueryError(f"只允许查询：语句要以 {' / '.join(sorted(k.upper() for k in allowed))} 开头")
    if kind != "postgres" and (m := _WRITE.search(bare)):
        raise QueryError(f"语句里有写操作或会话设置（{m.group(1).upper()}），这里只能查询")
    return text


# ———————— 结果 ————————

@dataclass
class Result:
    columns: list[str]
    rows: list[list[Any]]           # 预览（前 PREVIEW_ROWS 行）
    count: int                      # 实际取到的行数
    capped: str = ""                # 没取全的原因（行数 / 文件大小到上限）
    path: str | None = None         # 全部结果写在哪
    note: str = ""


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, str, bool)):
        return v
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        raw = bytes(v)
        try:
            return raw.decode()
        except UnicodeDecodeError:
            return "0x" + raw.hex()
    if isinstance(v, (dict, list, tuple)):
        return json.dumps(v, ensure_ascii=False, default=str)
    return str(v)


class Sink:
    """边取边写：前 PREVIEW_ROWS 行留着做预览；超过就把全部写进文件。"""

    def __init__(self, out_dir: str, stem: str, columns: list[str], jsonl: bool = False):
        self.columns, self.jsonl = columns, jsonl
        self._dir, self._stem = out_dir, stem
        self.rows: list[list[Any]] = []
        self.count = 0
        self.capped = ""
        self.path: str | None = None
        self._f: Any = None
        self._w: Any = None
        self._bytes = 0

    def _open(self) -> None:
        os.makedirs(self._dir, exist_ok=True)
        self.path = os.path.join(self._dir, self._stem + (".jsonl" if self.jsonl else ".csv"))
        self._f = open(self.path, "w", encoding="utf-8", newline="")
        if not self.jsonl:
            self._w = csv.writer(self._f)
            self._w.writerow(self.columns)
        for r in self.rows:
            self._write(r)

    def _write(self, row: list[Any]) -> None:
        if self.jsonl:
            line = row[0] + "\n"
            self._f.write(line)
        else:
            line = row
            self._w.writerow(["" if v is None else v for v in row])
        self._bytes += len(str(line)) + 8

    def add(self, row: list[Any]) -> bool:
        """→ False 表示到上限了，别再取。"""
        if self.count >= MAX_ROWS:
            self.capped = f"只取了前 {MAX_ROWS} 行"
            return False
        if self._bytes >= MAX_FILE_BYTES:
            self.capped = f"文件到了 {MAX_FILE_BYTES // 1024 // 1024}MB，只取了前 {self.count} 行"
            return False
        self.count += 1
        if self.count <= PREVIEW_ROWS:
            self.rows.append(row)
            return True
        if self._f is None:
            self._open()
        self._write(row)
        return True

    def close(self) -> Result:
        if self._f is not None:
            self._f.close()
        return Result(self.columns, self.rows, self.count, self.capped, self.path)


# ———————— 各库 ————————

def _parts(url: str, default_port: int) -> dict:
    u = urlsplit(url)
    return {"host": u.hostname or "127.0.0.1", "port": u.port or default_port, "user": unquote(u.username or ""),
            "password": unquote(u.password or ""), "database": unquote(u.path.lstrip("/")) or None,
            "params": dict(parse_qsl(u.query)), "secure": u.scheme.endswith("s")}


def _pg(url: str, sql: str, sink_of) -> Result:
    import psycopg

    dsn = re.sub(r"^postgres://", "postgresql://", url)
    with psycopg.connect(dsn, connect_timeout=10,
                         options=f"-c statement_timeout={QUERY_TIMEOUT_S * 1000} -c default_transaction_read_only=on") as conn:
        conn.read_only = True
        first = _STRIP.sub(" ", sql).split()[0].lower().lstrip("(")
        # 查询类语句用服务端游标：边取边写，大结果不进内存；EXPLAIN / SHOW 不能 DECLARE，用普通游标
        cur = conn.cursor(name=f"q{uuid.uuid4().hex[:8]}") if first in ("select", "with", "values", "table") else conn.cursor()
        with cur:
            cur.execute(sql)
            sink = sink_of([d.name for d in cur.description or []])
            while rows := cur.fetchmany(2000):
                if not all(sink.add([_cell(v) for v in r]) for r in rows):
                    break
            return sink.close()


def _mysql(url: str, sql: str, sink_of, kind: str) -> Result:
    import pymysql
    import pymysql.cursors

    p = _parts(url, 9030 if kind == "doris" else 3306)
    conn = pymysql.connect(host=p["host"], port=p["port"], user=p["user"], password=p["password"],
                           database=p["database"], charset=p["params"].get("charset", "utf8mb4"), connect_timeout=10,
                           read_timeout=QUERY_TIMEOUT_S + 10, write_timeout=30, autocommit=True,
                           cursorclass=pymysql.cursors.SSCursor)
    try:
        with conn.cursor(pymysql.cursors.Cursor) as setup:
            # 各家的超时 / 只读写法不同，不认识的设置跳过（真正兜底的是只读账号）
            stmts = ([f"SET query_timeout = {QUERY_TIMEOUT_S}"] if kind == "doris" else
                     ["SET SESSION TRANSACTION READ ONLY", f"SET SESSION max_execution_time = {QUERY_TIMEOUT_S * 1000}",
                      f"SET SESSION max_statement_time = {QUERY_TIMEOUT_S}"])
            for stmt in stmts:
                try:
                    setup.execute(stmt)
                except pymysql.MySQLError:
                    pass
        cur = conn.cursor()
        cur.execute(sql)
        sink = sink_of([d[0] for d in cur.description or []])
        while rows := cur.fetchmany(2000):
            if not all(sink.add([_cell(v) for v in r]) for r in rows):
                break                       # 不排空剩余结果：直接断开连接，服务端跟着停
        return sink.close()
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _clickhouse(url: str, sql: str, sink_of) -> Result:
    import clickhouse_connect

    p = _parts(url, 8443 if url.startswith("clickhouses") else 8123)
    client = clickhouse_connect.get_client(
        host=p["host"], port=p["port"], username=p["user"] or "default", password=p["password"],
        database=p["database"] or "default", secure=p["secure"], connect_timeout=10,
        send_receive_timeout=QUERY_TIMEOUT_S + 10, autogenerate_session_id=False)
    settings = {"readonly": 2, "max_execution_time": QUERY_TIMEOUT_S, "max_result_rows": MAX_ROWS + 1,
                "result_overflow_mode": "break"}

    def fetch(with_settings: bool) -> Result:
        # 按块流式取：大结果不整份进内存，取够了就断开
        with client.query_row_block_stream(sql, settings=settings if with_settings else None) as stream:
            sink = sink_of(list(stream.source.column_names))
            for block in stream:
                if not all(sink.add([_cell(v) for v in r]) for r in block):
                    break
            return sink.close()

    try:
        try:
            return fetch(True)
        except Exception as e:  # noqa: BLE001 —— 账号本身是 readonly=1 时不许带任何设置：去掉重试
            if "readonly" not in str(e).lower():
                raise
            out = fetch(False)
            out.note = "（账号是 readonly=1，不能带超时与行数上限的设置，按账号自己的限制执行）"
            return out
    finally:
        client.close()


def _mongo(url: str, query: str, sink_of) -> Result:
    import pymongo
    from bson import json_util

    try:
        q = json_util.loads(query)
    except Exception as e:  # noqa: BLE001
        raise QueryError(f"MongoDB 的查询要写成 JSON：{e}。{MONGO_HELP}") from None
    if not isinstance(q, dict):
        raise QueryError(MONGO_HELP)
    client = pymongo.MongoClient(url, serverSelectionTimeoutMS=10_000, connectTimeoutMS=10_000,
                                 socketTimeoutMS=(QUERY_TIMEOUT_S + 10) * 1000, appname="agent-platform")
    try:
        database = client[q.get("database")] if q.get("database") else client.get_default_database()
        ms = QUERY_TIMEOUT_S * 1000
        if q.get("collections"):
            names = sorted(database.list_collection_names())
            sink = sink_of(["collection"])
            for n in names:
                sink.add([n])
            return sink.close()
        coll_name = q.get("collection")
        if not isinstance(coll_name, str) or not coll_name:
            raise QueryError("缺 collection。" + MONGO_HELP)
        coll = database[coll_name]
        if "count" in q:
            n = coll.count_documents(q["count"] or {}, maxTimeMS=ms)
            sink = sink_of(["count"])
            sink.add([n])
            return sink.close()
        if "distinct" in q:
            values = coll.distinct(q["distinct"], q.get("filter") or {}, maxTimeMS=ms)
            sink = sink_of([q["distinct"]])
            for v in values:
                if not sink.add([_cell(v)]):
                    break
            return sink.close()
        if "pipeline" in q:
            pipeline = q["pipeline"]
            if not isinstance(pipeline, list):
                raise QueryError("pipeline 要是数组")
            bad = [k for stage in pipeline if isinstance(stage, dict) for k in stage if k in ("$out", "$merge")]
            if bad:
                raise QueryError(f"聚合里不能有 {bad[0]}：这里只能查询")
            docs: Iterator = coll.aggregate(pipeline, maxTimeMS=ms, allowDiskUse=False)
        else:
            cursor = coll.find(q.get("filter") or {}, q.get("projection"), max_time_ms=ms)
            if q.get("sort"):
                sort = q["sort"]
                cursor = cursor.sort(list(sort.items()) if isinstance(sort, dict) else [tuple(x) for x in sort])
            if q.get("skip"):
                cursor = cursor.skip(int(q["skip"]))
            cursor = cursor.limit(min(int(q.get("limit") or MAX_ROWS), MAX_ROWS))
            docs = cursor
        sink = sink_of(["document"], jsonl=True)
        for d in docs:
            if not sink.add([json_util.dumps(d, ensure_ascii=False)]):
                break
        return sink.close()
    finally:
        client.close()


# ———————— 入口 ————————

def _run(url: str, query: str, out_dir: str, stem: str) -> Result:
    kind = db_kind(url)
    if kind is None:
        raise QueryError(f"不认识的连接串类型：{url.split('://')[0]}://")

    def sink_of(columns: list[str], jsonl: bool = False) -> Sink:
        return Sink(out_dir, stem, columns, jsonl)

    if kind == "mongo":
        return _mongo(url, query, sink_of)
    sql = check_sql(query, kind)
    if kind == "postgres":
        return _pg(url, sql, sink_of)
    if kind == "clickhouse":
        return _clickhouse(url, sql, sink_of)
    return _mysql(url, sql, sink_of, kind)


def _clip(v: Any) -> str:
    text = "" if v is None else str(v)
    text = text.replace("\r", "").replace("\n", "⏎").replace("|", "\\|")
    return text if len(text) <= CELL_CHARS else text[:CELL_CHARS] + "…"


def render(r: Result, name: str, kind: str, ms: int) -> str:
    head = f"[{LABELS.get(kind, kind)} · {name}] {r.count} 行" + (f" × {len(r.columns)} 列" if kind != "mongo" else "") \
        + f"，{ms} ms" + (f"；{r.capped}（要全部就加条件或先在库里聚合）" if r.capped else "") + r.note
    lines = [head]
    if r.path:
        fmt = "JSONL，一行一个文档" if kind == "mongo" else "UTF-8 CSV，首行是列名"
        lines.append(f"全部结果在 {r.path}（{fmt}）：用 bash（head / grep / awk / wc）或 py（pandas.read_csv）按需读，"
                     f"不要整份打印。下面是前 {len(r.rows)} 行：")
    if kind == "mongo" or r.columns == ["document"]:
        lines += [_clip(row[0]) if len(str(row[0])) <= 600 else str(row[0])[:600] + "…" for row in r.rows]
    elif r.columns:
        cols = r.columns[:30]
        lines.append("| " + " | ".join(_clip(c) for c in cols) + " |" + (" …" if len(r.columns) > 30 else ""))
        lines.append("|" + "---|" * len(cols))
        lines += ["| " + " | ".join(_clip(v) for v in row[:30]) + " |" for row in r.rows]
    text = "\n".join(lines)
    if len(text) > OUTPUT_CHARS:
        text = text[:OUTPUT_CHARS] + "\n…[预览截断" + ("，全部结果见上面的文件" if r.path else "") + "]"
    return text


async def run_query(name: str, url: str, query: str, out_dir: str) -> str:
    """执行一条查询，返回给模型的文本（错误也是文本）。out_dir：结果文件放哪（工作目录下）。"""
    kind = db_kind(url) or "?"
    stem = f"{time.strftime('%H%M%S')}-{name}-{uuid.uuid4().hex[:6]}"
    t0 = time.monotonic()
    try:
        r = await asyncio.wait_for(asyncio.to_thread(_run, url, query, out_dir, stem), QUERY_TIMEOUT_S + 30)
    except QueryError as e:
        return f"[拒绝] {e}"
    except (TimeoutError, asyncio.TimeoutError):
        return f"[超时] 超过 {QUERY_TIMEOUT_S + 30}s 没有返回"
    except ModuleNotFoundError as e:
        return f"[不可用] 平台没装 {LABELS.get(kind, kind)} 的驱动（{e.name}）"
    except Exception as e:  # noqa: BLE001 —— 库侧的报错原样给模型改
        return f"[查询出错] {LABELS.get(kind, kind)}：{type(e).__name__}: {str(e)[:800]}"
    return render(r, name, kind, int((time.monotonic() - t0) * 1000))
