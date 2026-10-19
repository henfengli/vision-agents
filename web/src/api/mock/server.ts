/**
 * mock 服务：按 /v1 契约响应，数据在内存里可增删改（刷新页面即复原）。
 * 只服务预览与前端开发；行为与真实后端保持一致（同样的过滤、分页、错误码）。
 */
import { ApiError } from "../client";
import type {
  Approval, Instance, Page, RunAccepted, RunListItem, SearchHit, ServiceSummary, Stats, TaskSummary, Version,
} from "../types";
import * as db from "./data";
import { cronNextOf } from "./schedule";

const latency = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 260));

type Q = Record<string, string | number | boolean | null | undefined>;
type Handler = (p: Record<string, string>, q: Q, body: any) => unknown;
const routes: [string, string, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, pattern, h]);

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

export async function handle(method: string, path: string, query: Q, body: unknown): Promise<unknown> {
  await latency();
  for (const [m, pattern, h] of routes) {
    if (m !== method) continue;
    const p = match(pattern, path);
    if (p) return structuredClone(h(p, query, body));
  }
  throw new ApiError(404, "not_found", `mock 未实现 ${method} ${path}`);
}

const notFound = (what: string) => new ApiError(404, "not_found", `${what} 不存在`);
const H = db.HOUR;
const within = (iso: string, hours: number) => Date.now() - new Date(iso).getTime() < hours * H;

// ———————— 版本历史（mock：按当前定义回推几版） ————————

const history = new Map<string, Version[]>();
function versionsOf(kind: string, name: string, current: Record<string, unknown>): Version[] {
  const key = kind + "/" + name;
  if (!history.has(key)) {
    const v = Number(current.version ?? 1);
    const list: Version[] = [];
    for (let i = v; i >= 1; i--) {
      const def = structuredClone(current);
      if (i < v) {
        if (typeof def.prompt === "string") def.prompt = (def.prompt as string).split("\n").slice(0, Math.max(2, 6 - (v - i))).join("\n");
        if (typeof def.description === "string" && i < v - 1) def.description = (def.description as string).replace(/：.*$/, "");
        if (Array.isArray(def.tools) && i < v - 1) def.tools = (def.tools as string[]).slice(0, -1);
        if (def.profile && i === 1) def.profile = {};
        if (typeof def.timeout_s === "number" && i < v) def.timeout_s = 300;
      }
      def.version = i;
      list.push({ version: i, updated_by: i === 1 ? "seed" : i === v ? String(current.updated_by ?? "lihf") : db.pick(["lihf", "wangzh", "chenyu"]), created_at: new Date(Date.now() - (v - i + 1) * 31 * H).toISOString(), definition: def });
    }
    history.set(key, list);
  }
  return history.get(key)!;
}

function bump<T extends { version: number; updated_by: string; updated_at: string }>(kind: string, target: T, patch: Partial<T>): T {
  const list = versionsOf(kind, (target as unknown as { name: string }).name, target as unknown as Record<string, unknown>);
  Object.assign(target, patch, { version: target.version + 1, updated_by: "you", updated_at: new Date().toISOString() });
  list.unshift({ version: target.version, updated_by: "you", created_at: target.updated_at, definition: structuredClone(target) as unknown as Record<string, unknown> });
  return target;
}

const kinds: Record<string, { list: { name: string }[] }> = {
  envs: { list: db.envs }, services: { list: db.services }, roles: { list: db.roles }, tasks: { list: db.tasks }, policies: { list: db.policies },
};

for (const kind of Object.keys(kinds)) {
  on("GET", `/v1/${kind}/:name/versions`, (p) => {
    const item = kinds[kind].list.find((x) => x.name === p.name);
    if (!item) throw notFound(p.name);
    return versionsOf(kind, p.name, item as unknown as Record<string, unknown>);
  });
  on("POST", `/v1/${kind}/:name/versions/:v/restore`, (p) => {
    const item = kinds[kind].list.find((x) => x.name === p.name) as unknown as { version: number; updated_by: string; updated_at: string; name: string };
    if (!item) throw notFound(p.name);
    const old = versionsOf(kind, p.name, item as unknown as Record<string, unknown>).find((v) => v.version === Number(p.v));
    if (!old) throw notFound("版本 " + p.v);
    const { version: _v, updated_by: _u, updated_at: _a, ...rest } = old.definition as Record<string, unknown>;
    void _v; void _u; void _a;
    return bump(kind, item, rest as Partial<typeof item>);
  });
}

