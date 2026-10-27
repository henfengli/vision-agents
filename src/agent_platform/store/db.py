"""Postgres 连接池与建表。全库唯一的 schema 定义点，启动时幂等执行。

表一览：
- definitions        服务/角色/任务 + 平台配置的版本化定义（写一次 = 一个新版本，历史全留；
                     删除 = 写一个 deleted 版本，恢复旧版本即复活）
- api_keys           调用方密钥（只存哈希；只标识身份，不分权限）
- runs / run_events  运行台账与全过程事件（审计与排障的事实源）；runs 同时是执行队列：
                     status=queued 的行由 worker 用 FOR UPDATE SKIP LOCKED 认领，heartbeat_at 判断执行者是否还活着；
                     recipe 记这次运行用的各定义版本（配方）；每台主机上的 worker 只认领自己负责的环境（和服务）的行。
                     过程事件按保留期清理（config.RetentionConfig）
- service_configs    给 agent 用的只读版配置：服务×环境×路径，每次保存一个新版本
- knowledge / knowledge_history / recall_hits   记忆（agent 记下的事：fact 事实 / lesson 报错教训 / handoff 交接摘要；
                     时序化、内容历史、召回埋点）。env 为空 = 对该服务所有环境成立
- assets / asset_history   方法（做法/脚本/查询/基线；文件本体在 assets_dir）
- feedback           反馈（对整次运行或某一步：分数 + 问题类型 + 说明；一人一步一条）
- replays / replay_items   回归重放：拿被 👎 过的运行用当前定义重跑，并排对比、模型判定有没有改好

档案（人写的）不在库表里，在服务 / 任务定义的 profile 字段。
schema_version 记录库结构版本。
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from psycopg_pool import AsyncConnectionPool

log = logging.getLogger(__name__)

SCHEMA_VERSION = 10

SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (
    version    INT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS definitions (
    kind       TEXT NOT NULL,                -- service / role / task / config
    name       TEXT NOT NULL,
    version    INT  NOT NULL,
    definition JSONB NOT NULL,
    deleted    BOOLEAN NOT NULL DEFAULT false,
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (kind, name, version)
);

CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,       -- 调用方身份：写进 runs.caller
    prefix       TEXT NOT NULL,              -- 明文前 8 位，列表里辨认用
    hash         TEXT NOT NULL UNIQUE,       -- sha256(明文)
    note         TEXT NOT NULL DEFAULT '',
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS runs (
    run_id          TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,           -- 会话；独立运行时 = run_id
    task            TEXT NOT NULL,           -- 任务名（子任务为 父:对象）
    task_version    INT,
    role            TEXT,
    role_version    INT,
    recipe          JSONB,                   -- 配方：这次运行用的每样定义各是第几版（任务与父任务、角色继承链、
                                             -- 子代理、服务、平台提示词）+ 模型 + 平台版本
    service         TEXT,                    -- 平台任务为 NULL
    env             TEXT NOT NULL,
    trigger_type    TEXT NOT NULL,           -- api/chat/schedule/event/web/rerun/resume/correction
    trigger_id      TEXT,
    trigger_source  TEXT,
    caller          TEXT NOT NULL,           -- 调用身份；缺省 = trigger_type
    summary         TEXT NOT NULL DEFAULT '',
    input           JSONB NOT NULL DEFAULT '{}',
    memory          JSONB NOT NULL DEFAULT '{}', -- 本次运行的记忆开关覆盖 {recall, save}
    output          JSONB,
    status          TEXT NOT NULL,           -- queued/running/success/failed/cancelled
    resolution      TEXT,                    -- agent/builtin/rule
    error_code      TEXT,
    dedup_key       TEXT,
    idempotency_key TEXT,
    tokens          INT,
    duration_ms     INT,
    resume          BOOLEAN NOT NULL DEFAULT false,  -- 下次认领时从 checkpoint 接着跑
    worker          TEXT,                    -- 认领它的 worker（主机:pid）
    heartbeat_at    TIMESTAMPTZ,             -- 执行中每 20 秒刷新；停了就是执行进程没了
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);
-- 执行中的工具（bash / py）每几秒写一次输出尾部：{键: {tool, output, ms, at}}；工具结束删键，运行结束清空
ALTER TABLE runs ADD COLUMN IF NOT EXISTS progress JSONB;
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_service_env ON runs (service, env, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_dedup ON runs (dedup_key, created_at) WHERE dedup_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idem ON runs (idempotency_key) WHERE idempotency_key IS NOT NULL;
DROP INDEX IF EXISTS idx_runs_queue;
CREATE INDEX IF NOT EXISTS idx_runs_queue_env ON runs (env, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_runs_role ON runs (role, created_at DESC) WHERE role IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_events (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    seq        INT  NOT NULL,
    kind       TEXT NOT NULL,                -- stage/model_call/tool_call/tool_result/final/error
    payload    JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS service_configs (
    service    TEXT NOT NULL,
    env        TEXT NOT NULL,
    path       TEXT NOT NULL,                -- 定义里的写法（configs 的一项，可含 {env} 和 ~）
    version    INT  NOT NULL,
    content    TEXT NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (service, env, path, version)
);

DROP TABLE IF EXISTS service_instances;
DROP TABLE IF EXISTS code_sync_state;

CREATE TABLE IF NOT EXISTS knowledge (
    id             BIGSERIAL PRIMARY KEY,
    env            TEXT NOT NULL,             -- '' = 对该服务所有环境成立
    service        TEXT NOT NULL,
    task           TEXT NOT NULL DEFAULT '',  -- 沉淀来源任务（谱系排序依据）
    kind           TEXT NOT NULL DEFAULT 'fact',  -- fact / lesson / handoff
    fingerprint    TEXT,                      -- lesson：报错指纹（同类报错精确命中）
    category       TEXT,                      -- lesson：code / data / infra / upstream
    key            TEXT NOT NULL,
    content        TEXT NOT NULL,
    source_run     TEXT,
    code_ref       JSONB,                     -- {path, commit}
    expired        BOOLEAN NOT NULL DEFAULT false,
    feedback_score INT NOT NULL DEFAULT 0,
    valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to       TIMESTAMPTZ,
    superseded_by  TEXT,
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE (env, service, key)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_lesson ON knowledge (service, fingerprint) WHERE kind = 'lesson';

CREATE TABLE IF NOT EXISTS knowledge_history (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    service    TEXT NOT NULL,
    key        TEXT NOT NULL,
    version    INT  NOT NULL,
    content    TEXT NOT NULL,
    code_ref   JSONB,
    source     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (env, service, key, version)
);

CREATE TABLE IF NOT EXISTS recall_hits (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    service    TEXT NOT NULL,
    entry_id   BIGINT NOT NULL,
    run_id     TEXT,
    source     TEXT NOT NULL DEFAULT 'recall',   -- recall（旧版本还有控制台试检索写的 playground，统计不算）
    rank       INT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recall_hits_entry ON recall_hits (env, entry_id, created_at);

CREATE TABLE IF NOT EXISTS assets (
    id             BIGSERIAL PRIMARY KEY,
    env            TEXT NOT NULL,
    service        TEXT NOT NULL DEFAULT '',
    task           TEXT NOT NULL DEFAULT '',   -- 空 = 服务通用
    kind           TEXT NOT NULL,              -- procedure/script/query/baseline
    name           TEXT NOT NULL,
    summary        TEXT NOT NULL DEFAULT '',
    content        TEXT NOT NULL,
    path           TEXT,
    source_run     TEXT,
    use_count      INT NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ,
    feedback_score INT NOT NULL DEFAULT 0,
    valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to       TIMESTAMPTZ,
    superseded_by  TEXT,
    created_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE (env, service, task, kind, name)
);

CREATE TABLE IF NOT EXISTS asset_history (
    id         BIGSERIAL PRIMARY KEY,
    env        TEXT NOT NULL,
    service    TEXT NOT NULL DEFAULT '',
    task       TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    version    INT  NOT NULL,
    summary    TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL,
    path       TEXT,
    source     TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (env, service, task, kind, name, version)
);

CREATE TABLE IF NOT EXISTS feedback (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
    step_seq   INT  NOT NULL DEFAULT 0,          -- 0 = 整次运行；>0 = 时间线上的某一步
    score      SMALLINT NOT NULL,                -- 1 有用 / -1 有问题
    reasons    TEXT[] NOT NULL DEFAULT '{}',     -- 问题类型（domain/feedback.py）
    comment    TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (run_id, step_seq, created_by)        -- 一人一步一条：改主意是覆盖
);
CREATE INDEX IF NOT EXISTS idx_feedback_negative ON feedback (created_at DESC) WHERE score < 0;

CREATE TABLE IF NOT EXISTS replays (
    id         BIGSERIAL PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    filter     JSONB NOT NULL DEFAULT '{}',      -- 选样条件（任务 / 服务 / 环境 / 时间 / 指定运行）
    note       TEXT NOT NULL DEFAULT '',         -- 这次改了什么（"data_searcher 提示词加了口径确认"）
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_items (
    id           BIGSERIAL PRIMARY KEY,
    replay_id    BIGINT NOT NULL REFERENCES replays (id) ON DELETE CASCADE,
    source_run   TEXT NOT NULL,                  -- 被 👎 的原运行
    new_run      TEXT,                           -- 重放出来的运行
    verdict      TEXT,                           -- fixed / same / worse / unclear；空 = 还没判
    reason       TEXT NOT NULL DEFAULT '',
    judged_at    TIMESTAMPTZ,
    UNIQUE (replay_id, source_run)
);
CREATE INDEX IF NOT EXISTS idx_replay_items_new_run ON replay_items (new_run);

DO $$ BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
"""

