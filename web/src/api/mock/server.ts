/**
 * mock 服务：按 /v1 契约响应，数据在内存里可增删改（刷新页面即复原）。
 * 只服务预览与前端开发；行为与真实后端保持一致（同样的路径、过滤、错误码）。
 */
import { ApiError } from "../client";
import type {
  FeedbackEntry, FeedbackReason,
  ApiKey, Approval, Asset, ConfigSection, Instance, Knowledge, Page, RunAccepted, RunListItem, SearchHit,
  ServiceSummary, Stats, Task, TaskSummary, UpcomingFire, Version,
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
const ME = { name: "lihf", kind: "user" as const, admin: true, services: [], envs: [] };
const now = () => new Date().toISOString();

// ———————— 版本历史（mock：按当前定义回推几版） ————————

const history = new Map<string, Version[]>();
function versionsOf(key: string, current: Record<string, unknown>): Version[] {
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
        if (typeof def.timeout_s === "number") def.timeout_s = 300;
      }
      delete def.version; delete def.updated_by; delete def.updated_at;
      list.push({ version: i, updated_by: i === 1 ? "seed" : i === v ? String(current.updated_by ?? "lihf") : db.pick(["lihf", "wangzh", "chenyu"]), created_at: new Date(Date.now() - (v - i + 1) * 31 * H).toISOString(), definition: def });
    }
    history.set(key, list);
  }
  return history.get(key)!;
}

type Ledgered = { version: number; updated_by: string; updated_at: string };
function bump<T extends Ledgered>(key: string, target: T, patch: Partial<T>): T {
  const list = versionsOf(key, target as unknown as Record<string, unknown>);
  Object.assign(target, patch, { version: target.version + 1, updated_by: ME.name, updated_at: now() });
  const def = structuredClone(target) as unknown as Record<string, unknown>;
  delete def.version; delete def.updated_by; delete def.updated_at;
  list.unshift({ version: target.version, updated_by: ME.name, created_at: target.updated_at, definition: def });
  return target;
}

// ———————— 元信息 ————————

on("GET", "/v1/meta", () => ({
  version: "6.0.0", envs: db.envs, default_env: db.settings.envs.default, me: ME,
  channels: Object.keys(db.settings.notifications.channels),
  feedback_reasons: REASONS,
  features: { process_control: "systemd", vector_search: true },
  tools: [
    { name: "bash", title: "Shell", description: "bwrap 沙箱：全盘只读、工作目录可写、默认断网", group: "core", dangerous: true },
    { name: "run_code", title: "代码编排", description: "CodeAct：一段 Python 编排多个工具调用", group: "core", dangerous: true },
    { name: "service_info", title: "服务信息", description: "本运行服务×环境的目录、配置文件内容、git 状态", group: "service", dangerous: false },
    { name: "service_ctl", title: "进程启停", description: "启停本服务本环境的进程（受保护环境需审批）", group: "service", dangerous: true },
    { name: "sql_query", title: "只读 SQL", description: "本服务本环境的只读库，自动限时限量", group: "service", dangerous: false },
    { name: "host_metrics", title: "主机指标", description: "部署主机内存/负载/根盘（Grafana）", group: "service", dangerous: false },
    { name: "save_asset", title: "沉淀方法", description: "把可复用的方法/脚本/查询/基线存入记忆", group: "memory", dangerous: false },
    { name: "read_artifact", title: "读产物", description: "读取任务图上游节点的完整产物", group: "memory", dangerous: false },
    { name: "notify", title: "发通知", description: "发 markdown 通知到任务的通知渠道", group: "notify", dangerous: false },
    { name: "browser_navigate", title: "浏览器 · 打开", description: "MCP：@playwright/mcp", group: "mcp", dangerous: false },
    { name: "browser_snapshot", title: "浏览器 · 快照", description: "MCP：@playwright/mcp", group: "mcp", dangerous: false },
  ],
  event_sources: [
    { name: "dagster", title: "Dagster", notes: "在 Dagster 里配 run_failure_sensor 回调 POST /v1/events/dagster", events: [{ name: "run_failure", title: "运行失败", fields: ["run_id", "asset_key", "error", "env", "subtask", "job"] }] },
    { name: "gitlab", title: "GitLab", notes: "项目 Webhook 勾选 Deployment events", events: [{ name: "deployment", title: "部署成功", fields: ["project", "ref", "env", "sha", "url", "user"] }] },
    { name: "webhook", title: "通用 Webhook", notes: "事件名放请求头 X-Event 或请求体 event", events: [{ name: "*", title: "任意事件", fields: [] }] },
  ],
}));

// ———————— 服务 ————————

const envEnabled = (s: (typeof db.services)[number], env: string) => s.enabled && s.envs[env]?.enabled !== false;

function serviceSummary(s: (typeof db.services)[number]): ServiceSummary {
  const health: ServiceSummary["health"] = {};
  for (const e of db.envs) {
    const rs = db.runs.filter((r) => r.service === s.name && r.env === e.name);
    const procs = db.instances.filter((i) => i.service === s.name && i.env === e.name);
    const last = rs[0];
    health[e.name] = {
      enabled: envEnabled(s, e.name),
      runs_24h: rs.filter((r) => within(r.created_at, 24)).length,
      failed_24h: rs.filter((r) => within(r.created_at, 24) && r.status === "failed").length,
      last_run: last ? { run_id: last.run_id, status: last.status, created_at: last.created_at } : null,
      running_processes: procs.filter((i) => i.state === "running").length,
      total_processes: Object.keys(s.processes).length,
    };
  }
  return { ...s, task_count: db.tasks.filter((t) => t.service === s.name && !t.extends).length, health };
}

