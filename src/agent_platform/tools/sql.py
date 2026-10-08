"""sql_query 薄工具：只读 SQL 查询（替代"bash 里拼 psql"）。

防线：单语句 + 只读事务 + statement_timeout + 强制行数上限 +
结构化错误（语法/超时/权限分开）——比 bash 的 stderr 文本对 agent 友好。
"""

from __future__ import annotations

import re

MAX_ROWS = 200
_STATEMENT_TIMEOUT_MS = 15000

_BLOCKED = re.compile(
    r";\s*\S|"  # 多语句
    r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute)\b",
    re.IGNORECASE)


def validate_query(sql: str) -> str | None:
    """只读校验；返回 None 表示合法，否则返回拒绝原因。"""
    s = sql.strip().rstrip(";").strip()
    if not re.match(r"(select|with|explain)\b", s, re.IGNORECASE):
        return "仅允许 SELECT/WITH/EXPLAIN"
    if _BLOCKED.search(s):
        return "语句包含写操作或多语句"
    return None


async def run_query(dsn: str, sql: str, max_rows: int = MAX_ROWS) -> str:
    """只读连接执行；结果渲染为 markdown 表（截断到 max_rows）。"""
    err = validate_query(sql)
    if err:
        return f"[拒绝] {err}"
    import psycopg
    try:
        async with await psycopg.AsyncConnection.connect(
                dsn, autocommit=True,
                options=f"-c statement_timeout={_STATEMENT_TIMEOUT_MS} "
                        f"-c default_transaction_read_only=on") as conn:
            cur = await conn.execute(sql)
            cols = [d.name for d in cur.description] if cur.description else []
            rows = await cur.fetchmany(max_rows + 1)
    except Exception as e:
        return f"[SQL 错误] {type(e).__name__}: {str(e)[:500]}"
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    lines = ["| " + " | ".join(cols) + " |",
             "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(str(v) for v in r) + " |" for r in rows]
    if truncated:
        lines.append(f"... [仅显示前 {max_rows} 行]")
    return "\n".join(lines)