// ———————— 元信息 / 环境 ————————

on("GET", "/v1/meta", () => ({
  version: "6.0.0", default_env: "test", langfuse_url: "https://langfuse.internal",
  features: { process_control: "systemd", vector_search: true },
  tools: [
    { name: "bash", title: "Shell", description: "bwrap 沙箱：全盘只读、scratch 可写、默认断网", group: "core", dangerous: true },
    { name: "run_code", title: "代码编排", description: "CodeAct：一段 Python 编排多个工具调用", group: "core", dangerous: true },
    { name: "service_info", title: "服务信息", description: "本 run 服务×环境的目录、配置文件内容、git 状态", group: "service", dangerous: false },
    { name: "service_ctl", title: "进程启停", description: "启停本服务的进程（受保护环境需审批）", group: "service", dangerous: true },
    { name: "sql_query", title: "只读 SQL", description: "本服务本环境的只读库，自动限时限量", group: "service", dangerous: false },
    { name: "host_metrics", title: "主机指标", description: "部署主机内存/负载/根盘（Grafana）", group: "service", dangerous: false },
    { name: "save_asset", title: "沉淀方法", description: "把可复用的方法/脚本/查询/基线存入记忆", group: "memory", dangerous: false },
    { name: "read_artifact", title: "读产物", description: "读取任务图上游节点的完整产物", group: "memory", dangerous: false },
    { name: "notify", title: "钉钉通知", description: "向业务群发送 markdown 通知", group: "notify", dangerous: false },
    { name: "browser_navigate", title: "浏览器 · 打开", description: "MCP：@playwright/mcp", group: "mcp", dangerous: false },
    { name: "browser_snapshot", title: "浏览器 · 快照", description: "MCP：@playwright/mcp", group: "mcp", dangerous: false },
    { name: "datahub_search", title: "DataHub 搜索", description: "MCP：mcp-server-datahub", group: "mcp", dangerous: false },
  ],
  event_sources: [
    { name: "dagster", title: "Dagster", events: [{ name: "run_failure", title: "运行失败", fields: ["run_id", "asset_key", "error", "env"] }] },
    { name: "gitlab", title: "GitLab", events: [{ name: "deployment", title: "部署成功", fields: ["project", "ref", "env", "health_url"] }] },
    { name: "webhook", title: "通用 Webhook", events: [{ name: "*", title: "任意事件", fields: [] }] },
  ],
}));

on("GET", "/v1/envs", () => db.envs);
on("PUT", "/v1/envs/:name", (p, _q, body) => {
  const e = db.envs.find((x) => x.name === p.name);
  if (!e) throw notFound("环境 " + p.name);
  return bump("envs", e, body);
});

// ———————— 服务 ————————

function serviceSummary(s: (typeof db.services)[number]): ServiceSummary {
  const health: ServiceSummary["health"] = {};
  for (const e of db.envs) {
    const rs = db.runs.filter((r) => r.service === s.name && r.env === e.name);
    const procs = db.instances.filter((i) => i.service === s.name && i.env === e.name);
    const last = rs[0];
    health[e.name] = {
      runs_24h: rs.filter((r) => within(r.created_at, 24)).length,
      failed_24h: rs.filter((r) => within(r.created_at, 24) && r.status === "failed").length,
      last_run: last ? { run_id: last.run_id, status: last.status, created_at: last.created_at } : null,
      running_processes: procs.filter((i) => i.state === "running").length,
      total_processes: procs.length,
    };
  }
  return { ...s, task_count: db.tasks.filter((t) => t.service === s.name && !t.extends).length, health };
}