# 可选能力：扩展缺失时跳过对应能力（向量检索退化为 pg_trgm），但留痕
OPTIONAL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    "ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1024)",
    "CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge USING hnsw (embedding vector_cosine_ops)",
]

_dsn: str | None = None
_pool: "AsyncConnectionPool | None" = None


async def open_db(dsn: str) -> None:
    """开连接池 + 幂等建表。"""
    global _dsn, _pool
    _dsn = dsn
    from psycopg_pool import AsyncConnectionPool
    _pool = AsyncConnectionPool(dsn, open=False, min_size=1, max_size=10)
    await _pool.open()
    async with _pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(SCHEMA)
            await conn.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT DO NOTHING",
                               (SCHEMA_VERSION,))
        # 每条单独事务：失败只回滚自己（同一事务里失败会让后续语句全部报 InFailedSqlTransaction）
        for sql in OPTIONAL:
            try:
                async with conn.transaction():
                    await conn.execute(sql)
            except Exception as e:  # noqa: BLE001
                log.warning("可选能力跳过（后续依赖它的也跳过）：%.70s → %s", sql, e)
                break


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
    async with pool().connection() as conn:
        await conn.execute("SELECT pg_notify(%s, %s)", (channel, payload))


async def has_vector() -> bool:
    async with pool().connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name='knowledge' AND column_name='embedding'")
        return await cur.fetchone() is not None
