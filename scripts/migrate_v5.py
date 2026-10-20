#!/usr/bin/env python3
"""v5 → v6 数据库迁移。一次性、在停服状态下执行：

    AGENT_ENV=prod python scripts/migrate_v5.py --profile prod          # 先演练：只打印会做什么
    AGENT_ENV=prod python scripts/migrate_v5.py --profile prod --apply  # 执行

做的事（同一个事务里，失败整体回滚）：
1. 把 v5 的全部表复制到 schema v5_backup（备份，确认无误后可手工 DROP SCHEMA v5_backup CASCADE）
2. v5 表改名为 _v5_*，建 v6 表
3. 搬数据：
   - 定义：v5 按"实例环境"存（--profile 选哪一套），role/task/domain 三类；domain → service。
     搬不动的（v6 校验不过）记日志跳过，启动时由 conf/seeds 补种子
   - 运行台账、事件、产物、反馈、审批、知识、案例、方法：domain → service、target_env → env、task_type → task
4. 删掉 _v5_* 表

v6 的平台配置（环境、审批、通知…）不从 v5 搬：首次启动按 conf/seeds/settings.yaml 播种，再在设置页调整。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

V5_TABLES = ["runs", "run_events", "artifacts", "definitions", "knowledge", "knowledge_history", "recall_hits",
             "cases", "feedback", "approvals", "assets", "asset_history"]

TRIGGER_TYPES = {"sdk": "api", "cli": "api", "api": "api", "web": "web", "web_chat": "chat", "chat": "chat",
                 "sensor": "event", "dagster_sensor": "event", "webhook": "event", "schedule": "schedule",
                 "feedback": "correction", "resume": "resume", "rerun": "rerun"}
# (表, v6 列, 从 v5 取的表达式)
MEMORY_TABLES = [
    ("knowledge",
     "id, env, service, task, key, content, source_run, code_ref, expired, feedback_score, valid_from, valid_to,"
     " superseded_by, created_at",
     "id, env, domain, task, key, content, source_run, code_ref, expired, COALESCE(feedback_score, 0), valid_from,"
     " valid_to, superseded_by, created_at"),
    ("knowledge_history",
     "id, env, service, key, version, content, code_ref, source, created_at",
     "id, env, domain, key, version, content, code_ref, source, created_at"),
    ("recall_hits",
     "id, env, service, entry_id, run_id, source, rank, created_at",
     "id, env, domain, entry_id, run_id, source, rank, created_at"),
    ("cases",
     "id, env, service, fingerprint, category, conclusion, source_run, thumbs_up, thumbs_down, valid_to,"
     " superseded_by, created_at",
     "id, env, COALESCE(domain, ''), fingerprint, category, conclusion, source_run, COALESCE(thumbs_up, 0),"
     " COALESCE(thumbs_down, 0), valid_to, superseded_by, created_at"),
    ("assets",
     "id, env, service, task, kind, name, summary, content, path, source_run, use_count, last_used_at,"
     " feedback_score, valid_from, valid_to, superseded_by, created_at",
     "id, env, domain, task, kind, name, summary, content, path, source_run, use_count, last_used_at,"
     " COALESCE(feedback_score, 0), valid_from, valid_to, superseded_by, created_at"),
    ("asset_history",
     "id, env, service, task, kind, name, version, summary, content, path, source, created_at",
     "id, env, domain, task, kind, name, version, summary, content, path, source, created_at"),
]

EVENT_KINDS = {"tool_call": "tool_call", "tool_result": "tool_result", "thought": "thought", "llm": "final",
               "note": "stage", "graph": "stage"}


def convert_task(d: dict) -> dict:
    """v5 TaskDef → v6 TaskDef 的字段对应。"""
    out = {k: d[k] for k in ("role", "timeout_s", "enabled", "extends", "auto_created", "handler") if k in d}
    if d.get("context"):
        out["profile"] = d["context"]
    if d.get("input_schema"):
        out["input"] = {k: {"type": "text" if v == "text" else "str"} for k, v in d["input_schema"].items()}
    if d.get("env_gate"):
        out["envs"] = d["env_gate"]
    if d.get("dedup_key"):
        out["dedup"] = {"key": d["dedup_key"], "window_s": d.get("dedup_window_s", 600)}
    if d.get("output_channel") == "dingtalk":
        out["deliver"] = {"channel": "default"}
    elif d.get("output_channel") == "http" and d.get("output_callback"):
        out["deliver"] = {"url": d["output_callback"]}
    if d.get("artifacts"):
        out["form"], out["graph"] = "graph", d["artifacts"]
    elif d.get("handler"):
        out["form"] = "builtin"
    if not d.get("extends"):
        triggers = [{"id": "api", "type": "api"}]
        if {"web_chat", "chat"} & set(d.get("triggers") or []):
            triggers.append({"id": "chat", "type": "chat"})
        if d.get("schedule"):
            triggers.append({"id": "schedule", "type": "schedule", "cron": d["schedule"],
                             "envs": d.get("env_gate") or ["prod"], "input": d.get("schedule_input") or {}})
        out["triggers"] = triggers
    return out


def convert_definitions(rows: list[tuple], profile: str) -> list[tuple[str, str, dict]]:
    from agent_platform.domain import RoleDef, ServiceDef, TaskDef

    latest: dict[tuple[str, str], dict] = {}
    for kind, env, name, _version, definition in sorted(rows, key=lambda r: r[3]):
        if env == profile:
            latest[(kind, name)] = definition if isinstance(definition, dict) else json.loads(definition)
    out = []
    for (kind, name), d in sorted(latest.items()):
        try:
            if kind == "role":
                body = {k: d[k] for k in ("prompt", "tools", "extends", "prompt_append", "description") if k in d}
                RoleDef.model_validate(body)
                out.append(("role", name, body))
            elif kind == "task":
                body = convert_task(d)
                TaskDef.model_validate(body)
                out.append(("task", name, body))
            elif kind == "domain":
                body = {k: d[k] for k in ("code_paths", "hosts", "readonly_dsn", "envs", "profile", "enabled") if k in d}
                body["root"] = (d.get("code_paths") or [""])[0]
                ServiceDef.model_validate(body)
                out.append(("service", name, body))
        except Exception as e:  # noqa: BLE001 —— 搬不动的留给种子
            print(f"  跳过 {kind} {name}：{e}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, help="v5 定义按哪个实例环境（AGENT_ENV）搬")
    ap.add_argument("--dsn", default=os.environ.get("AGENT_DSN"), help="缺省读 AGENT_ENV 对应部署配置里的 db_dsn")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    import psycopg

    from agent_platform.store.db import SCHEMA, SCHEMA_VERSION
    dsn = args.dsn
    if not dsn:
        from agent_platform.config import load_settings
        dsn = load_settings(args.profile).db_dsn

    with psycopg.connect(dsn) as conn:
        cur = conn.execute("SELECT 1 FROM information_schema.columns WHERE table_name='runs' AND column_name='task_type'")
        if not cur.fetchone():
            sys.exit("库里没有 v5 结构（runs.task_type），无需迁移")
        counts = {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in V5_TABLES
                  if conn.execute("SELECT to_regclass(%s)", (t,)).fetchone()[0]}
        print("v5 数据：", ", ".join(f"{t} {n}" for t, n in counts.items()))
        defs = convert_definitions(conn.execute("SELECT kind, env, name, version, definition FROM definitions").fetchall(),
                                   args.profile)
        print(f"可搬定义 {len(defs)} 条：", ", ".join(f"{k}/{n}" for k, n, _ in defs))
        if not args.apply:
            print("演练结束；加 --apply 执行")
            return

        with conn.transaction():
            conn.execute("CREATE SCHEMA IF NOT EXISTS v5_backup")
            for t in counts:
                conn.execute(f"CREATE TABLE v5_backup.{t} AS TABLE public.{t}")
                conn.execute(f"ALTER TABLE public.{t} RENAME TO _v5_{t}")
            conn.execute(SCHEMA)

            for kind, name, body in defs:
                conn.execute("INSERT INTO definitions (kind, name, version, definition, updated_by) VALUES (%s,%s,1,%s,'migrate-v5')",
                             (kind, name, json.dumps(body, ensure_ascii=False)))

            trigger_case = "CASE trigger_source " + " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TRIGGER_TYPES.items()) + " ELSE 'api' END"
            conn.execute(f"""
                INSERT INTO runs (run_id, session_id, task, task_version, role, role_version, service, env, trigger_type,
                                  caller, summary, input, output, status, resolution, dedup_key, tokens, duration_ms,
                                  created_at, started_at, finished_at)
                SELECT run_id, session_id, task_type, task_version, NULLIF(role, ''), role_version, domain,
                       COALESCE(NULLIF(target_env, ''), %s), {trigger_case}, COALESCE(NULLIF(caller, ''), trigger_source),
                       LEFT(COALESCE(input->>'question', input->>'asset_key', ''), 300), COALESCE(input, '{{}}'), output,
                       status, CASE WHEN status='success' THEN 'agent' END, dedup_key, tokens, duration_ms,
                       created_at, created_at,
                       CASE WHEN status IN ('success','failed','cancelled')
                            THEN created_at + make_interval(secs => COALESCE(duration_ms, 0) / 1000.0) END
                FROM _v5_runs""", (args.profile,))
            kind_case = "CASE kind " + " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in EVENT_KINDS.items()) + " END"
            conn.execute(f"""
                INSERT INTO run_events (run_id, seq, kind, payload, created_at)
                SELECT DISTINCT ON (run_id, seq) run_id, seq, {kind_case}, COALESCE(payload, '{{}}'), created_at
                FROM _v5_run_events WHERE kind IN ({', '.join(f"'{k}'" for k in EVENT_KINDS)})
                  AND run_id IN (SELECT run_id FROM runs) ORDER BY run_id, seq, id""")
            conn.execute("""INSERT INTO artifacts (run_id, task, name, env, content, input_hash, status, created_at)
                            SELECT run_id, task_type, name, COALESCE(NULLIF(target_env, ''), %s), content, input_hash,
                                   status, created_at FROM _v5_artifacts""", (args.profile,))
            conn.execute("""INSERT INTO feedback (run_id, session_id, kind, score, step_seq, comment, created_at)
                            SELECT run_id, session_id, kind, score, step_seq, comment, created_at FROM _v5_feedback""")
            conn.execute("""INSERT INTO approvals (kind, run_id, title, detail, status, decided_by, created_at, decided_at)
                            SELECT 'command', run_id, '危险命令（v5）', command,
                                   CASE status WHEN 'pending' THEN 'expired' ELSE status END, decided_by, created_at,
                                   decided_at FROM _v5_approvals""")
            # 记忆类表：列一一对应，只有 domain 改名为 service
            for table, columns, select in MEMORY_TABLES:
                if table in counts:
                    conn.execute(f"INSERT INTO {table} ({columns}) SELECT {select} FROM _v5_{table}")
                    conn.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'),"
                                 f" COALESCE((SELECT max(id) FROM {table}), 1))")
            if "knowledge" in counts:
                try:
                    conn.execute("ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS embedding vector(1024)")
                    conn.execute("UPDATE knowledge k SET embedding = o.embedding FROM _v5_knowledge o WHERE o.id = k.id")
                except Exception as e:  # noqa: BLE001
                    print(f"  向量列没有搬（{e}）；新写入会重新生成")
            for t in counts:
                conn.execute(f"DROP TABLE _v5_{t} CASCADE")
            conn.execute("INSERT INTO schema_version (version) VALUES (%s) ON CONFLICT DO NOTHING", (SCHEMA_VERSION,))
        print("迁移完成。v5 备份在 schema v5_backup；启动 v6 后检查无误再 DROP SCHEMA v5_backup CASCADE")


if __name__ == "__main__":
    main()