on("GET", "/v1/services", () => db.services.map(serviceSummary));
on("GET", "/v1/services/:name", (p) => {
  const s = db.services.find((x) => x.name === p.name);
  if (!s) throw notFound("服务 " + p.name);
  return serviceSummary(s);
});
on("PUT", "/v1/services/:name", (p, _q, body) => {
  const s = db.services.find((x) => x.name === p.name);
  if (!s) throw notFound("服务 " + p.name);
  return bump("services", s, body);
});
on("POST", "/v1/services", (_p, _q, body) => {
  if (db.services.some((s) => s.name === body.name)) throw new ApiError(409, "conflict", `服务 ${body.name} 已存在`);
  const s = { title: "", description: "", root: "", code_paths: [], hosts: [], readonly_dsn: null, configs: [], processes: {}, envs: {}, profile: {}, enabled: true, ...body, version: 1, updated_by: "you", updated_at: new Date().toISOString() };
  db.services.push(s);
  return serviceSummary(s);
});
on("GET", "/v1/services/:name/view", (p, q) => {
  const s = db.services.find((x) => x.name === p.name);
  if (!s) throw notFound("服务 " + p.name);
  const env = String(q.env || "test");
  const o = s.envs[env] ?? {};
  return {
    service: s.name, env, root: s.root, code_paths: o.code_paths ?? s.code_paths, hosts: o.hosts ?? s.hosts,
    readonly_dsn: o.readonly_dsn ?? s.readonly_dsn,
    config_files: s.configs.map((c) => ({ canonical: c.canonical, path: c.template.replace("{env}", env), exists: !(s.name === "report-engine" && env === "dev"), size: 1200 + c.template.length * 37 })),
    profile: { ...s.profile, ...(o.profile ?? {}) },
    git: s.name === "report-engine" ? null : { branch: env === "prod" ? "release/2026.10" : "main", commit: db.hex(7), dirty: env === "dev", committed_at: new Date(Date.now() - 20 * H).toISOString() },
  };
});
on("GET", "/v1/services/:name/configs", (p, q) => {
  const s = db.services.find((x) => x.name === p.name);
  if (!s) throw notFound("服务 " + p.name);
  const env = String(q.env || "test");
  const file = String(q.path || "");
  return {
    path: file,
    content: file.endsWith(".yaml")
      ? `# ${file}\nrun_coordinator:\n  module: dagster._core.run_coordinator\n  class: QueuedRunCoordinator\n  config:\n    max_concurrent_runs: ${env === "prod" ? 8 : 2}\nstorage:\n  postgres:\n    postgres_url: postgresql://dagster:***@${env}-db:5432/dagster\ntelemetry:\n  enabled: false\n`
      : file.includes(".env")
        ? `# ${file}\nNODE_ENV=${env === "prod" ? "production" : env}\nPORT=${env === "prod" ? 8080 : env === "test" ? 8081 : 8082}\nDB_HOST=${env}-db\nDB_PASSWORD=***\nCACHE_TTL=600\n`
        : `# ${file}\n[server]\nport = ${env === "prod" ? 9080 : 9081}\nprofile = "${env}"\n`,
  };
});
on("GET", "/v1/services/:name/instances", (p) => db.instances.filter((i) => i.service === p.name));
for (const action of ["start", "stop", "renew"]) {
  on("POST", `/v1/services/:name/instances/:env/:proc/${action}`, (p) => {
    const inst = db.instances.find((i) => i.service === p.name && i.env === p.env && i.process === p.proc);
    if (!inst) throw notFound("进程");
    const env = db.envs.find((e) => e.name === p.env);
    if (env?.protected && action !== "renew") {
      const a: Approval = { id: Date.now() % 100000, kind: "process", run_id: null, title: `进程${action === "start" ? "启动" : "停止"} · ${p.name}/${p.proc}@${p.env}`, detail: `受保护环境，等待审批`, service: p.name, env: p.env, task: null, requested_by: "you", status: "pending", decided_by: null, comment: null, created_at: new Date().toISOString(), decided_at: null, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
      db.approvals.unshift(a);
      return { instance: inst, approval: a };
    }
    const now = new Date().toISOString();
    if (action === "start") Object.assign(inst, { state: "running", pid: db.between(2000, 39999), started_at: now, started_by: "you", lease_until: new Date(Date.now() + 2 * H).toISOString() } satisfies Partial<Instance>);
    if (action === "stop") Object.assign(inst, { state: "stopped", pid: null, started_at: null, lease_until: null, last_exit: { code: 0, at: now } } satisfies Partial<Instance>);
    if (action === "renew") inst.lease_until = new Date(new Date(inst.lease_until ?? now).getTime() + 2 * H).toISOString();
    return { instance: inst, approval: null };
  });
}
on("GET", "/v1/services/:name/instances/:env/:proc/logs", (p) => ({
  lines: Array.from({ length: 60 }, (_, i) => {
    const t = new Date(Date.now() - (60 - i) * 17_000).toISOString().slice(11, 19);
    return `${t} ${["INFO", "INFO", "INFO", "WARN", "INFO", "DEBUG"][i % 6]} [${p.proc}] ${["request GET /api/metrics/gmv 200 38ms", "cache hit gmv:2026-10-19", "scheduler tick: 3 runs queued", "slow query 1.8s: SELECT … FROM ads_order_daily", "request GET /health 200 2ms", "pool: 4/20 connections in use"][i % 6]}`;
  }),
}));

// ———————— 角色 / 策略 ————————

on("GET", "/v1/roles", () => db.roles);
on("GET", "/v1/roles/:name", (p) => db.roles.find((r) => r.name === p.name) ?? (() => { throw notFound("角色 " + p.name); })());
on("PUT", "/v1/roles/:name", (p, _q, body) => {
  const r = db.roles.find((x) => x.name === p.name);
  if (!r) throw notFound("角色 " + p.name);
  return bump("roles", r, body);
});
on("POST", "/v1/roles", (_p, _q, body) => {
  if (db.roles.some((r) => r.name === body.name)) throw new ApiError(409, "conflict", `角色 ${body.name} 已存在`);
  const r = { title: "", description: "", prompt: "", tools: [], extends: null, prompt_append: "", ...body, version: 1, updated_by: "you", updated_at: new Date().toISOString() };
  db.roles.push(r);
  return r;
});
on("GET", "/v1/roles/:name/resolved", (p) => {
  const chain: (typeof db.roles)[number][] = [];
  let r = db.roles.find((x) => x.name === p.name);
  while (r) { chain.unshift(r); r = r.extends ? db.roles.find((x) => x.name === r!.extends) : undefined; }
  const tools = chain.slice(1).reduce((acc, c) => (c.tools.length ? acc.filter((t) => c.tools.includes(t)) : acc), chain[0]?.tools ?? []);
  return { name: p.name, prompt: [chain[0]?.prompt, ...chain.slice(1).map((c) => c.prompt_append)].filter(Boolean).join("\n\n"), tools, lineage: chain.map((c) => c.name) };
});
on("GET", "/v1/policies", () => [...db.policies].sort((a, b) => a.order - b.order));
on("PUT", "/v1/policies/:name", (p, _q, body) => {
  const x = db.policies.find((y) => y.name === p.name);
  if (!x) throw notFound("策略 " + p.name);
  return bump("policies", x, body);
});
on("POST", "/v1/policies", (_p, _q, body) => {
  const x = { description: "", order: 100, applies_to: { tasks: [], services: [], envs: [] }, match_regex: ".*", action: "deny", message: "", enabled: true, ...body, version: 1, updated_by: "you", updated_at: new Date().toISOString() };
  db.policies.push(x);
  return x;
});

// ———————— 任务 ————————

function taskSummary(t: (typeof db.tasks)[number]): TaskSummary {
  const rs = db.runs.filter((r) => r.task === t.name || r.task.startsWith(t.name + ":"));
  const day = rs.filter((r) => within(r.created_at, 24));
  const durations = day.map((r) => r.duration_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const fires = t.triggers.flatMap((tr) => tr.type === "schedule" && tr.enabled !== false ? tr.envs.map((env) => ({ env, at: cronNextOf(tr.cron) })) : [])
    .filter((x) => x.at).sort((a, b) => a.at!.localeCompare(b.at!));
  return {
    ...t,
    stats_24h: { runs: day.length, success: day.filter((r) => r.status === "success").length, failed: day.filter((r) => r.status === "failed").length, p50_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null },
    last_run: rs[0] ? { run_id: rs[0].run_id, status: rs[0].status, created_at: rs[0].created_at } : null,
    next_fire: t.enabled && fires[0] ? { env: fires[0].env, at: fires[0].at! } : null,
    subtask_count: db.tasks.filter((x) => x.extends === t.name).length,
  };
}

on("GET", "/v1/tasks", (_p, q) => db.tasks.filter((t) => !q.service || t.service === q.service || (q.service !== "*" && t.service === "*")).map(taskSummary));
on("GET", "/v1/tasks/:name", (p) => {
  const t = db.tasks.find((x) => x.name === p.name);
  if (!t) throw notFound("任务 " + p.name);
  return taskSummary(t);
});
on("PUT", "/v1/tasks/:name", (p, _q, body) => {
  const t = db.tasks.find((x) => x.name === p.name);
  if (!t) throw notFound("任务 " + p.name);
  return taskSummary(bump("tasks", t, body));
});
on("POST", "/v1/tasks", (_p, _q, body) => {
  if (db.tasks.some((t) => t.name === body.name)) throw new ApiError(409, "conflict", `任务 ${body.name} 已存在`);
  const t = { title: "", description: "", service: null, role: null, form: "agent", input: {}, envs: [], triggers: [{ id: "api", type: "api" }], output: { channel: "caller" }, dedup: null, timeout_s: 300, enabled: true, context: {}, extends: null, auto_created: false, ...body, version: 1, updated_by: "you", updated_at: new Date().toISOString() };
  db.tasks.push(t);
  return taskSummary(t);
});

// ———————— 运行 ————————

const listItem = (r: db.MockRun): RunListItem => {
  const { _events, input: _i, output: _o, context: _c, feedback: _f, task_version: _tv, role_version: _rv, error_code: _e, pending_approval: _pa, langfuse_url: _l, ...rest } = r;
  void _events; void _i; void _o; void _c; void _f; void _tv; void _rv; void _e; void _pa; void _l;
  return rest;
};

on("GET", "/v1/runs", (_p, q) => {
  let rs = db.runs.filter((r) =>
    (!q.status || r.status === q.status) && (!q.env || r.env === q.env) && (!q.service || r.service === q.service)
    && (!q.task || r.task === q.task || r.task.startsWith(q.task + ":")) && (!q.trigger || r.trigger.type === q.trigger)
    && (!q.session || r.session_id === q.session) && (!q.hours || within(r.created_at, Number(q.hours)))
    && (!q.q || r.run_id.startsWith(String(q.q)) || r.summary.includes(String(q.q))));
  const total = rs.length;
  const limit = Number(q.limit || 30);
  const offset = Number(q.cursor || 0);
  rs = rs.slice(offset, offset + limit);
  const page: Page<RunListItem> = { items: rs.map(listItem), total, next_cursor: offset + limit < total ? String(offset + limit) : null, prev_cursor: offset > 0 ? String(Math.max(0, offset - limit)) : null };
  return page;
});
on("GET", "/v1/runs/:id", (p) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  if (!r) throw notFound("运行 " + p.id);
  return db.detailOf(r);
});
on("GET", "/v1/runs/:id/events", (p) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  if (!r) throw notFound("运行 " + p.id);
  return db.eventsOf(r);
});
on("POST", "/v1/runs", (_p, _q, body) => submitRun(body));
on("POST", "/v1/runs/:id/cancel", (p) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  if (!r) throw notFound("运行 " + p.id);
  if (["success", "failed", "cancelled"].includes(r.status)) throw new ApiError(409, "already_finished", `运行已结束（${r.status}）`);
  Object.assign(r, { status: "cancelled", finished_at: new Date().toISOString(), _events: undefined });
  return db.detailOf(r);
});
on("POST", "/v1/runs/:id/rerun", (p) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  if (!r) throw notFound("运行 " + p.id);
  return submitRun({ task: r.task, service: r.service, env: r.env, input: r.input }, "rerun");
});
on("POST", "/v1/runs/:id/feedback", (p, _q, body) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  if (!r) throw notFound("运行 " + p.id);
  r.feedback = { score: body.score, comment: body.comment ?? "", at: new Date().toISOString() };
  return { ok: true };
});
on("POST", "/v1/runs/:id/steps/:seq/feedback", (p, _q, body) => {
  const r = db.runs.find((x) => x.run_id === p.id);
  const ev = r && db.eventsOf(r).find((e) => e.seq === Number(p.seq));
  if (!ev) throw notFound("步骤");
  ev.feedback = body.score;
  return { ok: true };
});