const findService = (name: string) => db.services.find((x) => x.name === name) ?? (() => { throw notFound("服务 " + name); })();

on("GET", "/v1/services", () => db.services.map(serviceSummary));
on("GET", "/v1/services/:name", (p) => serviceSummary(findService(p.name)));
on("PATCH", "/v1/services/:name", (p, _q, body) => serviceSummary(bump("services/" + p.name, findService(p.name), body)));
on("POST", "/v1/services", (_p, _q, body) => {
  if (db.services.some((s) => s.name === body.name)) throw new ApiError(409, "conflict", `服务 ${body.name} 已存在`);
  const s = { title: "", description: "", root: "", code_paths: [], hosts: [], readonly_dsn: null, configs: [], processes: {}, envs: {}, profile: {}, enabled: true, ...body, version: 1, updated_by: ME.name, updated_at: now() };
  db.services.push(s);
  return serviceSummary(s);
});
on("DELETE", "/v1/services/:name", (p) => {
  const users = db.tasks.filter((t) => t.service === p.name).map((t) => "任务 " + t.name);
  if (users.length) throw new ApiError(409, "in_use", `服务 ${p.name} 正被使用：${users.join("、")}`);
  db.services.splice(db.services.indexOf(findService(p.name)), 1);
  return { deleted: [p.name] };
});
on("GET", "/v1/services/:name/envs/:env", (p) => {
  const s = findService(p.name);
  const o = s.envs[p.env] ?? {};
  return {
    service: s.name, env: p.env, root: s.root, code_paths: o.code_paths ?? s.code_paths, hosts: o.hosts ?? s.hosts,
    readonly_dsn: (o.readonly_dsn ?? s.readonly_dsn)?.replace(/:\/\/([^:@]+)(:[^@]*)?@/, "://$1:***@") ?? null,
    config_files: s.configs.map((c) => ({ canonical: c.canonical, path: c.template.replace("{env}", p.env), exists: !(s.name === "report-engine" && p.env === "dev"), size: 1200 + c.template.length * 37 })),
    profile: { ...s.profile, ...(o.profile ?? {}) },
    git: s.name === "report-engine" ? null : { branch: p.env === "prod" ? "release/2026.10" : "main", commit: db.hex(7), dirty: p.env === "dev", committed_at: new Date(Date.now() - 20 * H).toISOString() },
  };
});
on("GET", "/v1/services/:name/envs/:env/config", (p, q) => {
  findService(p.name);
  const env = p.env;
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
on("GET", "/v1/services/:name/processes", (p) => db.instances.filter((i) => i.service === p.name));
for (const action of ["start", "stop", "renew"]) {
  on("POST", `/v1/services/:name/envs/:env/processes/:proc/${action}`, (p, _q, body) => {
    const inst = db.instances.find((i) => i.service === p.name && i.env === p.env && i.process === p.proc);
    if (!inst) throw notFound("进程");
    const svc = findService(p.name);
    if (action === "start" && !envEnabled(svc, p.env)) throw new ApiError(400, "service_env_disabled", `服务 ${p.name} 在 ${p.env} 环境已停用`);
    const env = db.envs.find((e) => e.name === p.env);
    if (env?.protected && action !== "renew") {
      const a: Approval = { id: Date.now() % 100000, kind: "process", run_id: null, title: `进程${action === "start" ? "启动" : "停止"} · ${p.name}/${p.proc}@${p.env}`, detail: `${ME.name} 请求在受保护环境 ${p.env} ${action === "start" ? "启动" : "停止"} ${p.name}/${p.proc}`, service: p.name, env: p.env, task: null, payload: { service: p.name, env: p.env, process: p.proc, action, executor: "api" }, requested_by: ME.name, status: "pending", decided_by: null, comment: null, created_at: now(), decided_at: null, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
      db.approvals.unshift(a);
      return { instance: inst, approval: a };
    }
    perform(inst, action, body?.hours);
    return { instance: inst, approval: null };
  });
}
function perform(inst: Instance, action: string, hours?: number) {
  const t = now();
  const lease = (hours ?? 2) * H;
  if (action === "start") Object.assign(inst, { state: "running", pid: db.between(2000, 39999), started_at: t, started_by: ME.name, lease_until: new Date(Date.now() + lease).toISOString() } satisfies Partial<Instance>);
  if (action === "stop") Object.assign(inst, { state: "stopped", pid: null, started_at: null, lease_until: null, last_exit: { code: 0, at: t } } satisfies Partial<Instance>);
  if (action === "renew") inst.lease_until = new Date(new Date(inst.lease_until ?? t).getTime() + lease).toISOString();
}
on("GET", "/v1/services/:name/envs/:env/processes/:proc/logs", (p) => ({
  lines: Array.from({ length: 60 }, (_, i) => {
    const t = new Date(Date.now() - (60 - i) * 17_000).toISOString().slice(11, 19);
    return `${t} ${["INFO", "INFO", "INFO", "WARN", "INFO", "DEBUG"][i % 6]} [${p.proc}@${p.env}] ${["request GET /api/metrics/gmv 200 38ms", "cache hit gmv:2026-10-19", "scheduler tick: 3 runs queued", "slow query 1.8s: SELECT … FROM ads_order_daily", "request GET /health 200 2ms", "pool: 4/20 connections in use"][i % 6]}`;
  }),
}));

// ———————— 角色 / 策略 ————————

const findRole = (name: string) => db.roles.find((r) => r.name === name) ?? (() => { throw notFound("角色 " + name); })();
on("GET", "/v1/roles", () => db.roles);
on("GET", "/v1/roles/:name", (p) => findRole(p.name));
on("PATCH", "/v1/roles/:name", (p, _q, body) => bump("roles/" + p.name, findRole(p.name), body));
on("POST", "/v1/roles", (_p, _q, body) => {
  if (db.roles.some((r) => r.name === body.name)) throw new ApiError(409, "conflict", `角色 ${body.name} 已存在`);
  const r = { title: "", description: "", prompt: "", tools: [], extends: null, prompt_append: "", ...body, version: 1, updated_by: ME.name, updated_at: now() };
  db.roles.push(r);
  return r;
});
on("DELETE", "/v1/roles/:name", (p) => {
  const users = [...db.tasks.filter((t) => t.role === p.name).map((t) => "任务 " + t.name), ...db.roles.filter((r) => r.extends === p.name).map((r) => "角色 " + r.name)];
  if (users.length) throw new ApiError(409, "in_use", `角色 ${p.name} 正被使用：${users.join("、")}`);
  db.roles.splice(db.roles.indexOf(findRole(p.name)), 1);
  return { deleted: [p.name] };
});
on("GET", "/v1/roles/:name/resolved", (p) => {
  const chain: (typeof db.roles)[number][] = [];
  let r: (typeof db.roles)[number] | undefined = findRole(p.name);
  while (r) { chain.unshift(r); r = r.extends ? db.roles.find((x) => x.name === r!.extends) : undefined; }
  const tools = chain.slice(1).reduce((acc, c) => (c.tools.length ? acc.filter((t) => c.tools.includes(t)) : acc), chain[0]?.tools ?? []);
  const last = chain[chain.length - 1];
  return { name: p.name, title: last.title, description: last.description, prompt: [chain[0]?.prompt, ...chain.slice(1).map((c) => c.prompt_append)].filter(Boolean).join("\n\n"), tools, lineage: chain.map((c) => c.name) };
});
const findPolicy = (name: string) => db.policies.find((x) => x.name === name) ?? (() => { throw notFound("策略 " + name); })();
on("GET", "/v1/policies", () => [...db.policies].sort((a, b) => a.order - b.order));
on("PATCH", "/v1/policies/:name", (p, _q, body) => bump("policies/" + p.name, findPolicy(p.name), body));
on("POST", "/v1/policies", (_p, _q, body) => {
  const x = { description: "", order: 100, applies_to: { tasks: [], services: [], envs: [] }, match_regex: ".*", action: "deny", message: "", enabled: true, ...body, version: 1, updated_by: ME.name, updated_at: now() };
  db.policies.push(x);
  return x;
});
on("DELETE", "/v1/policies/:name", (p) => { db.policies.splice(db.policies.indexOf(findPolicy(p.name)), 1); return { deleted: [p.name] }; });

// ———————— 任务 ————————

const OWN_KEYS = ["title", "description", "input", "envs", "triggers", "profile", "enabled", "deliver", "timeout_s", "memory"] as const;

/** 子任务自己写了哪些字段（mock：非空即覆盖） */
function ownFields(t: Task): (typeof OWN_KEYS)[number][] {
  if (!t.extends) return [];
  return OWN_KEYS.filter((k) => {
    const v = t[k] as unknown;
    if (k === "enabled") return v === false;
    if (k === "deliver" || k === "timeout_s") return false;
    return Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : !!v;
  });
}

function effective(t: Task): Task {
  if (!t.extends) return t;
  const parent = db.tasks.find((x) => x.name === t.extends);
  if (!parent) return t;
  const own = ownFields(t);
  const out = { ...parent, name: t.name, extends: t.extends, auto_created: t.auto_created, version: t.version, updated_by: t.updated_by, updated_at: t.updated_at } as Task;
  for (const k of own) (out as unknown as Record<string, unknown>)[k] = t[k];
  out.profile = { ...parent.profile, ...t.profile };
  out.input = { ...parent.input, ...t.input };
  return out;
}

const firesOf = (t: Task) => t.triggers.flatMap((tr) => tr.type === "schedule" && tr.enabled !== false
  ? tr.envs.map((env): UpcomingFire => ({ task: t.name, trigger_id: tr.id, service: t.service === "*" ? tr.service ?? null : t.service, env, at: cronNextOf(tr.cron) ?? "" })) : [])
  .filter((x) => x.at).sort((a, b) => a.at.localeCompare(b.at));

function taskSummary(raw: Task): TaskSummary {
  const t = effective(raw);
  const rs = db.runs.filter((r) => r.task === t.name || (!t.extends && r.task.startsWith(t.name + ":")));
  const day = rs.filter((r) => within(r.created_at, 24));
  const durations = day.map((r) => r.duration_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const fires = raw.extends && !ownFields(raw).includes("triggers") ? [] : firesOf(t);
  return {
    ...t, overrides: ownFields(raw),
    stats_24h: { runs: day.length, success: day.filter((r) => r.status === "success").length, failed: day.filter((r) => r.status === "failed").length, p50_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null },
    last_run: rs[0] ? { run_id: rs[0].run_id, status: rs[0].status, created_at: rs[0].created_at } : null,
    next_fire: t.enabled && fires[0] ? { env: fires[0].env, at: fires[0].at } : null,
    subtask_count: db.tasks.filter((x) => x.extends === t.name).length,
  };
}

const findTask = (name: string) => db.tasks.find((x) => x.name === name) ?? (() => { throw notFound("任务 " + name); })();
const blankTask = (body: Partial<Task>): Task => ({ title: "", description: "", service: null, role: null, form: "agent", input: {}, envs: [], triggers: [{ id: "api", type: "api" }], deliver: null, dedup: null, memory: {}, timeout_s: 300, enabled: true, profile: {}, extends: null, auto_created: false, graph: null, handler: null, ...body, version: 1, updated_by: ME.name, updated_at: now() } as Task);

on("GET", "/v1/tasks", (_p, q) => db.tasks.filter((t) => !q.service || t.service === q.service || t.service === "*").map(taskSummary));
on("GET", "/v1/tasks/:name", (p) => taskSummary(findTask(p.name)));
on("PATCH", "/v1/tasks/:name", (p, _q, body) => taskSummary(bump("tasks/" + p.name, findTask(p.name), body)));
on("POST", "/v1/tasks", (_p, _q, body) => {
  if (db.tasks.some((t) => t.name === body.name)) throw new ApiError(409, "conflict", `任务 ${body.name} 已存在`);
  const t = blankTask(body);
  db.tasks.push(t);
  return taskSummary(t);
});
on("DELETE", "/v1/tasks/:name", (p) => {
  const removed = [p.name, ...db.tasks.filter((t) => t.extends === p.name).map((t) => t.name)];
  for (const n of removed) db.tasks.splice(db.tasks.indexOf(findTask(n)), 1);
  return { deleted: removed };
});
on("GET", "/v1/tasks/:name/subtasks", (p) => db.tasks.filter((t) => t.extends === p.name).map(taskSummary));
on("POST", "/v1/tasks/:name/subtasks", (p, _q, body) => {
  const parent = findTask(p.name);
  if (parent.extends) throw new ApiError(400, "invalid_subtask", `${p.name} 本身是子任务，不能再派生`);
  const object = String(body.object || "").trim();
  if (!object || /[:\s/]/.test(object)) throw new ApiError(422, "invalid_definition", "对象名不能为空，且不能含冒号、空白或斜杠");
  const name = `${p.name}:${object}`;
  if (db.tasks.some((t) => t.name === name)) throw new ApiError(409, "conflict", `子任务 ${name} 已存在`);
  const { object: _o, ...overrides } = body;
  void _o;
  const t = blankTask({ ...overrides, name, extends: p.name, service: parent.service, role: parent.role, form: parent.form, triggers: [], deliver: parent.deliver, timeout_s: parent.timeout_s });
  db.tasks.push(t);
  return taskSummary(t);
});
on("GET", "/v1/tasks/:name/schedule", (p) => firesOf(effective(findTask(p.name))));

// ———————— 版本历史（四种定义 + 设置各节） ————————

for (const [kind, find] of [["services", findService], ["roles", findRole], ["tasks", findTask], ["policies", findPolicy]] as const) {
  on("GET", `/v1/${kind}/:name/versions`, (p) => versionsOf(`${kind}/${p.name}`, find(p.name) as unknown as Record<string, unknown>));
  on("POST", `/v1/${kind}/:name/versions/:v/restore`, (p) => {
    const item = find(p.name) as unknown as Ledgered;
    const old = versionsOf(`${kind}/${p.name}`, item as unknown as Record<string, unknown>).find((v) => v.version === Number(p.v));
    if (!old) throw notFound("版本 " + p.v);
    return bump(`${kind}/${p.name}`, item, old.definition as Partial<Ledgered>);
  });
}

// ———————— 运行 ————————

const listItem = (r: db.MockRun): RunListItem => {
  const { _events, input: _i, output: _o, context: _c, feedback: _f, task_version: _tv, role_version: _rv, error_code: _e, pending_approval: _pa, memory: _m, ...rest } = r;
  void _events; void _i; void _o; void _c; void _f; void _tv; void _rv; void _e; void _pa; void _m;
  return rest;
};
const findRun = (id: string) => db.runs.find((x) => x.run_id === id) ?? (() => { throw notFound("运行 " + id); })();

on("GET", "/v1/runs", (_p, q) => {
  let rs = db.runs.filter((r) =>
    (!q.status || r.status === q.status) && (!q.env || r.env === q.env) && (!q.service || r.service === q.service)
    && (!q.task || r.task === q.task || r.task.startsWith(q.task + ":")) && (!q.trigger || r.trigger.type === q.trigger)
    && (!q.caller || r.trigger.caller === q.caller)
    && (!q.session_id || r.session_id === q.session_id) && (!q.hours || within(r.created_at, Number(q.hours)))
    && (!q.q || r.run_id.startsWith(String(q.q)) || r.summary.includes(String(q.q))));
  const total = rs.length;
  const limit = Number(q.limit || 30);
  const offset = Number(q.cursor || 0);
  rs = rs.slice(offset, offset + limit);
  const page: Page<RunListItem> = { items: rs.map(listItem), total, next_cursor: offset + limit < total ? String(offset + limit) : null, prev_cursor: offset > 0 ? String(Math.max(0, offset - limit)) : null };
  return page;
});
on("GET", "/v1/runs/:id", (p) => db.detailOf(findRun(p.id)));
on("GET", "/v1/runs/:id/events", (p) => db.eventsOf(findRun(p.id)));
on("POST", "/v1/runs", (_p, _q, body) => submitRun(body, "web"));
on("POST", "/v1/runs/:id/cancel", (p) => {
  const r = findRun(p.id);
  if (["success", "failed", "cancelled"].includes(r.status)) throw new ApiError(409, "already_finished", `运行已结束（${r.status}）`);
  Object.assign(r, { status: "cancelled", finished_at: now(), _events: undefined });
  return db.detailOf(r);
});
on("POST", "/v1/runs/:id/rerun", (p) => {
  const r = findRun(p.id);
  const [task, subtask] = r.task.split(":");
  return submitRun({ task, subtask, service: r.service, env: r.env, input: r.input }, "rerun");
});
on("POST", "/v1/runs/:id/resume", (p) => {
  const r = findRun(p.id);
  if (r.status !== "failed") throw new ApiError(409, "conflict", `只有失败的运行能续跑（当前 ${r.status}）`);
  Object.assign(r, { status: "running", finished_at: null, _events: undefined });
  setTimeout(() => Object.assign(r, { status: "success", finished_at: now() }), 5000);
  return { run_id: r.run_id, session_id: r.session_id, status: "queued", output: null, dedup: false, subtask_created: null, approval_id: null };
});
on("POST", "/v1/runs/:id/correct", (p, _q, body) => {
  const r = findRun(p.id);
  const [task, subtask] = r.task.split(":");
  return submitRun({ task, subtask, service: r.service, env: r.env, input: { ...r.input, question: `[纠正] ${body.text}` }, session_id: r.session_id }, "correction");
});
// ———————— 反馈：一人一步一条，再提交即覆盖 ————————

const REASONS: { value: FeedbackReason; label: string }[] = [
  { value: "wrong_conclusion", label: "结论不对" }, { value: "wrong_definition", label: "口径 / 业务理解不对" },
  { value: "wrong_data", label: "取数或查询有误" }, { value: "incomplete", label: "没答全" }, { value: "off_topic", label: "答非所问" },
  { value: "wrong_tool", label: "工具或命令用错" }, { value: "detour", label: "绕远路 / 太慢" }, { value: "unsafe", label: "操作有风险" },
  { value: "other", label: "其他" },
];

function putFeedback(runId: string, step: number, body: { score: 1 | -1; reasons?: FeedbackReason[]; comment?: string }): FeedbackEntry {
  const r = findRun(runId);
  if (step && !db.eventsOf(r).some((e) => e.seq === step)) throw notFound(`第 ${step} 步`);
  const unknown = (body.reasons ?? []).filter((x) => !REASONS.some((y) => y.value === x));
  if (unknown.length) throw new ApiError(422, "invalid_request", `未知的问题类型：${unknown.join("、")}`);
  const old = r.feedback.find((f) => f.step_seq === step && f.created_by === ME.name);
  const entry: FeedbackEntry = {
    id: old?.id ?? Date.now(), run_id: runId, step_seq: step, score: body.score, reasons: body.reasons ?? [], comment: body.comment ?? "",
    created_by: ME.name, created_at: old?.created_at ?? now(), updated_at: now(),
  };
  r.feedback = [...r.feedback.filter((f) => f !== old), entry];
  return entry;
}
function removeFeedback(runId: string, step: number) {
  const r = findRun(runId);
  r.feedback = r.feedback.filter((f) => !(f.step_seq === step && f.created_by === ME.name));
  return null;
}
on("PUT", "/v1/runs/:id/feedback", (p, _q, body) => putFeedback(p.id, 0, body));
on("DELETE", "/v1/runs/:id/feedback", (p) => removeFeedback(p.id, 0));
on("PUT", "/v1/runs/:id/events/:seq/feedback", (p, _q, body) => putFeedback(p.id, Number(p.seq), body));
on("DELETE", "/v1/runs/:id/events/:seq/feedback", (p) => removeFeedback(p.id, Number(p.seq)));
on("GET", "/v1/feedback", (_p, q) => db.runs.flatMap((r) => r.feedback.map((f) => ({ ...f, task: r.task, service: r.service, env: r.env, summary: r.summary, run_status: r.status })))
  .filter((f) => (!q.score || f.score === Number(q.score)) && (!q.service || f.service === q.service) && (!q.env || f.env === q.env)
    && taskMatch(q.task, f.task) && (!q.reason || f.reasons.includes(q.reason as FeedbackReason)) && (!q.hours || within(f.updated_at, Number(q.hours))))
  .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Number(q.limit) || 100));

interface SubmitBody { task: string; service?: string | null; env?: string | null; subtask?: string | null; input?: Record<string, unknown>; session_id?: string | null; memory?: object }

function submitRun(body: SubmitBody, trigger: string): RunAccepted {
  const [base, inlineSub] = body.task.split(":");
  const t = db.tasks.find((x) => x.name === base);
  if (!t) throw new ApiError(404, "unknown_task", `任务 ${base} 不存在`);
  const input = body.input ?? {};
  const env = body.env || db.settings.envs.default;
  let service = t.service;
  if (t.service === "*") {
    if (!body.service) throw new ApiError(400, "service_required", `${base} 是通用任务，需要指定 service`);
    service = body.service;
  } else if (body.service && body.service !== t.service) {
    throw new ApiError(400, "service_not_allowed", `任务 ${base} 属于服务 ${t.service}，不能用于 ${body.service}`);
  }
  const svc = db.services.find((s) => s.name === service);
  if (svc && !svc.enabled) throw new ApiError(400, "service_disabled", `服务 ${service} 已停用`);
  if (svc && !envEnabled(svc, env)) throw new ApiError(400, "service_env_disabled", `服务 ${service} 在 ${env} 环境已停用`);
  if (!t.enabled) throw new ApiError(400, "task_disabled", `任务 ${t.name} 已停用`);
  if (t.envs.length && !t.envs.includes(env)) throw new ApiError(400, "env_not_allowed", `任务 ${t.name} 不能在 ${env} 运行（允许：${t.envs.join("、")}）`);
  const missing = Object.entries(t.input).filter(([k, f]) => f.required && (input[k] === undefined || input[k] === "")).map(([k]) => k);
  if (missing.length) throw new ApiError(400, "invalid_input", "输入不合法：" + missing.map((k) => `${k} 必填`).join("；"));
  const object = body.subtask || inlineSub;
  const name = object ? `${base}:${object}` : base;
  let created: string | null = null;
  if (object && !db.tasks.some((x) => x.name === name)) {
    db.tasks.push(blankTask({ name, extends: base, auto_created: true, service: t.service, role: t.role, form: t.form, triggers: [], deliver: t.deliver, updated_by: "auto:" + ME.name }));
    created = name;
  }
  const text = JSON.stringify(input);
  const policy = db.policies.filter((x) => x.enabled && (!x.applies_to.envs.length || x.applies_to.envs.includes(env))
    && (!x.applies_to.services.length || x.applies_to.services.includes(service ?? ""))
    && (!x.applies_to.tasks.length || x.applies_to.tasks.includes(base))).find((x) => new RegExp(x.match_regex, "i").test(text));
  if (policy?.action === "deny") throw new ApiError(400, "policy", policy.message || `命中提交策略 ${policy.name}`);
  const run_id = db.hex(12);
  const session_id = body.session_id || run_id;
  const status = policy?.action === "require_approval" ? "awaiting_approval" : "running";
  const run: db.MockRun = {
    run_id, session_id, task: name, task_title: t.title, service: service ?? null, env, role: t.role, status, resolution: null,
    trigger: { type: trigger as "web", id: null, source: null, caller: ME.name },
    summary: String(input.question ?? Object.values(input)[0] ?? t.title), tokens: null, duration_ms: null,
    created_at: now(), finished_at: null, task_version: t.version, role_version: db.roles.find((r) => r.name === t.role)?.version ?? null,
    input, output: null, error_code: null, pending_approval: null, memory: body.memory ?? {},
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [], graph: null },
    feedback: [],
  };
  db.runs.unshift(run);
  let approval_id: number | null = null;
  if (status === "awaiting_approval") {
    approval_id = Date.now() % 100000;
    db.approvals.unshift({ id: approval_id, kind: "submit", run_id, title: `提交审批 · ${name} · 策略 ${policy!.name}`, detail: policy!.message, service: service ?? null, env, task: name, payload: { policy: policy!.name }, requested_by: ME.name, status: "pending", decided_by: null, comment: null, created_at: run.created_at, decided_at: null, expires_at: null });
  } else {
    setTimeout(() => Object.assign(run, { status: "success", resolution: "agent", duration_ms: 6400, tokens: 8120, finished_at: now(), _events: undefined }), 6500);
  }
  return { run_id, session_id, status: status === "running" ? "queued" : status, output: null, dedup: false, subtask_created: created, approval_id };
}

// ———————— 审批 ————————

on("GET", "/v1/approvals", (_p, q) => db.approvals
  .filter((a) => (q.status === "pending" ? a.status === "pending" : q.status === "decided" ? a.status !== "pending" : true)
    && (!q.kind || a.kind === q.kind) && (!q.service || a.service === q.service) && (!q.env || a.env === q.env))
  .sort((a, b) => (a.status === "pending" && b.status === "pending" ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))));
on("GET", "/v1/approvals/:id", (p) => db.approvals.find((x) => x.id === Number(p.id)) ?? (() => { throw notFound("审批单"); })());
for (const verb of ["approve", "reject"]) {
  on("POST", `/v1/approvals/:id/${verb}`, (p, _q, body) => {
    const a = db.approvals.find((x) => x.id === Number(p.id));
    if (!a) throw notFound("审批单");
    if (a.status !== "pending") throw new ApiError(409, "already_decided", `已被 ${a.decided_by} 处理（${a.status}）`);
    const ok = verb === "approve";
    Object.assign(a, { status: ok ? "approved" : "rejected", decided_by: ME.name, comment: body?.comment || null, decided_at: now() });
    const run = a.run_id ? db.runs.find((r) => r.run_id === a.run_id) : null;
    if (run && run.status === "awaiting_approval") Object.assign(run, { status: ok ? "running" : a.kind === "submit" ? "cancelled" : "running", _events: undefined });
    if (a.kind === "process" && ok && a.payload.executor === "api") {
      const inst = db.instances.find((i) => i.service === a.service && i.env === a.env && i.process === a.payload.process);
      if (inst) perform(inst, String(a.payload.action));
    }
    return a;
  });
}

// ———————— 对话 ————————

const sessions = db.sessionsList();
on("GET", "/v1/sessions", (_p, q) => sessions
  .filter((s) => (!q.service || s.service === q.service) && (!q.env || s.env === q.env) && (!q.task || s.task.split(":")[0] === q.task)
    && (!q.q || s.title.includes(String(q.q)) || s.turns.some((t) => t.question.includes(String(q.q)))))
  .map(({ turns: _t, ...s }) => { void _t; return s; }));
on("GET", "/v1/sessions/:id", (p) => sessions.find((x) => x.session_id === p.id) ?? (() => { throw notFound("会话"); })());

// ———————— 记忆 ————————

const taskMatch = (wanted: unknown, task: string) => !wanted || task === wanted || task.startsWith(wanted + ":");

on("GET", "/v1/knowledge", (_p, q) => db.knowledge.filter((k) =>
  (!q.service || k.service === q.service) && (!q.env || k.env === q.env) && taskMatch(q.task, k.task)
  && (q.status === "all" || (q.status ? k.status === q.status : k.status === "active"))
  && (!q.q || k.key.includes(String(q.q)) || k.content.includes(String(q.q))) && !k.key.startsWith("session:")));
on("GET", "/v1/knowledge/health", (_p, q) => {
  const ks = db.knowledge.filter((k) => (!q.service || k.service === q.service) && (!q.env || k.env === q.env));
  return { active: ks.filter((k) => k.status === "active").length, zero_recall: ks.filter((k) => k.status === "active" && k.hits_30d === 0).length, negative: ks.filter((k) => k.feedback_score < 0).length, drifted: ks.filter((k) => k.status === "expired").length, conflicts: 1 };
});
const findKnowledge = (id: string) => db.knowledge.find((x) => x.id === Number(id)) ?? (() => { throw notFound("知识 " + id); })();
on("GET", "/v1/knowledge/:id", (p) => findKnowledge(p.id));
on("GET", "/v1/knowledge/:id/history", (p) => {
  const k = findKnowledge(p.id);
  return [{ version: 2, content: k.content.replace(/；.*$/, "。"), source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 5 * 24 * H).toISOString() }, { version: 1, content: k.content.slice(0, 18) + "…", source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 12 * 24 * H).toISOString() }];
});
on("POST", "/v1/knowledge", (_p, _q, body) => {
  if (db.knowledge.some((k) => k.service === body.service && k.env === body.env && k.key === body.key)) throw new ApiError(409, "conflict", `${body.service}@${body.env} 已有知识 ${body.key}，请直接编辑`);
  const k: Knowledge = { id: Math.max(...db.knowledge.map((x) => x.id)) + 1, service: body.service, env: body.env, task: body.task ?? "", key: body.key, content: body.content, source_run: null, code_ref: null, status: "active", feedback_score: 0, hits_30d: 0, last_hit_at: null, updated_at: now() };
  db.knowledge.unshift(k);
  return k;
});
on("PATCH", "/v1/knowledge/:id", (p, _q, body) => Object.assign(findKnowledge(p.id), body, { updated_at: now() }));
on("DELETE", "/v1/knowledge/:id", (p) => Object.assign(findKnowledge(p.id), { status: "expired", updated_at: now() }));
on("POST", "/v1/knowledge/search", (_p, _q, body) => {
  const words = String(body.query || "").split(/\s+/).filter(Boolean);
  const hits = db.knowledge.filter((k) => k.status === "active" && k.service === body.service && k.env === body.env && words.some((w) => (k.key + k.content).includes(w))).slice(0, 5);
  return { hits: hits.map((k, i) => ({ ...k, rank: i + 1 })), block: hits.length ? "[历史知识——过去运行沉淀，可能过时；与代码或数据矛盾时以实际为准]\n" + hits.map((k) => `- ${k.key}: ${k.content}`).join("\n") : "" };
});

