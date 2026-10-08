"""Postgres 连接与建表。单进程一个连接池，启动时幂等建表+列级迁移（无外部迁移工具）。"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    session_id    TEXT,                      -- 会话标识；无会话时 = run_id（自会话）
    task_type     TEXT NOT NULL,
    role          TEXT NOT NULL,
    domain        TEXT,
    trigger_source TEXT NOT NULL,            -- sdk/cli/web/sensor/webhook/schedule
    caller        TEXT,
    input         JSONB,
    output        JSONB,
    status        TEXT NOT NULL,             -- queued/running/done/failed/interrupted
    dedup_key     TEXT,
    tokens        INT,
    duration_ms   INT,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_dedup ON runs(dedup_key, created_at);

CREATE TABLE IF NOT EXISTS run_events (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT REFERENCES runs(run_id),
    seq        INT,
    kind       TEXT,                         -- tool_call/llm/note
    payload    JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge (
    id             BIGSERIAL PRIMARY KEY,
    env            TEXT NOT NULL,
    domain         TEXT NOT NULL,
    key            TEXT NOT NULL,
    content        TEXT NOT NULL,
    source_run     TEXT,
    code_ref       JSONB,                    -- {path, commit}
    expired        BOOLEAN NOT NULL DEFAULT false,
    feedback_score INT DEFAULT 0,
    -- 事实时序化：结论被纠正/失效时置 valid_to（软过期，历史保留可审计）
    valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to       TIMESTAMPTZ,
    superseded_by  TEXT,                     -- 取代本条目的 run_id
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, key)
);

CREATE TABLE IF NOT EXISTS cases (
    id          BIGSERIAL PRIMARY KEY,
    env         TEXT NOT NULL,
    domain      TEXT,
    fingerprint TEXT,
    category    TEXT,                        -- code/data/infra/upstream
    conclusion  TEXT,
    source_run  TEXT,
    thumbs_up   INT DEFAULT 0,
    thumbs_down INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cases_fp ON cases(env, fingerprint);

CREATE TABLE IF NOT EXISTS feedback (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT REFERENCES runs(run_id),
    session_id TEXT,                         -- session 级反馈（纠正式）
    kind       TEXT NOT NULL DEFAULT 'rating', -- rating=👍/👎 / correction=纠正重判
    score      INT,                          -- +1 / -1（仅 rating）
    comment    TEXT,
    correction_run_id TEXT,                  -- correction 触发的重判 run
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 角色/任务定义：同构的版本化定义表（写后即时生效，历史全留）
CREATE TABLE IF NOT EXISTS definitions (
    kind       TEXT NOT NULL,                -- role / task
    env        TEXT NOT NULL,
    name       TEXT NOT NULL,
    version    INT  NOT NULL,
    definition JSONB NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT true,
    updated_by TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (kind, env, name, version)
);

-- 待审批的危险命令（生产）
CREATE TABLE IF NOT EXISTS approvals (
    id          BIGSERIAL PRIMARY KEY,
    run_id      TEXT REFERENCES runs(run_id),
    command     TEXT NOT NULL,
    decision    TEXT,                        -- approved/rejected/NULL=待审
    decided_by  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    decided_at  TIMESTAMPTZ
);
"""

_pool: "AsyncConnectionPool | None" = None
_dsn: str = ""


def init_pool(dsn: str) -> "AsyncConnectionPool":
    from psycopg_pool import AsyncConnectionPool  # 延迟导入：纯逻辑模块不依赖 DB 驱动
    global _pool, _dsn
    _dsn = dsn
    _pool = AsyncConnectionPool(dsn, min_size=2, max_size=10, open=False)
    return _pool


def dsn() -> str:
    """LISTEN 等需要绕开连接池建独立连接的场景用。"""
    if not _dsn:
        raise RuntimeError("db 未初始化：先调用 init_pool()")
    return _dsn


def pool() -> "AsyncConnectionPool":
    if _pool is None:
        raise RuntimeError("db pool 未初始化：先调用 init_pool()")
    return _pool


# 存量库的增量迁移（CREATE TABLE IF NOT EXISTS 不会给老表补列）
_MIGRATIONS = (
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at)",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm",  # 知识检索相似度（无向量库时的内置方案）
    "CREATE INDEX IF NOT EXISTS idx_knowledge_trgm ON knowledge "
    "USING gin ((key || ' ' || content) gin_trgm_ops)",
    # 事实时序化
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now()",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS superseded_by TEXT",
    "ALTER TABLE cases ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ",
    "ALTER TABLE cases ADD COLUMN IF NOT EXISTS superseded_by TEXT",
    # 纠正式反馈
    "ALTER TABLE feedback ADD COLUMN IF NOT EXISTS session_id TEXT",
    "ALTER TABLE feedback ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'rating'",
    "ALTER TABLE feedback ADD COLUMN IF NOT EXISTS correction_run_id TEXT",
    # pgvector 混合检索（扩展不可用时整条跳过，检索自动退回 trgm/ILIKE）
    "CREATE EXTENSION IF NOT EXISTS vector",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1024)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge "
    "USING hnsw (embedding vector_cosine_ops)",
)


async def open_and_migrate(dsn: str) -> None:
    p = init_pool(dsn)
    await p.open()
    async with p.connection() as conn:
        await conn.execute(SCHEMA_SQL)
    # 增量迁移逐条独立提交：单条失败（如无 pg_trgm 权限）不能回滚建表，
    # 且不能让连接留在 aborted 事务状态
    async with pool().connection() as conn:
        await conn.set_autocommit(True)
        for stmt in _MIGRATIONS:
            try:
                await conn.execute(stmt)
            except Exception:  # noqa: BLE001 —— pg_trgm 缺失时检索自动退回 ILIKE
                import logging
                logging.getLogger(__name__).warning("迁移跳过：%s", stmt[:60])


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def notify(channel: str, payload: str = "") -> None:
    """PG LISTEN/NOTIFY 发送端：审批决定等事件的毫秒级唤醒提示。

    只是提示——DB 行仍是事实源，丢 notify 时接收方轮询兜底。
    """
    async with pool().connection() as conn:
        await conn.execute(f"SELECT pg_notify(%s, %s)", (channel, payload))