function submitRun(body: { task: string; service?: string | null; env?: string | null; subtask?: string | null; input: Record<string, unknown> }, trigger = "web"): RunAccepted {
  const base = body.task.split(":")[0];
  const t = db.tasks.find((x) => x.name === base);
  if (!t) throw new ApiError(400, "unknown_task", `未知任务：${body.task}`);
  if (!t.enabled) throw new ApiError(400, "task_disabled", `任务 ${t.name} 已停用`);
  const env = body.env || "test";
  if (t.envs.length && !t.envs.includes(env)) throw new ApiError(400, "env_not_allowed", `任务 ${t.name} 不能在 ${env} 运行（允许：${t.envs.join("、")}）`);
  const service = t.service === "*" ? body.service : t.service;
  if (t.service === "*" && !service) throw new ApiError(400, "service_required", "通用任务需要指定服务");
  const svc = db.services.find((s) => s.name === service);
  if (svc && !svc.enabled) throw new ApiError(400, "service_disabled", `服务 ${service} 已停用`);
  const name = body.subtask ? `${base}:${body.subtask}` : body.task;
  let created: string | null = null;
  if (name !== base && !db.tasks.some((x) => x.name === name)) {
    db.tasks.push({ ...t, name, title: "", description: "", input: {}, triggers: [], envs: [], context: {}, extends: base, auto_created: true, version: 1, updated_by: "auto:web", updated_at: new Date().toISOString() });
    created = name;
  }
  const text = JSON.stringify(body.input);
  const policy = db.policies.filter((x) => x.enabled && (!x.applies_to.envs.length || x.applies_to.envs.includes(env))).find((x) => new RegExp(x.match_regex, "i").test(text));
  if (policy?.action === "deny") throw new ApiError(400, "policy", policy.message || `命中策略 ${policy.name}`);
  const run_id = db.hex(12);
  const status = policy?.action === "require_approval" ? "awaiting_approval" : "running";
  const run: db.MockRun = {
    run_id, session_id: run_id, task: name, task_title: t.title, service: service ?? null, env, role: t.role, status, resolution: null,
    trigger: { type: trigger as "web", id: null, source: null, caller: "you" },
    summary: String(body.input.question ?? Object.values(body.input)[0] ?? t.title), tokens: null, duration_ms: null,
    created_at: new Date().toISOString(), finished_at: null, task_version: t.version, role_version: db.roles.find((r) => r.name === t.role)?.version ?? null,
    input: body.input, output: null, error_code: null, pending_approval: null,
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [], graph: null },
    feedback: null, langfuse_url: null,
  };
  db.runs.unshift(run);
  let approval_id: number | null = null;
  if (status === "awaiting_approval") {
    approval_id = Date.now() % 100000;
    db.approvals.unshift({ id: approval_id, kind: "submit", run_id, title: `提交审批 · 策略 ${policy!.name}`, detail: policy!.message, service: service ?? null, env, task: name, requested_by: "you", status: "pending", decided_by: null, comment: null, created_at: run.created_at, decided_at: null, expires_at: null });
  } else {
    // 模拟执行：几秒后成功
    setTimeout(() => {
      Object.assign(run, { status: "success", resolution: "agent", duration_ms: 6400, tokens: 8120, finished_at: new Date().toISOString(), _events: undefined });
    }, 6500);
  }
  return { run_id, session_id: run_id, status, dedup_hit: false, subtask_created: created, approval_id };
}

