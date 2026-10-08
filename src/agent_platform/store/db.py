"""Postgres 连接池与建表。全库唯一的 schema 定义点，启动时幂等执行。

表结构一眼看全：
- runs / run_events   执行台账（审计与排障的事实源）
- artifacts           资产化任务图的产物（血缘 + 输入指纹 + 重跑复用）
- definitions         角色/任务/策略的版本化定义（写后即时生效，历史全留）
- knowledge           知识库（时序化：valid_from/to + superseded_by）
- cases               案例库（报错指纹归一化）
- feedback            反馈（rating=打分 / correction=纠正）
- approvals           危险命令审批单
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,             -- 会话标识；无会话时 = run_id
    task_type     TEXT NOT NULL,
    role          TEXT NOT NULL,
    task_version  INT,                       -- 执行时生效的任务定义版本（谱系固定）
    role_version  INT,                       -- 执行时生效的角色定义版本
    domain        TEXT,
    target_env    TEXT NOT NULL DEFAULT '',  -- 目标业务环境（prod/test/dev…）：本 run 操作哪套环境的服务
    trigger_source TEXT NOT NULL,            -- sdk/cli/web/sensor/webhook/schedule/feedback/resume
    caller        TEXT,
    input         JSONB,
    output        JSONB,
    status        TEXT NOT NULL,             -- queued/running/success/failed
    dedup_key     TEXT,
    tokens        INT,
    duration_ms   INT,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_dedup ON runs(dedup_key, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS run_events (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT REFERENCES runs(run_id),
    seq        INT,
    kind       TEXT,                         -- tool_call/tool_result/thought/llm/note/trace
    payload    JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
    run_id      TEXT REFERENCES runs(run_id),
    task_type   TEXT NOT NULL,
    name        TEXT NOT NULL,               -- 产物节点名
    target_env  TEXT NOT NULL DEFAULT '',    -- 目标业务环境：复用只在同环境内发生
    content     JSONB,                       -- 产物内容（skipped/rejected 为 NULL）
    input_hash  TEXT,                        -- 输入指纹：重跑复用的判定依据
    status      TEXT NOT NULL,               -- materialized/reused/skipped/rejected
    created_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (run_id, name)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_reuse
    ON artifacts(target_env, task_type, name, input_hash, created_at);

CREATE TABLE IF NOT EXISTS definitions (
    kind       TEXT NOT NULL,                -- role / task
    env        TEXT NOT NULL,
    name       TEXT NOT NULL,
    version    INT  NOT NULL,
    definition JSONB NOT NULL,
    updated_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (kind, env, name, version)
);

CREATE TABLE IF NOT EXISTS knowledge (
    id             BIGSERIAL PRIMARY KEY,
    env            TEXT NOT NULL,
    domain         TEXT NOT NULL,
    key            TEXT NOT NULL,
    content        TEXT NOT NULL,
    source_run     TEXT,
    code_ref       JSONB,                    -- {path, commit}：召回时校验新鲜度
    expired        BOOLEAN NOT NULL DEFAULT false,
    feedback_score INT DEFAULT 0,
    valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to       TIMESTAMPTZ,              -- 非空 = 已被取代（软过期，历史保留）
    superseded_by  TEXT,
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, key)
);

CREATE TABLE IF NOT EXISTS cases (
    id          BIGSERIAL PRIMARY KEY,
    env         TEXT NOT NULL,
    domain      TEXT,
    fingerprint TEXT NOT NULL,               -- 报错指纹（归一化后 hash）
    category    TEXT,                        -- code/data/infra/upstream
    conclusion  TEXT,
    source_run  TEXT,
    thumbs_up   INT DEFAULT 0,
    thumbs_down INT DEFAULT 0,
    valid_to    TIMESTAMPTZ,
    superseded_by TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, fingerprint)
);

CREATE TABLE IF NOT EXISTS feedback (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT REFERENCES runs(run_id),
    session_id TEXT,
    kind       TEXT NOT NULL DEFAULT 'rating',  -- rating / correction
    score      INT,                             -- +1/-1（仅 rating）
    comment    TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
    id          BIGSERIAL PRIMARY KEY,
    run_id      TEXT NOT NULL,
    command     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
    decided_by  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    decided_at  TIMESTAMPTZ
);

-- pg_trgm：知识/案例的关键词相似度检索（无 pg_trgm 时跳过，退化 ILIKE）
DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
"""

# 列级迁移：老库升级用（幂等）。vector 扩展缺失时静默跳过，向量检索自动退化。
MIGRATIONS = [
    # 已有库的增量列（新库由 SCHEMA 一步到位）
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS task_version INT",
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS role_version INT",
    "ALTER TABLE runs ADD COLUMN IF NOT EXISTS target_env TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS target_env"
    " TEXT NOT NULL DEFAULT ''",
    "CREATE INDEX IF NOT EXISTS idx_artifacts_reuse_env"
    " ON artifacts(target_env, task_type, name, input_hash, created_at)",
    # seq 撞号兜底（存量库若有历史重复则索引创建失败，advisory lock 仍保未来）
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_seq"
    " ON run_events(run_id, seq)",
    "CREATE EXTENSION IF NOT EXISTS vector",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1024)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_embedding "
    "ON knowledge USING hnsw (embedding vector_cosine_ops)",
]

_dsn: str | None = None
_pool: "AsyncConnectionPool | None" = None


async def open_db(dsn: str) -> None:
    """开连接池 + 幂等建表/迁移。服务启动时调用一次。"""
    global _dsn, _pool
    _dsn = dsn
    from psycopg_pool import AsyncConnectionPool
    _pool = AsyncConnectionPool(dsn, open=False, min_size=1, max_size=8)
    await _pool.open()
    async with _pool.connection() as conn:
        await conn.execute(SCHEMA)
        for sql in MIGRATIONS:
            try:
                await conn.execute(sql)
            except Exception:  # noqa: BLE001 —— 扩展缺失时跳过对应能力
                pass


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> "AsyncConnectionPool":
    if _pool is None:
        raise RuntimeError("DB 未初始化：先 await open_db(dsn)")
    return _pool


def dsn() -> str:
    if _dsn is None:
        raise RuntimeError("DB 未初始化")
    return _dsn


async def notify(channel: str, payload: str) -> None:
    """跨进程事件通知（审批唤醒用）。配合 LISTEN 一侧在 runtime 层。"""
    async with pool().connection() as conn:
        await conn.execute("SELECT pg_notify(%s, %s)", (channel, payload))
