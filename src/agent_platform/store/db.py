"""Postgres 连接池与建表。全库唯一的 schema 定义点，启动时幂等执行。

表结构一眼看全：
- runs / run_events   执行台账（审计与排障的事实源）
- artifacts           资产化任务图的产物（血缘 + 输入指纹 + 重跑复用）
- definitions         角色/任务/策略的版本化定义（写后即时生效，历史全留）
- knowledge           知识库（时序化：valid_from/to + superseded_by）
- knowledge_history   知识内容历史（覆盖前旧内容快照，可回滚）
- cases               案例库（报错指纹归一化）
- recall_hits         召回埋点（真实召回按序记录命中，零召回/用量统计的数据源）
- feedback            反馈（rating=run 打分 / step=步骤打分 / correction=纠正）
- approvals           危险命令审批单
- assets              任务资产（方法/脚本/查询/基线；文件本体在 assets_dir）
- asset_history       资产内容历史（覆盖前旧内容快照，可回滚）
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

log = logging.getLogger(__name__)

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
    trigger_source TEXT NOT NULL,            -- sdk/cli/web/sensor/webhook/schedule/feedback/resume/rerun
    caller        TEXT,
    input         JSONB,
    output        JSONB,
    status        TEXT NOT NULL,             -- queued/running/success/failed/cancelled
    dedup_key     TEXT,
    tokens        INT,
    duration_ms   INT,
    created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runs_dedup ON runs(dedup_key, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
-- 列表页/总览页：runs 是 append-only 增长表，默认 created_at 排序 +
-- status 过滤不能一直靠 seq scan + sort
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status_created ON runs(status, created_at DESC);

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
    kind       TEXT NOT NULL DEFAULT 'rating',  -- rating / correction / step
    score      INT,                             -- +1/-1（rating 与 step）
    step_seq   INT,                             -- 仅 kind=step：时间线步骤的 seq
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

-- 召回埋点：哪些条目被哪些 run 实际命中（记忆运营的事实源——
-- 零召回识别/负反馈治理/衰减的数据基础；playground 试用单独标 source）
CREATE TABLE IF NOT EXISTS recall_hits (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    domain     TEXT NOT NULL,
    entry_id   BIGINT NOT NULL,
    run_id     TEXT,
    source     TEXT NOT NULL DEFAULT 'recall',  -- recall / playground
    rank       INT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recall_hits_entry
    ON recall_hits(env, entry_id, created_at);

-- 任务资产：run 产出的可复用方法/脚本/查询/基线。与知识同套生命周期
-- （时序/取代/反馈/usage），复用计数直接记在行上；
-- path 非空 = 文件类资产（内容载体在 assets_dir 下的目录，PG 只管元数据）
CREATE TABLE IF NOT EXISTS assets (
    id           BIGSERIAL PRIMARY KEY,
    env          TEXT NOT NULL,
    domain       TEXT NOT NULL DEFAULT '',
    task         TEXT NOT NULL DEFAULT '',   -- 空 = 域级通用
    kind         TEXT NOT NULL,              -- procedure/script/query/baseline/…
    name         TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL,
    path         TEXT,
    source_run   TEXT,
    use_count    INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    feedback_score INT DEFAULT 0,
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to     TIMESTAMPTZ,
    superseded_by TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, task, kind, name)
);

-- 内容历史：主表整替换前的旧内容快照（assets 同构）。主表只留当前态
-- （召回/检索路径不变），历史只进不出（除 per-key 裁剪），回滚 = 把历史
-- 版本写回主表（写回前当前内容同样快照，回滚可逆）。
CREATE TABLE IF NOT EXISTS asset_history (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    domain     TEXT NOT NULL DEFAULT '',
    task       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    version    INT  NOT NULL,              -- 自然键内递增（v1 = 最初被覆盖的内容）
    summary    TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    path       TEXT,                       -- 当时的文件载体（文件本体留档在 .revs）
    source     TEXT NOT NULL DEFAULT '',   -- upsert:<run_id> / web-edit / rollback-to-vN
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, task, kind, name, version)
);

CREATE TABLE IF NOT EXISTS knowledge_history (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    domain     TEXT NOT NULL,
    key        TEXT NOT NULL,
    version    INT  NOT NULL,
    content    TEXT NOT NULL,
    code_ref   JSONB,
    source     TEXT NOT NULL DEFAULT '',   -- upsert:<run_id> / web-edit / rollback-to-vN
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, key, version)
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
    "ALTER TABLE feedback ADD COLUMN IF NOT EXISTS step_seq INT",
    "CREATE EXTENSION IF NOT EXISTS vector",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1024)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_embedding "
    "ON knowledge USING hnsw (embedding vector_cosine_ops)",
    # 召回埋点（老库补建；新库 SCHEMA 已含，幂等）
    """CREATE TABLE IF NOT EXISTS recall_hits (
    id BIGSERIAL PRIMARY KEY, env TEXT NOT NULL, domain TEXT NOT NULL,
    entry_id BIGINT NOT NULL, run_id TEXT,
    source TEXT NOT NULL DEFAULT 'recall', rank INT,
    created_at TIMESTAMPTZ DEFAULT now())""",
    "CREATE INDEX IF NOT EXISTS idx_recall_hits_entry"
    " ON recall_hits(env, entry_id, created_at)",
    # 任务资产（老库补建；新库 SCHEMA 已含，幂等）
    """CREATE TABLE IF NOT EXISTS assets (
    id BIGSERIAL PRIMARY KEY, env TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, name TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
    source_run TEXT, use_count INT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ, feedback_score INT DEFAULT 0,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(), valid_to TIMESTAMPTZ,
    superseded_by TEXT, created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(env, domain, task, kind, name))""",
    "ALTER TABLE assets ADD COLUMN IF NOT EXISTS path TEXT",
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
            except Exception as e:  # noqa: BLE001 —— 扩展缺失时跳过对应能力，但留痕
                log.warning("迁移跳过：%.80s → %s", sql.strip(), e)


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