// ———————— 审批 ————————

on("GET", "/v1/approvals", (_p, q) => db.approvals.filter((a) => (q.status === "pending" ? a.status === "pending" : q.status === "decided" ? a.status !== "pending" : true))
  .sort((a, b) => (a.status === "pending" && b.status === "pending" ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))));
on("POST", "/v1/approvals/:id/decision", (p, _q, body) => {
  const a = db.approvals.find((x) => x.id === Number(p.id));
  if (!a) throw notFound("审批单");
  if (a.status !== "pending") throw new ApiError(409, "already_decided", `已被 ${a.decided_by} 处理`);
  Object.assign(a, { status: body.approve ? "approved" : "rejected", decided_by: "you", comment: body.comment || null, decided_at: new Date().toISOString() });
  const run = a.run_id ? db.runs.find((r) => r.run_id === a.run_id) : null;
  if (run && run.status === "awaiting_approval") Object.assign(run, { status: body.approve ? "running" : "failed", _events: undefined });
  return a;
});

// ———————— 对话 ————————

const sessions = db.sessionsList();
on("GET", "/v1/sessions", () => sessions.map(({ turns: _t, ...s }) => { void _t; return s; }));
on("GET", "/v1/sessions/:id", (p) => {
  const s = sessions.find((x) => x.session_id === p.id);
  if (!s) throw notFound("会话");
  return s;
});