const findAsset = (id: string) => db.assetList.find((x) => x.id === Number(id)) ?? (() => { throw notFound("方法 " + id); })();
on("GET", "/v1/assets", (_p, q) => db.assetList.filter((a) => (!q.service || a.service === q.service) && (!q.env || a.env === q.env)
  && (!q.kind || a.kind === q.kind) && taskMatch(q.task, a.task) && (!q.status || q.status === "all" || a.status === q.status)));
on("POST", "/v1/assets", (_p, _q, body) => {
  const a: Asset = { id: Math.max(...db.assetList.map((x) => x.id)) + 1, files: [], source_run: null, use_count: 0, last_used_at: null, feedback_score: 0, status: "active", updated_at: now(), task: "", ...body };
  db.assetList.unshift(a);
  return a;
});
on("PATCH", "/v1/assets/:id", (p, _q, body) => Object.assign(findAsset(p.id), body, { updated_at: now() }));
on("DELETE", "/v1/assets/:id", (p) => Object.assign(findAsset(p.id), { status: "superseded", updated_at: now() }));
on("GET", "/v1/cases", (_p, q) => db.cases.filter((c) => (!q.service || c.service === q.service) && (!q.env || c.env === q.env)));
on("DELETE", "/v1/cases/:id", (p) => {
  const c = db.cases.find((x) => x.id === Number(p.id));
  if (!c) throw notFound("案例");
  c.status = "superseded";
  return { ok: true };
});