// ———————— 记忆 ————————

on("GET", "/v1/knowledge", (_p, q) => db.knowledge.filter((k) =>
  (!q.service || k.service === q.service) && (!q.env || k.env === q.env) && (!q.status || k.status === q.status)
  && (!q.q || k.key.includes(String(q.q)) || k.content.includes(String(q.q))) && (q.status || !k.key.startsWith("session:"))));
on("GET", "/v1/knowledge/health", (_p, q) => {
  const ks = db.knowledge.filter((k) => (!q.service || k.service === q.service) && (!q.env || k.env === q.env));
  return { active: ks.filter((k) => k.status === "active").length, zero_recall: ks.filter((k) => k.status === "active" && k.hits_30d === 0).length, negative: ks.filter((k) => k.feedback_score < 0).length, drifted: ks.filter((k) => k.status === "expired").length, conflicts: 1 };
});
on("GET", "/v1/knowledge/:id/history", (p) => {
  const k = db.knowledge.find((x) => x.id === Number(p.id));
  if (!k) throw notFound("知识条目");
  return [{ version: 2, content: k.content.replace(/；.*$/, "。"), source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 5 * 24 * H).toISOString() }, { version: 1, content: k.content.slice(0, 18) + "…", source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 12 * 24 * H).toISOString() }];
});
on("PUT", "/v1/knowledge/:id", (p, _q, body) => {
  const k = db.knowledge.find((x) => x.id === Number(p.id));
  if (!k) throw notFound("知识条目");
  return Object.assign(k, body, { updated_at: new Date().toISOString() });
});
on("POST", "/v1/knowledge/search", (_p, _q, body) => {
  const words = String(body.query || "").split(/\s+/).filter(Boolean);
  const hits = db.knowledge.filter((k) => k.status === "active" && (!body.service || k.service === body.service) && words.some((w) => (k.key + k.content).includes(w))).slice(0, 5);
  return { hits: hits.map((k, i) => ({ ...k, rank: i + 1 })), block: hits.length ? "[历史知识]\n" + hits.map((k) => `- ${k.key}: ${k.content}`).join("\n") : "" };
});
on("GET", "/v1/cases", (_p, q) => db.cases.filter((c) => (!q.service || c.service === q.service) && (!q.env || c.env === q.env)));
on("GET", "/v1/assets", (_p, q) => db.assetList.filter((a) => (!q.service || a.service === q.service) && (!q.env || a.env === q.env) && (!q.kind || a.kind === q.kind)));

// ———————— 统计 / 搜索 ————————

on("GET", "/v1/stats", (_p, q) => {
  const hours = Number(q.hours || 24);
  const rs = db.runs.filter((r) => within(r.created_at, hours) && (!q.env || r.env === q.env) && (!q.service || r.service === q.service));
  const buckets = hours <= 24 ? 24 : 36;
  const step = (hours * H) / buckets;
  const start = Date.now() - hours * H;
  const series = Array.from({ length: buckets }, (_, i) => ({ t: new Date(start + i * step).toISOString(), success: 0, failed: 0, other: 0 }));
  for (const r of rs) {
    const i = Math.min(buckets - 1, Math.floor((new Date(r.created_at).getTime() - start) / step));
    if (i < 0) continue;
    if (r.status === "success") series[i].success++;
    else if (r.status === "failed") series[i].failed++;
    else series[i].other++;
  }
  const byEnv: Stats["by_env"] = {};
  for (const e of db.envs) {
    const x = rs.filter((r) => r.env === e.name);
    byEnv[e.name] = { runs: x.length, success: x.filter((r) => r.status === "success").length, failed: x.filter((r) => r.status === "failed").length };
  }
  const failMap = new Map<string, { task: string; service: string | null; failed: number; last_error: string }>();
  for (const r of rs.filter((x) => x.status === "failed")) {
    const k = r.task.split(":")[0] + "|" + r.service;
    const cur = failMap.get(k) ?? { task: r.task.split(":")[0], service: r.service, failed: 0, last_error: "" };
    cur.failed++;
    if (!cur.last_error) cur.last_error = String(db.detailOf(r).output?.error ?? "");
    failMap.set(k, cur);
  }
  const upcoming = db.tasks.filter((t) => t.enabled).flatMap((t) => t.triggers.flatMap((tr) => tr.type === "schedule" ? tr.envs.filter((e) => !q.env || e === q.env).map((env) => ({ task: t.name, service: t.service, env, at: cronNextOf(tr.cron)! })) : []))
    .filter((x) => x.at).sort((a, b) => a.at.localeCompare(b.at)).slice(0, 6);
  const stats: Stats = {
    hours,
    totals: { runs: rs.length, success: rs.filter((r) => r.status === "success").length, failed: rs.filter((r) => r.status === "failed").length, running: db.runs.filter((r) => r.status === "running").length, awaiting: db.approvals.filter((a) => a.status === "pending").length },
    by_env: byEnv, series, top_failures: [...failMap.values()].sort((a, b) => b.failed - a.failed).slice(0, 5), upcoming,
    tokens: rs.reduce((n, r) => n + (r.tokens ?? 0), 0),
  };
  return stats;
});