// ———————— 设置 ————————

const SECTIONS: ConfigSection[] = ["envs", "approvals", "notifications", "memory", "processes"];
on("GET", "/v1/settings", () => db.settings);
for (const section of SECTIONS) {
  on("GET", `/v1/settings/${section}`, () => db.settings[section]);
  on("PUT", `/v1/settings/${section}`, (_p, _q, body) => {
    const target = db.settings[section] as unknown as Ledgered;
    const { section: _s, version: _v, updated_by: _u, updated_at: _a, ...rest } = body;
    void _s; void _v; void _u; void _a;
    if (section === "envs") {
      const names = (rest.items as { name: string }[]).map((e) => e.name);
      if (!names.includes(rest.default)) throw new ApiError(422, "invalid_definition", `默认环境 ${rest.default} 不在环境列表里`);
      db.envs.splice(0, db.envs.length, ...rest.items);
    }
    if (section === "notifications") {
      const missing = (rest.rules as { channel: string }[]).map((r) => r.channel).filter((c) => !(c in rest.channels));
      if (missing.length) throw new ApiError(422, "invalid_definition", `规则引用了不存在的渠道：${[...new Set(missing)].join("、")}`);
    }
    return bump(`settings/${section}`, target, rest);
  });
  on("GET", `/v1/settings/${section}/versions`, () => versionsOf(`settings/${section}`, db.settings[section] as unknown as Record<string, unknown>));
  on("POST", `/v1/settings/${section}/versions/:v/restore`, (p) => {
    const target = db.settings[section] as unknown as Ledgered;
    const old = versionsOf(`settings/${section}`, target as unknown as Record<string, unknown>).find((v) => v.version === Number(p.v));
    if (!old) throw notFound("版本 " + p.v);
    return bump(`settings/${section}`, target, old.definition as Partial<Ledgered>);
  });
}
on("POST", "/v1/settings/notifications/test", (_p, _q, body) => {
  if (!(body.channel in db.settings.notifications.channels)) throw new ApiError(400, "unknown_channel", `通知渠道 ${body.channel} 不存在`);
  return { ok: true };
});