on("GET", "/v1/search", (_p, q) => {
  const term = String(q.q || "").toLowerCase();
  if (!term) return [];
  const hits: SearchHit[] = [];
  for (const s of db.services) if ((s.name + s.title).toLowerCase().includes(term)) hits.push({ type: "service", id: s.name, title: s.title, subtitle: s.name, href: `/services/${s.name}` });
  for (const t of db.tasks) if ((t.name + t.title).toLowerCase().includes(term)) hits.push({ type: "task", id: t.name, title: t.title || t.name, subtitle: t.name, href: `/tasks/${encodeURIComponent(t.name)}` });
  for (const r of db.roles) if ((r.name + r.title).toLowerCase().includes(term)) hits.push({ type: "role", id: r.name, title: r.title, subtitle: r.name, href: `/settings/roles/${r.name}` });
  for (const r of db.runs) if (r.run_id.startsWith(term) || r.summary.toLowerCase().includes(term)) hits.push({ type: "run", id: r.run_id, title: r.summary, subtitle: `${r.task} · ${r.env} · ${r.run_id.slice(0, 8)}`, href: `/runs/${r.run_id}` });
  for (const k of db.knowledge) if ((k.key + k.content).toLowerCase().includes(term)) hits.push({ type: "knowledge", id: String(k.id), title: k.key, subtitle: k.content.slice(0, 40), href: `/memory?tab=knowledge&id=${k.id}` });
  return hits.slice(0, 20);
});

// ———————— 流式：对话 ————————

export function handleStream(path: string, body: any, onEvent: (ev: Record<string, unknown>) => void, onDone: (err?: Error) => void): () => void {
  if (path !== "/v1/chat") { setTimeout(() => onDone(new ApiError(404, "not_found", path)), 50); return () => {}; }
  const run_id = db.hex(12);
  const session_id = body.session_id || db.hex(12);
  const q = String(body.message || "");
  const steps: Record<string, unknown>[] = [
    { type: "run", run_id, session_id },
    { type: "stage", stage: "recall", title: "召回记忆", content: "知识 2 条 · 案例 0 条" },
    { type: "thought", content: `理解问题：「${q.slice(0, 40)}」。先确认口径，档案约定 GMV 不含退款、金额单位是分。` },
    { type: "tool_call", tool: "sql_query", args: { sql: "SELECT dt, sum(total_fee)/100.0 AS gmv FROM ads_order_daily\nWHERE dt >= current_date - 7 GROUP BY dt ORDER BY dt" } },
    { type: "tool_result", tool: "sql_query", output: "| dt | gmv |\n|---|---|\n| 10-13 | 42,180.50 |\n| … | … |\n(7 行)", duration_ms: 640 },
  ];
  const answer = `近 7 天 GMV 合计 **30.6 万元**，日均 4.37 万，较前 7 天 **+3.2%**。\n\n| 日期 | GMV（元） |\n|---|---|\n| 10-13 | 42,180.50 |\n| 10-14 | 44,902.00 |\n| 10-15 | 43,377.20 |\n| 10-16 | 41,068.90 |\n| 10-17 | 45,511.30 |\n| 10-18 | 47,203.60 |\n| 10-19 | 42,355.10 |\n\n口径：支付成功订单 total_fee 之和，不含退款与测试店铺。`;
  const timers: number[] = [];
  let t = 0;
  steps.forEach((s) => { t += 500 + Math.random() * 600; timers.push(window.setTimeout(() => onEvent(s), t)); });
  const chunks = answer.match(/[\s\S]{1,12}/g) ?? [];
  chunks.forEach((c) => { t += 35; timers.push(window.setTimeout(() => onEvent({ type: "delta", content: c }), t)); });
  t += 200;
  timers.push(window.setTimeout(() => {
    onEvent({ type: "final", status: "success", output: { answer } });
    onDone();
  }, t));
  return () => timers.forEach(clearTimeout);
}