on("GET", "/v1/api-keys", () => db.apiKeys);
on("POST", "/v1/api-keys", (_p, _q, body) => {
  if (db.apiKeys.some((k) => k.name === body.name)) throw new ApiError(409, "conflict", `已有名为 ${body.name} 的密钥`);
  const token = "ap_" + db.hex(43);
  const key: ApiKey = { id: Math.max(...db.apiKeys.map((k) => k.id)) + 1, prefix: token.slice(0, 9), created_by: ME.name, created_at: now(), last_used_at: null, revoked_at: null, services: [], envs: [], note: "", expires_at: null, scope: "run", ...body };
  db.apiKeys.unshift(key);
  return { ...key, token };
});
const findKey = (id: string) => db.apiKeys.find((k) => k.id === Number(id)) ?? (() => { throw notFound("密钥 " + id); })();
on("PATCH", "/v1/api-keys/:id", (p, _q, body) => Object.assign(findKey(p.id), body));
on("DELETE", "/v1/api-keys/:id", (p) => Object.assign(findKey(p.id), { revoked_at: findKey(p.id).revoked_at ?? now() }));

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
  const failMap = new Map<string, Stats["top_failures"][number]>();
  for (const r of rs.filter((x) => x.status === "failed")) {
    const k = r.task.split(":")[0] + "|" + r.service;
    const cur = failMap.get(k) ?? { task: r.task.split(":")[0], service: r.service, failed: 0, last_error: "" };
    cur.failed++;
    if (!cur.last_error) cur.last_error = String(db.detailOf(r).output?.error ?? "");
    failMap.set(k, cur);
  }
  const upcoming = db.tasks.filter((t) => t.enabled).flatMap((t) => firesOf(effective(t)))
    .filter((f) => (!q.env || f.env === q.env) && (!q.service || f.service === q.service)).sort((a, b) => a.at.localeCompare(b.at)).slice(0, 8);
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
  for (const k of db.knowledge) if ((k.key + k.content).toLowerCase().includes(term)) hits.push({ type: "knowledge", id: String(k.id), title: k.key, subtitle: `${k.service}@${k.env} · ${k.content.slice(0, 40)}`, href: `/memory?knowledge=${k.id}` });
  return hits.slice(0, 20);
});

// ———————— 流式：对话 ————————

export function handleStream(path: string, body: any, onEvent: (ev: Record<string, unknown>) => void, onDone: (err?: Error) => void): () => void {
  if (path !== "/v1/chat") { setTimeout(() => onDone(new ApiError(404, "not_found", path)), 50); return () => {}; }
  let accepted: RunAccepted;
  try {
    const task = body.task || "data-qa";
    accepted = submitRun({ task, subtask: body.subtask, service: body.service, env: body.env, input: { ...(body.input ?? {}), question: body.message }, session_id: body.session_id, memory: body.memory }, "chat");
  } catch (e) {
    const err = e as ApiError;
    setTimeout(() => { onEvent({ type: "error", code: err.code, message: err.message }); onDone(); }, 150);
    return () => {};
  }
  const q = String(body.message || "");
  const recall = body.memory?.recall !== false;
  const steps: Record<string, unknown>[] = [
    { type: "run", run_id: accepted.run_id, session_id: accepted.session_id, subtask_created: accepted.subtask_created },
    ...(recall ? [{ type: "stage", stage: "recall", title: "召回 · 知识 2 条", content: "[历史知识]\n- metric:gmv: GMV = 支付成功订单 total_fee 之和，不含退款\n- metric:total_fee: 单位是分" }] : []),
    { type: "thought", content: `理解问题：「${q.slice(0, 40)}」。先确认口径，档案约定 GMV 不含退款、金额单位是分。` },
    { type: "tool_call", tool: "sql_query", args: { sql: "SELECT dt, sum(total_fee)/100.0 AS gmv FROM ads_order_daily\nWHERE dt >= current_date - 7 GROUP BY dt ORDER BY dt" } },
    { type: "tool_result", tool: "sql_query", output: "| dt | gmv |\n|---|---|\n| 10-13 | 42,180.50 |\n| … | … |\n(7 行)", duration_ms: 640 },
  ];
  const answer = `近 7 天 GMV 合计 **30.6 万元**，日均 4.37 万，较前 7 天 **+3.2%**。\n\n| 日期 | GMV（元） |\n|---|---|\n| 10-13 | 42,180.50 |\n| 10-14 | 44,902.00 |\n| 10-15 | 43,377.20 |\n| 10-16 | 41,068.90 |\n| 10-17 | 45,511.30 |\n| 10-18 | 47,203.60 |\n| 10-19 | 42,355.10 |\n\n口径：支付成功订单 total_fee 之和，不含退款与测试店铺。`;
  const timers: number[] = [];
  let t = 0;
  steps.forEach((s) => { t += 500 + Math.random() * 600; timers.push(window.setTimeout(() => onEvent(s), t)); });
  t += 900;
  timers.push(window.setTimeout(() => {
    onEvent({ type: "final", status: accepted.status === "awaiting_approval" ? "awaiting_approval" : "success", output: accepted.status === "awaiting_approval" ? {} : { answer } });
    onDone();
  }, t));
  return () => timers.forEach(clearTimeout);
}
