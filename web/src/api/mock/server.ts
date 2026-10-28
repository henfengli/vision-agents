/**
 * mock 服务：按 /v1 契约响应，数据在内存里可增删改（刷新页面即复原）。
 * 只服务预览与前端开发；行为与真实后端保持一致（同样的路径、过滤、错误码）。
 */
import { ApiError } from "../client";
import type {
  FeedbackEntry, FeedbackReason,
  ApiKey, Asset, ConfigRaw, ConfigSaved, ConfigSection, Knowledge, Page, ReplayDetail, ReplayFilter, ReplayItem, ReplaySummary, ReplayVerdict,
  AfterTrigger, ResolvedRole, Run, RunAccepted, RunBrief, RunEvent, RunListItem, SearchHit, Service, ServiceSummary, ServiceTools, ServiceView, Stats, Task,
  TaskGraph, TaskSummary, Tick, ToolInfo, UpcomingFire, Version, VersionStat, WorkersResponse,
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
/** 控制台登录的身份：只有名字，不分权限 */
const ME = { name: "liyd", kind: "user" as const };
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
        if (typeof def.base === "string") { const lines = (def.base as string).split("\n"); def.base = lines.slice(0, Math.max(3, lines.length - (v - i))).join("\n"); }
        if (typeof def.description === "string" && i < v - 1) def.description = (def.description as string).replace(/：.*$/, "");
        if (Array.isArray(def.tools) && i < v - 1) def.tools = (def.tools as string[]).slice(0, -1);
        if (def.profile && i === 1) def.profile = {};
        if (typeof def.timeout_s === "number") def.timeout_s = 300;
      }
      delete def.version; delete def.updated_by; delete def.updated_at;
      list.push({ version: i, updated_by: i === 1 ? "seed" : i === v ? String(current.updated_by ?? "liyd") : db.pick(["liyd", "gaodl", "wangzh"]), created_at: new Date(Date.now() - (v - i + 1) * 31 * H).toISOString(), definition: def });
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

const TOOLS: ToolInfo[] = [
  { name: "py", title: "项目内核", description: "在线上的代码目录和解释器里执行代码（生产的配置换成只读版，测试用真实配置）：import 项目模块、调项目函数，变量会话内保留", group: "service", dangerous: true },
  { name: "bash", title: "Shell", description: "bwrap 沙箱：全盘只读、home 只露代码目录、工作目录和 /tmp 可写、调用结束进程全灭", group: "core", dangerous: true },
  { name: "read", title: "读文件", description: "带行号读文件、按 offset 翻页，或列目录；能读什么和 bash 一样", group: "core", dangerous: false },
  { name: "grep", title: "搜代码", description: "在代码里按正则搜（ripgrep），返回 文件:行号:内容；在 bash 的沙箱里跑", group: "core", dangerous: false },
  { name: "todo", title: "待办", description: "多步任务的待办清单，运行详情里显示给人看", group: "core", dangerous: false },
  { name: "service_info", title: "服务信息", description: "本运行服务×环境的目录、配置内容（打码）、git 状态", group: "service", dangerous: false },
  { name: "logs", title: "看日志", description: "读本服务本环境线上的日志（文件 / docker 容器 / systemd 单元），按行数取尾部或在整个文件里按正则搜", group: "service", dangerous: false },
  { name: "host_status", title: "主机状况", description: "部署主机的负载、内存、磁盘、大进程；本服务的进程、监听端口、crontab、容器资源；nginx", group: "service", dangerous: false },
  { name: "db_query", title: "只读查库", description: "本服务本环境登记的只读库：PostgreSQL / MySQL / MariaDB / Doris / ClickHouse / MongoDB；大结果写文件", group: "service", dangerous: false },
  { name: "save_asset", title: "沉淀方法", description: "把可复用的方法/脚本/查询/基线存入记忆", group: "memory", dangerous: false },
  { name: "notify", title: "发通知", description: "发 markdown 通知到任务的通知渠道", group: "notify", dangerous: false },
  { name: "browser_navigate", title: "browser_navigate", description: "打开一个网址（@playwright/mcp）", group: "mcp", dangerous: false, server: "browser" },
  { name: "browser_snapshot", title: "browser_snapshot", description: "页面的无障碍快照（@playwright/mcp）", group: "mcp", dangerous: false, server: "browser" },
  { name: "browser_take_screenshot", title: "browser_take_screenshot", description: "截图当前页面（@playwright/mcp）", group: "mcp", dangerous: false, server: "browser" },
];

on("GET", "/v1/meta", () => ({
  version: "9.0.0", envs: db.envs, default_env: db.settings.envs.default, me: ME,
  channels: Object.keys(db.settings.notifications.channels),
  feedback_reasons: REASONS,
  builtin_handlers: ["memory-gardener"],
  features: { vector_search: true },
  tools: TOOLS,
  event_sources: [
    { name: "dagster", title: "Dagster", notes: "在 Dagster 里配传感器回调 POST /v1/events/dagster；请求体带 event（不写 = run_failure）", events: [
      { name: "run_failure", title: "运行失败", fields: ["run_id", "asset_key", "error", "env", "subtask", "job"] },
      { name: "run_success", title: "运行成功", fields: ["run_id", "asset_key", "asset_keys", "env", "subtask", "job", "partition"] },
      { name: "asset_check_failed", title: "资产检查失败", fields: ["asset_key", "check", "severity", "description", "run_id", "env", "subtask"] },
    ] },
    { name: "gitlab", title: "GitLab", notes: "项目 Webhook 勾选 Deployment events", events: [{ name: "deployment", title: "部署成功", fields: ["project", "ref", "env", "sha", "url", "user"] }] },
    { name: "webhook", title: "通用 Webhook", notes: "事件名放请求头 X-Event 或请求体 event", events: [{ name: "*", title: "任意事件", fields: [] }] },
  ],
}));

// ———————— 控制台登录（mock：任何非空密钥都有效；填的名字就是之后的发起人 / 修改人，不填按 root） ————————
on("POST", "/auth/session", (_p, _q, body) => {
  if (!String(body?.token ?? "").trim()) throw new ApiError(401, "unauthorized", "密钥无效、已吊销或已过期");
  ME.name = String(body?.name ?? "").trim() || "root";
  return ME;
});
on("GET", "/auth/session", () => ME);
on("DELETE", "/auth/session", () => null);

// ———————— 服务 ————————

type Svc = (typeof db.services)[number];
const envEnabled = (s: Svc, env: string) => s.enabled && s.envs[env]?.enabled !== false;
/** 渲染 {env}；~ 开头展开成部署用户的 home（与后端 domain/services.render 一致） */
const render = (path: string, env: string) => path.replaceAll("{env}", env).replace(/^~(?=\/|$)/, db.HOME);
/** 该环境的解释器：环境覆盖 > 服务的 python > python3 */
const pythonOf = (s: Svc, env: string) => render(s.envs[env]?.python || s.python || "python3", env);
/** 该环境的地址：基座 + 环境覆盖（按键） */
const urlsOf = (s: Svc, env: string) => Object.fromEntries(Object.entries({ ...s.urls, ...(s.envs[env]?.urls ?? {}) }).map(([k, v]) => [k, render(v, env)]));
/** 写了 envs 就只在列出的环境可用 */
const mcpServersIn = (s: Svc, env: string) => Object.entries(s.mcp ?? {})
  .filter(([, cfg]) => { const per = cfg.envs as Record<string, unknown> | undefined; return !per || !Object.keys(per).length || env in per; }).map(([k]) => k);

/** 服务×环境的解析结果（与后端 ServiceDef.view 一致） */
function viewOf(s: Svc, env: string) {
  const o = s.envs[env] ?? {};
  const rawRoot = o.root != null ? o.root : s.root;
  const codePaths = o.code_paths ?? (s.code_paths.length ? s.code_paths : rawRoot ? [rawRoot] : []);
  return {
    enabled: envEnabled(s, env), root: render(rawRoot, env), code_paths: codePaths.map((p) => render(p, env)),
    python: pythonOf(s, env), urls: urlsOf(s, env),
    // 基座 + 环境覆盖（按库名 / 日志名），空串 = 本环境没有
    databases: Object.fromEntries(Object.entries({ ...s.databases, ...(o.databases ?? {}) }).filter(([, v]) => v)),
    logs: Object.fromEntries(Object.entries({ ...s.logs, ...(o.logs ?? {}) }).filter(([, v]) => v).map(([k, v]) => [k, render(v, env)])),
    config_files: s.configs.map((key) => ({ key, path: render(key, env) })),
    profile: { ...s.profile, ...(o.profile ?? {}) },
  };
}

// 只读库（与后端 credentials.py 一致）：口令是 ${VAR} 占位就原样显示，明文换成 ***；保存时 *** 原样传回表示不改
const DSN = /^([a-z][\w+.-]*:\/\/[^:/@]*:)(.*)(@[^@]*)$/is;
const DB_SCHEMES = ["postgresql", "postgres", "mysql", "mariadb", "doris", "clickhouse", "clickhouses", "mongodb", "mongodb+srv"];
const redactDsn = (dsn: string) => {
  const m = DSN.exec(dsn);
  return !m || !m[2] || /^\$\{\w+\}$/.test(m[2]) || m[2] === "***" ? dsn : `${m[1]}***${m[3]}`;
};
const restoreDsn = (next: string, current: string | undefined) =>
  next && current && DSN.exec(next)?.[2] === "***" && redactDsn(current) === next ? current : next;
const redactDbs = (dbs: Record<string, string> | undefined) => Object.fromEntries(Object.entries(dbs ?? {}).map(([k, v]) => [k, v ? redactDsn(v) : v]));
function redactService<T extends Svc>(s: T): T {
  return { ...s, databases: redactDbs(s.databases), envs: Object.fromEntries(Object.entries(s.envs).map(([k, o]) => [k, o.databases ? { ...o, databases: redactDbs(o.databases) } : o])) };
}
const invalid = (message: string) => new ApiError(422, "invalid_definition", message);
function checkDbs(dbs: Record<string, string> | undefined, where: string) {
  for (const [name, url] of Object.entries(dbs ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name)) throw invalid(`${where}库名不合法：'${name}'（小写字母开头，可含数字 _ -）`);
    const scheme = url.includes("://") ? url.split("://")[0].toLowerCase() : "";
    if (url && !DB_SCHEMES.includes(scheme)) throw invalid(`${where}库 ${name} 的连接串类型不认识：${scheme || "（缺 scheme）"}://（可用：${DB_SCHEMES.map((x) => x + "://").join("、")}）`);
  }
}
const absolute = (p: string) => p.startsWith("/") || p.startsWith("~");
/** 日志：{名字: 文件路径（可带 * 通配）| docker:<容器名> | journal:<systemd 单元>}；环境覆盖里值写空串 = 本环境没有这个日志（与后端 _check_logs 一致） */
function checkLogs(logs: Record<string, string> | undefined, where: string) {
  for (const [name, target] of Object.entries(logs ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,30}$/.test(name)) throw invalid(`${where}日志名不合法：'${name}'（小写字母开头，可含数字 _ -）`);
    const prefixed = ["docker:", "journal:"].some((p) => target.startsWith(p) && target.length > p.length);
    if (target && !(absolute(target) || prefixed)) throw invalid(`${where}日志 ${name} 要写绝对路径（可以 ~ 开头，可带 * 通配）、docker:<容器名> 或 journal:<systemd 单元>，不是 '${target}'`);
  }
}
/** configs / hidden：绝对路径（可以 ~ 开头），去重 */
function cleanPaths(paths: string[] | undefined, field: string): string[] | undefined {
  if (!paths) return paths;
  const out: string[] = [];
  for (const raw of paths) {
    const p = String(raw ?? "").trim();
    if (!p) throw invalid(`${field}：路径不能为空`);
    if (!absolute(p)) throw invalid(`${field}：路径要写绝对路径（可以 ~ 开头）：'${p}'`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
function restoreService(body: Partial<Service>, current: Svc): Partial<Service> {
  const out = structuredClone(body);
  if (out.databases) {
    checkDbs(out.databases, "");
    out.databases = Object.fromEntries(Object.entries(out.databases).map(([k, v]) => [k, restoreDsn(v, current.databases[k])]));
  }
  if (out.configs) out.configs = cleanPaths(out.configs, "configs");
  if (out.hidden) out.hidden = cleanPaths(out.hidden, "hidden");
  if (out.logs) checkLogs(out.logs, "");
  if (out.env_vars) {
    const bad = Object.entries(out.env_vars).filter(([, v]) => String(v).includes("${")).map(([k]) => k);
    if (bad.length) throw invalid(`环境变量不支持 \${VAR}：${bad.join("、")}（口令写进给 agent 用的配置文件）`);
  }
  for (const [env, o] of Object.entries(out.envs ?? {})) {
    if (o.logs) checkLogs(o.logs, `环境 ${env} 的`);
    if (!o.databases) continue;
    checkDbs(o.databases, `环境 ${env} 的`);
    o.databases = Object.fromEntries(Object.entries(o.databases).map(([k, v]) => [k, restoreDsn(v, current.envs[env]?.databases?.[k])]));
  }
  const masked = [...Object.entries(out.databases ?? {}).map(([k, v]) => ["", k, v]),
    ...Object.entries(out.envs ?? {}).flatMap(([env, o]) => Object.entries(o.databases ?? {}).map(([k, v]) => [env, k, v]))]
    .find(([, , v]) => v && DSN.exec(v)?.[2] === "***");
  if (masked) throw invalid(`${masked[0] ? `环境 ${masked[0]} 的` : ""}库 ${masked[1]} 的口令显示为 *** 却对不上原值，请重新填写口令（建议写成 \${VAR}，真实值放 secrets.env）`);
  return out;
}

function serviceSummary(s: Svc): ServiceSummary {
  const health: ServiceSummary["health"] = {};
  for (const e of db.envs) {
    const rs = db.runs.filter((r) => r.service === s.name && r.env === e.name);
    const last = rs[0];
    health[e.name] = {
      enabled: envEnabled(s, e.name),
      env_enabled: s.envs[e.name]?.enabled !== false,
      triggers_paused: !!s.envs[e.name]?.triggers_paused,
      python: pythonOf(s, e.name),
      runs_24h: rs.filter((r) => within(r.created_at, 24)).length,
      failed_24h: rs.filter((r) => within(r.created_at, 24) && r.status === "failed").length,
      last_run: last ? { run_id: last.run_id, status: last.status, created_at: last.created_at } : null,
    };
  }
  // 与后端 _service_summaries 一致：专属任务 + 通用任务（service="*"），都不含子任务
  return {
    ...redactService(s), health,
    task_count: db.tasks.filter((t) => t.service === s.name && !t.extends).length,
    generic_task_count: db.tasks.filter((t) => t.service === "*" && !t.extends).length,
  };
}

const findService = (name: string) => db.services.find((x) => x.name === name) ?? (() => { throw notFound("服务 " + name); })();
const checkEnv = (env: string) => { if (!db.envs.some((e) => e.name === env)) throw new ApiError(404, "unknown_env", `环境 ${env} 不存在`); };

on("GET", "/v1/services", () => db.services.map(serviceSummary));
on("GET", "/v1/services/:name", (p) => serviceSummary(findService(p.name)));
on("PATCH", "/v1/services/:name", (p, _q, body) => {
  const s = findService(p.name);
  return serviceSummary(bump("services/" + p.name, s, restoreService(body, s)));
});
on("POST", "/v1/services", (_p, _q, body) => {
  if (db.services.some((s) => s.name === body.name)) throw new ApiError(409, "conflict", `服务 ${body.name} 已存在`);
  if (!/^[a-z][a-z0-9._-]{1,40}$/.test(String(body.name ?? ""))) throw invalid(`服务名不合法：'${body.name}'（小写字母开头，可含数字 . _ -，2~41 字符）`);
  const s: Service = {
    title: "", description: "", root: "", code_paths: [], python: "", env_vars: {}, urls: {}, databases: {},
    configs: [], hidden: [], logs: {}, mcp: {}, envs: {}, profile: {}, enabled: true, ...body, version: 1, updated_by: ME.name, updated_at: now(),
  };
  db.services.push(s);
  return serviceSummary(s);
});
on("DELETE", "/v1/services/:name", (p) => {
  const users = db.tasks.filter((t) => t.service === p.name).map((t) => "任务 " + t.name);
  if (users.length) throw new ApiError(409, "in_use", `服务 ${p.name} 正被使用：${users.join("、")}`);
  db.services.splice(db.services.indexOf(findService(p.name)), 1);
  return { deleted: [p.name] };
});

// ———————— 给 agent 的只读版配置：存库，按 服务×环境×路径（定义里的写法）带版本 ————————
// 只在受保护的环境（生产）用；不受保护的环境（测试）直接用项目的真实配置，读、存都 409 config_not_used（与后端一致）

const envProtected = (env: string) => db.envs.find((e) => e.name === env)?.protected ?? false;
function requireProtected(env: string) {
  checkEnv(env);
  if (!envProtected(env)) throw new ApiError(409, "config_not_used", `${env} 不是受保护的环境：agent 直接用项目的真实配置，不用填只读版`);
}

const byteSize = (text: string) => new TextEncoder().encode(text).length;

/** 打码（与后端 services/inspect.mask 一致）：键像密钥的 key: value / KEY=value 行，值换成 *** */
const SECRET_HINTS = ["password", "passwd", "secret", "token", "apikey", "api_key", "access_key", "private_key"];
function mask(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    if (!SECRET_HINTS.some((h) => line.toLowerCase().includes(h))) return line;
    for (const sep of ["=", ":"]) {
      const i = line.indexOf(sep);
      if (i < 0) continue;
      const head = line.slice(0, i), tail = line.slice(i + 1);
      if (tail.trim() && SECRET_HINTS.some((h) => head.toLowerCase().includes(h))) return `${head}${sep}${tail.startsWith(" ") ? " " : ""}***`;
    }
    return line;
  }).join("\n");
}

const cfgKey = (service: string, env: string, key: string) => `${service}@${env}|${key}`;
const cfgRows = (service: string, env: string, key: string) => db.agentConfigs.get(cfgKey(service, env, key)) ?? [];
const lastRow = (service: string, env: string, key: string) => { const rows = cfgRows(service, env, key); return rows[rows.length - 1]; };

/** path 可以是定义里的写法（key）或渲染后的路径；只认该服务该环境声明过的 */
function configEntry(s: Svc, env: string, path: string) {
  checkEnv(env);
  const c = viewOf(s, env).config_files.find((x) => path === x.key || path === x.path);
  if (!c) throw new ApiError(404, "not_found", `${path} 不是服务 ${s.name} 在 ${env} 声明的配置文件`);
  return c;
}

on("GET", "/v1/services/:name/envs/:env", (p): ServiceView => {
  const s = findService(p.name);
  checkEnv(p.env);
  const v = viewOf(s, p.env);
  const prot = envProtected(p.env);
  return {
    service: s.name, env: p.env, enabled: v.enabled, protected: prot, triggers_paused: !!s.envs[p.env]?.triggers_paused, python: v.python, root: v.root, code_paths: v.code_paths, urls: v.urls,
    mcp_servers: Object.keys(s.mcp ?? {}), databases: redactDbs(v.databases), logs: v.logs, profile: v.profile,
    // 不受保护的环境用真实配置：没有给 agent 的版本
    config_files: v.config_files.map((c) => {
      const last = prot ? lastRow(s.name, p.env, c.key) : undefined;
      return { ...c, version: last?.version ?? null, updated_by: last?.updated_by ?? null, updated_at: last?.updated_at ?? null };
    }),
  };
});

// 默认密钥打码（没填时 404）；raw=true 原文 + 版本（编辑用）
on("GET", "/v1/services/:name/envs/:env/config", (p, q) => {
  const s = findService(p.name);
  requireProtected(p.env);
  const c = configEntry(s, p.env, String(q.path || ""));
  const last = lastRow(s.name, p.env, c.key);
  if (q.raw === true || q.raw === "true") {
    const raw: ConfigRaw = {
      path: c.path, key: c.key, exists: !!last, content: last?.content ?? "",
      version: last?.version ?? null, updated_by: last?.updated_by ?? null, updated_at: last?.updated_at ?? null,
    };
    return raw;
  }
  if (!last) throw new ApiError(404, "not_found", `${c.path} 在 ${p.env} 还没有填给 agent 的只读版`);
  return { path: c.path, key: c.key, content: mask(last.content) };
});
// 保存 = 新版本（内容没变不加版本）
on("PUT", "/v1/services/:name/envs/:env/config", (p, _q, body): ConfigSaved => {
  const s = findService(p.name);
  requireProtected(p.env);
  const c = configEntry(s, p.env, String(body?.path ?? ""));
  const content = String(body?.content ?? "");
  if (byteSize(content) > 1024 * 1024) throw new ApiError(422, "invalid_request", "配置超过 1MB");
  const rows = cfgRows(s.name, p.env, c.key);
  const last = rows[rows.length - 1];
  if (last && last.content === content) return { path: c.path, key: c.key, version: last.version, changed: false };
  const version = (last?.version ?? 0) + 1;
  db.agentConfigs.set(cfgKey(s.name, p.env, c.key), [...rows, { version, content, updated_by: ME.name, updated_at: now() }]);
  return { path: c.path, key: c.key, version, changed: true };
});
on("GET", "/v1/services/:name/envs/:env/config/history", (p, q) => {
  const s = findService(p.name);
  const c = configEntry(s, p.env, String(q.path || ""));
  return [...cfgRows(s.name, p.env, c.key)].reverse().map((r) => ({ version: r.version, updated_by: r.updated_by, updated_at: r.updated_at, size: byteSize(r.content) }));
});
on("GET", "/v1/services/:name/envs/:env/config/history/:version", (p, q) => {
  const s = findService(p.name);
  const c = configEntry(s, p.env, String(q.path || ""));
  const row = cfgRows(s.name, p.env, c.key).find((r) => r.version === Number(p.version));
  if (!row) throw notFound(`${c.path} 的第 ${p.version} 版`);
  return { version: row.version, content: row.content, updated_by: row.updated_by, updated_at: row.updated_at };
});

// 服务自己声明的 MCP 工具：没连过时现连一次；reload=true 强制重连
const DAGSTER_TOOLS = [
  ["get_run", "按 run id 看一次 Dagster 运行：状态、起止时间、失败的步骤"],
  ["get_run_logs", "一次运行的事件日志（可只看 ERROR）"],
  ["get_asset_materializations", "某资产最近的物化记录：分区、状态、耗时"],
  ["recent_runs", "最近的运行列表，可按 job / 状态筛"],
  ["asset_info", "资产的定义：上游依赖、分区方式、所属 job"],
  ["launch_job", "在线上启动一个作业（受 DAGSTER_LAUNCH_JOBS 限制）"],
  ["reexecute_run", "在线上重跑一次失败的运行（只重跑失败的步骤）"],
] as const;
const mcpLoaded = new Set<string>();
on("GET", "/v1/services/:name/tools", (p, q): ServiceTools => {
  const s = findService(p.name);
  const servers = Object.keys(s.mcp ?? {});
  if (q.reload === true || q.reload === "true") mcpLoaded.delete(s.name);
  if (!servers.length) return { servers, loaded: false, tools: [], failed: [] };
  mcpLoaded.add(s.name);
  const tools: ServiceTools["tools"] = [];
  const failed: string[] = [];
  for (const server of servers) {
    const envs = db.envs.map((e) => e.name).filter((env) => envEnabled(s, env) && mcpServersIn(s, env).includes(server));
    if (server === "dagster") tools.push(...DAGSTER_TOOLS.map(([name, description]) => ({ name, description, server, envs })));
    else failed.push(...envs.map((env) => `${s.name}.${server}@${env}`));
  }
  return { servers, loaded: true, tools, failed };
});

// ———————— 角色 ————————

const findRole = (name: string) => db.roles.find((r) => r.name === name) ?? (() => { throw notFound("角色 " + name); })();
on("GET", "/v1/roles", () => db.roles);
on("GET", "/v1/roles/:name", (p) => findRole(p.name));
on("PATCH", "/v1/roles/:name", (p, _q, body) => {
  if (body.subagents?.includes(p.name)) throw new ApiError(422, "invalid_definition", "子代理不能是角色自己");
  return bump("roles/" + p.name, findRole(p.name), body);
});
on("POST", "/v1/roles", (_p, _q, body) => {
  if (db.roles.some((r) => r.name === body.name)) throw new ApiError(409, "conflict", `角色 ${body.name} 已存在`);
  const r = { title: "", description: "", prompt: "", tools: [], subagents: body.extends ? null : [], service_tools: body.extends ? null : true, extends: null, prompt_append: "", ...body, version: 1, updated_by: ME.name, updated_at: now() };
  db.roles.push(r);
  return r;
});
on("DELETE", "/v1/roles/:name", (p) => {
  const users = [...db.tasks.filter((t) => t.role === p.name).map((t) => "任务 " + t.name),
    ...db.roles.filter((r) => r.extends === p.name || r.subagents?.includes(p.name)).map((r) => "角色 " + r.name)];
  if (users.length) throw new ApiError(409, "in_use", `角色 ${p.name} 正被使用：${users.join("、")}`);
  db.roles.splice(db.roles.indexOf(findRole(p.name)), 1);
  return { deleted: [p.name] };
});
/**
 * 继承合并（与 domain/roles.resolve_role 一致）：子角色写了 tools / subagents / service_tools 就整体替换父角色的，
 * 没写就跟随（tools 为空 = 没写）；提示词在父角色之后追加 prompt_append。子代理去掉自己。
 */
on("GET", "/v1/roles/:name/resolved", (p): ResolvedRole => {
  const chain: (typeof db.roles)[number][] = [];
  const seen = new Set<string>();
  let r: (typeof db.roles)[number] | undefined = findRole(p.name);
  while (r) {
    if (seen.has(r.name)) throw new ApiError(422, "invalid_definition", `角色继承存在循环：${[...seen, r.name].join(" → ")}`);
    seen.add(r.name);
    chain.unshift(r);
    const parent: string | null = r.extends;
    r = parent ? db.roles.find((x) => x.name === parent) ?? (() => { throw new ApiError(422, "invalid_definition", `角色 ${parent} 不存在（解析 ${p.name} 的继承链时）`); })() : undefined;
  }
  const [root, ...children] = chain;
  let tools = [...root.tools], subagents = [...(root.subagents ?? [])], serviceTools = root.service_tools ?? true;
  let title = root.title, description = root.description;
  const parts = root.prompt ? [root.prompt] : [];
  for (const c of children) {
    if (c.tools.length) tools = [...c.tools];
    if (c.subagents != null) subagents = [...c.subagents];
    if (c.service_tools != null) serviceTools = c.service_tools;
    if (c.prompt_append) parts.push(c.prompt_append);
    title = c.title || title;
    description = c.description || description;
  }
  return { name: p.name, title: title || p.name, description, prompt: parts.join("\n\n"), tools, subagents: subagents.filter((s) => s !== p.name), service_tools: serviceTools, lineage: chain.map((c) => c.name) };
});

// ———————— 任务 ————————

/** mock 的子任务记着自己写了哪些字段（_own，等于后端的 model_fields_set），其余跟随父任务 */
type MockTask = Task & { _own?: string[] };
const LEDGER = ["name", "version", "updated_by", "updated_at", "extends", "auto_created", "_own"];

/** 子任务自己写了哪些字段 */
function ownFields(t: Task): string[] {
  if (!t.extends) return [];
  return ((t as MockTask)._own ?? []).filter((k) => !LEDGER.includes(k)).sort();
}

function effective(t: Task): Task {
  if (!t.extends) return t;
  const parent = db.tasks.find((x) => x.name === t.extends);
  if (!parent) return t;
  const own = ownFields(t);
  const out = { ...parent, name: t.name, extends: t.extends, auto_created: t.auto_created, version: t.version, updated_by: t.updated_by, updated_at: t.updated_at } as Task;
  for (const k of own) (out as unknown as Record<string, unknown>)[k] = (t as unknown as Record<string, unknown>)[k];
  out.profile = { ...parent.profile, ...(own.includes("profile") ? t.profile : {}) };
  out.input = { ...parent.input, ...(own.includes("input") ? t.input : {}) };
  delete (out as MockTask)._own;
  return out;
}

const NAME_RE = /^[a-z][a-z0-9-]{1,48}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BUILTINS = ["memory-gardener"];

/**
 * 与后端写入时的检查一致（domain/tasks.py consistency_error + registry._check_task）。
 * triggers=false：子任务没写自己的触发——合并来的父任务定时 / 事件不按它触发，不拿它的环境、输入去对
 */
function checkTask(t: Task, triggers = true) {
  const bad = (m: string) => { throw invalid(m); };
  if (t.form === "agent" && !t.role) bad("单角色任务需要指定角色");
  if (t.form === "builtin" && !t.handler) bad("内建任务需要处理器名");
  if (t.form === "builtin" && t.handler && !BUILTINS.includes(t.handler)) bad(`未知的内建处理器 ${t.handler}（可用：${BUILTINS.join("、")}）`);
  if (t.role && !db.roles.some((r) => r.name === t.role)) bad(`角色 ${t.role} 不存在`);
  if (t.service && t.service !== "*" && !db.services.some((s) => s.name === t.service)) bad(`服务 ${t.service} 不存在`);
  if (!(t.timeout_s >= 1 && t.timeout_s <= 7200)) bad("超时须在 1~7200 秒之间");
  for (const [name, f] of Object.entries(t.input)) {
    if (!FIELD_RE.test(name)) bad(`输入字段名 '${name}' 不合法（字母、数字、下划线，字母或下划线开头）`);
    if (f.type === "enum" && !f.options?.length) bad(`输入字段 ${name} 是枚举，至少要有一个选项`);
  }
  if (t.object_input && !(t.object_input in t.input)) bad(`对象字段 ${t.object_input} 不在输入字段里`);
  if (t.dedup) {
    const keys = t.dedup.key.split("+").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) bad("去重要写按哪个输入字段（a+b 拼接多个）");
    const missing = keys.filter((k) => !(k in t.input));
    if (missing.length) bad(`去重字段不在输入里：${missing.join("、")}`);
  }
  const ids = t.triggers.map((x) => x.id);
  if (triggers && new Set(ids).size !== ids.length) bad("触发器 id 重复");
  const envNames = db.settings.envs.items.map((e) => e.name);
  for (const e of t.envs) if (!envNames.includes(e)) bad(`未知环境：${e}`);
  for (const tr of triggers ? t.triggers : []) {
    if (tr.type === "schedule") {
      if (!tr.envs.length) bad("定时触发至少要选一个环境");
      const outside = t.envs.length ? tr.envs.filter((e) => !t.envs.includes(e)) : [];
      if (outside.length) bad(`定时 ${tr.id} 的环境 ${outside.join("、")} 不在任务允许的环境里`);
      if (t.service === "*" && !tr.service) bad(`通用任务的定时触发 ${tr.id} 需要指定服务`);
      const missing = Object.entries(t.input).filter(([k, f]) => f.required && (tr.input?.[k] ?? f.default) == null).map(([k]) => k);
      if (missing.length) bad(`定时 ${tr.id} 的固定输入不合法：${missing.map((k) => `${k} 必填`).join("；")}`);
    }
    if (tr.type === "event") {
      for (const r of tr.rules ?? []) {
        if (!r.pattern.trim()) bad(`事件 ${tr.id} 有一条规则的正则是空的（会匹配所有报错）`);
        if (!r.conclusion.trim()) bad(`事件 ${tr.id} 的规则 ${r.pattern} 没写结论`);
      }
    }
    if (tr.type === "after") checkAfterTrigger(t, tr);
  }
  // 与后端 Retry / TaskDef 的校验一致
  if (t.retry) {
    if (t.form === "builtin") bad("内建任务不支持自动重试（自动重试走续跑，内建任务没有断点）");
    if (!(t.retry.max >= 1 && t.retry.max <= 5)) bad("自动重试次数须在 1~5 之间");
    if (!(t.retry.delay_s >= 10 && t.retry.delay_s <= 3600)) bad("重试间隔须在 10 秒 ~ 1 小时之间");
  }
  if (t.concurrency != null && !(t.concurrency >= 1 && t.concurrency <= 50)) bad("同时执行上限须在 1~50 之间");
  if (t.deliver?.channel && !(t.deliver.channel in db.settings.notifications.channels))
    bad(`结果投递的渠道 ${t.deliver.channel} 不存在（可选：${Object.keys(db.settings.notifications.channels).join("、") || "无"}）`);
  if (t.deliver && !t.deliver.channel === !t.deliver.url) bad("投递需要且只能填渠道或回调地址之一");
}

/** 上游运行能被引用的字段（与 domain/tasks._AFTER_PATH 一致）；all 模式可带「上游任务名.」前缀 */
const AFTER_PATH = /^(?:[a-z][a-z0-9-]{1,48}(?::[^:\s/\\.]+)?\.)?(?:run_id|task|env|service|status|caller|error|error_code|output\.answer|input\.[A-Za-z_]\w*|output\.data(?:\.[A-Za-z_]\w*)+)$/;
const AFTER_TOP = ["run_id", "task", "env", "service", "status", "caller", "error", "error_code", "input", "output"];
const upstreamOf = (path: string) => { const head = path.split(".")[0]; return AFTER_TOP.includes(head) || !path.includes(".") ? "" : head; };

/** 与后端 AfterTrigger.problem + consistency_error 的联动部分一致 */
function checkAfterTrigger(t: Task, tr: AfterTrigger) {
  const bad = (m: string) => { throw invalid(m); };
  if (!tr.tasks.length) bad(`联动 ${tr.id} 至少要选一个上游任务`);
  if (new Set(tr.tasks).size !== tr.tasks.length) bad(`联动 ${tr.id} 的上游任务重复`);
  if (!tr.on.length) bad(`联动 ${tr.id} 至少要选一种上游结束状态（成功 / 失败）`);
  const window = tr.window_s ?? 86400;
  if (!(window >= 60 && window <= 7 * 86400)) bad("等待窗口须在 1 分钟 ~ 7 天之间");
  for (const [field, pattern] of Object.entries(tr.filter ?? {})) {
    if (!AFTER_PATH.test(field)) bad(`联动 ${tr.id} 的过滤字段 ${field} 写法不对（如 status、input.asset_key、output.data.category）`);
    try { new RegExp(pattern); } catch (e) { bad(`联动 ${tr.id} 的过滤 ${field} 正则不合法：${(e as Error).message}`); }
  }
  for (const [k, path] of Object.entries(tr.map ?? {})) if (!AFTER_PATH.test(path)) bad(`联动 ${tr.id} 的映射 ${k} ← ${path} 写法不对（如 run_id、input.version、output.answer）`);
  const missing = Object.keys(tr.map ?? {}).filter((k) => !(k in t.input));
  if (missing.length) bad(`联动 ${tr.id} 映射的 ${missing.join("、")} 不是输入字段`);
  const refs = [...Object.values(tr.map ?? {}), ...Object.keys(tr.filter ?? {})];
  const prefixed = refs.filter((p) => upstreamOf(p));
  if (tr.mode === "any" && prefixed.length) bad(`联动 ${tr.id} 是「任一上游结束」，引用不用带上游任务名：${prefixed.join("、")}`);
  const alien = prefixed.filter((p) => !tr.tasks.includes(upstreamOf(p)));
  if (tr.mode === "all" && alien.length) bad(`联动 ${tr.id} 引用了不在上游里的任务：${alien.join("、")}`);
  if (tr.service && !db.services.some((s) => s.name === tr.service)) bad(`触发器 ${tr.id} 指定的服务 ${tr.service} 不存在`);
}

/** 与后端 registry._check_after 一致：上游都存在、不是自己，加上它之后整张联动图没有环 */
function checkAfter(name: string, t: Task) {
  const afters = t.triggers.filter((tr): tr is AfterTrigger => tr.type === "after");
  if (!afters.length) return;
  const base = name.split(":")[0];
  for (const tr of afters) for (const up of tr.tasks) {
    if (up.split(":")[0] === base) throw invalid(`联动 ${tr.id} 的上游不能是这个任务自己（${up}）`);
    if (!db.tasks.some((x) => x.name === up)) throw invalid(`联动 ${tr.id} 的上游任务 ${up} 不存在`);
  }
  // 联动图：上游（父任务名）→ 下游（父任务名）；子任务自己写了触发才算
  const graph = new Map<string, Set<string>>();
  const add = (n: string, triggers: Task["triggers"]) => {
    for (const tr of triggers) if (tr.type === "after") for (const up of tr.tasks) {
      const k = up.split(":")[0];
      graph.set(k, (graph.get(k) ?? new Set()).add(n.split(":")[0]));
    }
  };
  for (const x of db.tasks) if (x.name !== name && (!x.extends || ownFields(x).includes("triggers"))) add(x.name, x.triggers);
  add(name, t.triggers);
  const state = new Map<string, number>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    path.push(node);
    for (const nxt of [...(graph.get(node) ?? [])].sort()) {
      if (state.get(nxt) === 1) return [...path.slice(path.indexOf(nxt)), nxt];
      if (!state.has(nxt)) { const found = visit(nxt); if (found) return found; }
    }
    state.set(node, 2);
    path.pop();
    return null;
  };
  for (const node of [...graph.keys()].sort()) {
    if (state.has(node)) continue;
    const cycle = visit(node);
    if (cycle) throw invalid("联动成环了：" + cycle.join(" → ") + "（上游结束触发下游，绕一圈又回到自己）");
  }
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
    // 后端 model_dump 会带上输入字段的全部默认值（default 为 null、options 为 []）
    input: Object.fromEntries(Object.entries(t.input).map(([k, f]) => [k, { required: false, description: "", default: null, options: [], ...f }])),
    stats_24h: { runs: day.length, success: day.filter((r) => r.status === "success").length, failed: day.filter((r) => r.status === "failed").length, p50_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null },
    last_run: rs[0] ? { run_id: rs[0].run_id, status: rs[0].status, created_at: rs[0].created_at } : null,
    next_fire: t.enabled && fires[0] ? { env: fires[0].env, at: fires[0].at } : null,
    subtask_count: db.tasks.filter((x) => x.extends === t.name).length,
  };
}

const findTask = (name: string) => db.tasks.find((x) => x.name === name) ?? (() => { throw notFound("任务 " + name); })();
const blankTask = (body: Partial<Task>): Task => ({ title: "", description: "", service: null, role: null, form: "agent", input: {}, envs: [], triggers: [{ id: "api", type: "api" }], deliver: null, dedup: null, memory: {}, timeout_s: 300, enabled: true, profile: {}, extends: null, auto_created: false, handler: null, output_schema: null, retry: null, concurrency: null, ...body, version: 1, updated_by: ME.name, updated_at: now() } as Task);

/** 结构化输出的 schema：空 = 不要求；顶层须是 object（真实后端还会按 JSON Schema 规范校验） */
function checkSchema(body: Partial<Task>) {
  const s = body.output_schema;
  if (s === undefined) return;
  if (s && Object.keys(s).length && s.type !== "object")
    throw new ApiError(422, "invalid_definition", '结构化输出的 schema 顶层须是 {"type": "object", "properties": …}');
  if (s && !Object.keys(s).length) body.output_schema = null;
}

/** 父任务改了：每个子任务合并之后也要还成立 */
function checkChildren(parent: Task) {
  // 只有 extends 的子任务生效定义就是父任务，父任务那边已经查过
  for (const c of db.tasks.filter((x) => x.extends === parent.name && ownFields(x).length)) {
    try { checkTask(effectiveWith(c, parent), ownFields(c).includes("triggers")); }
    catch (e) { throw invalid(`子任务 ${c.name} 合并后不成立：${(e as Error).message}`); }
  }
}
function effectiveWith(child: Task, parent: Task): Task {
  const i = db.tasks.findIndex((x) => x.name === parent.name);
  const saved = db.tasks[i];
  db.tasks[i] = parent;
  try { return effective(child); } finally { db.tasks[i] = saved; }
}

// 子任务（effective）的生效定义里 service / role / form 等都是父任务的；summary 用的就是它
const filteredTasks = (service: unknown) => db.tasks.filter((t) => { const e = effective(t); return !service || e.service === service || e.service === "*"; });
on("GET", "/v1/tasks", (_p, q) => filteredTasks(q.service).map(taskSummary));
// 与后端 GET /v1/tasks/_graph 一致：节点是父任务，边是上游联动；要注册在 /v1/tasks/:name 前面
on("GET", "/v1/tasks/_graph", (): TaskGraph => {
  const nodes = db.tasks.filter((t) => !t.extends).map((t) => {
    const s = taskSummary(t);
    return {
      name: s.name, title: s.title, service: s.service, form: s.form, enabled: s.enabled, subtask_count: s.subtask_count, stats_24h: s.stats_24h,
      last_run: s.last_run, next_fire: s.next_fire,
      entry: s.triggers.filter((tr) => tr.type !== "after" && tr.enabled !== false).map((tr) => ({
        type: tr.type as "api", id: tr.id, ...(tr.type === "schedule" ? { cron: tr.cron } : {}), ...(tr.type === "event" ? { source: tr.source, event: tr.event } : {}) })),
    };
  });
  const edges = db.tasks.filter((t) => !t.extends || ownFields(t).includes("triggers")).flatMap((t) => {
    const e = effective(t);
    return e.triggers.filter((tr): tr is AfterTrigger => tr.type === "after").flatMap((tr) => tr.tasks.map((up) => ({
      from: up.split(":")[0], to: t.name.split(":")[0], trigger_id: tr.id, mode: tr.mode, on: tr.on, enabled: tr.enabled !== false && e.enabled,
      from_object: up.includes(":") ? up.split(":").slice(1).join(":") : null, to_object: t.name.includes(":") ? t.name.split(":").slice(1).join(":") : null,
      upstreams: tr.tasks.length })));
  });
  return { nodes, edges };
});
on("GET", "/v1/tasks/:name", (p) => taskSummary(findTask(p.name)));
on("PATCH", "/v1/tasks/:name", (p, _q, body) => {
  const cur = findTask(p.name);
  checkSchema(body);
  const { name: _n, version: _v, updated_by: _u, updated_at: _a, ...patch } = body as Record<string, unknown>;
  void _n; void _v; void _u; void _a;
  if (cur.extends) {
    // 子任务：写了的字段成了它自己的；写 null = 去掉这项、重新跟随父任务。人改过一次就不再算自动创建
    const parent = findTask(cur.extends);
    const own = new Set(ownFields(cur));
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) { own.delete(k); next[k] = structuredClone((parent as unknown as Record<string, unknown>)[k]); } else { own.add(k); next[k] = v; }
    }
    // 与后端 registry._check_task 一致：上限按父任务算（连同子任务），子任务不能单独设
    if (own.has("concurrency") && next.concurrency != null) throw invalid("同时执行上限按父任务算（连同子任务），子任务不能单独设");
    if (own.size) checkTask(effective({ ...cur, ...next, _own: [...own] } as MockTask), own.has("triggers"));
    if (own.has("triggers")) checkAfter(p.name, { ...cur, ...next } as Task);
    return taskSummary(bump("tasks/" + p.name, cur, { ...next, auto_created: false, _own: [...own] } as Partial<Task>));
  }
  const next = { ...cur, ...patch } as Task;
  checkTask(next);
  checkAfter(p.name, next);
  checkChildren(next);
  return taskSummary(bump("tasks/" + p.name, cur, patch as Partial<Task>));
});
on("POST", "/v1/tasks", (_p, _q, body) => {
  const name = String(body.name ?? "");
  if (!NAME_RE.test(name)) throw invalid(`任务名不合法：'${name}'（小写字母开头，可含数字与连字符）`);
  if (db.tasks.some((t) => t.name === name)) throw new ApiError(409, "conflict", `任务 ${name} 已存在`);
  checkSchema(body);
  const t = blankTask(body);
  checkTask(t);
  checkAfter(name, t);
  db.tasks.push(t);
  return taskSummary(t);
});
on("DELETE", "/v1/tasks/:name", (p) => {
  findTask(p.name);
  // 与后端 registry._users_of 一致：别的任务声明了「在它结束后跑」的不能删（删子任务时，写了子任务全名的才算）
  const gone = new Set(p.name.includes(":") ? [p.name] : [p.name, ...db.tasks.filter((t) => t.extends === p.name).map((t) => t.name)]);
  const users = db.tasks.filter((t) => !gone.has(t.name)).flatMap((t) => t.triggers
    .filter((tr) => tr.type === "after" && tr.tasks.some((up) => gone.has(up))).map((tr) => `任务 ${t.name} 的联动 ${tr.id}`));
  if (users.length) throw new ApiError(409, "in_use", `任务 ${p.name} 正被使用：${users.slice(0, 8).join("、")}`, { used_by: users });
  const removed = [p.name, ...db.tasks.filter((t) => t.extends === p.name).map((t) => t.name)];
  for (const n of removed) db.tasks.splice(db.tasks.indexOf(findTask(n)), 1);
  return { deleted: removed };
});
on("GET", "/v1/tasks/:name/subtasks", (p) => db.tasks.filter((t) => t.extends === p.name).map(taskSummary));
const SUBTASK_FIELDS = ["title", "description", "profile", "input", "envs", "enabled"];
/** 新建子任务：只存它自己写的字段（与后端 SubtaskBody 一致），其余跟随父任务 */
function newSubtask(parent: Task, object: string, own: Record<string, unknown>, by: string, auto: boolean): Task {
  return { ...blankTask({ ...parent, ...own, name: `${parent.name}:${object}`, extends: parent.name, auto_created: auto }), updated_by: by, _own: Object.keys(own) } as MockTask;
}
const objectError = (o: string) => !o ? "对象名不能为空" : o.length > 120 ? "对象名不超过 120 个字符" : /[:\s/\\]/.test(o) ? "对象名不能含冒号、空白或斜杠" : null;
on("POST", "/v1/tasks/:name/subtasks", (p, _q, body) => {
  const parent = findTask(p.name);
  if (parent.extends) throw new ApiError(400, "invalid_subtask", `${p.name} 本身是子任务，不能再派生`);
  if (parent.form === "builtin") throw invalid(`${p.name} 是内建任务，不能建子任务`);
  const object = String(body.object || "").trim();
  if (objectError(object)) throw invalid(objectError(object)!);
  const name = `${p.name}:${object}`;
  if (db.tasks.some((t) => t.name === name)) throw new ApiError(409, "conflict", `子任务 ${name} 已存在`);
  const own = Object.fromEntries(Object.entries(body).filter(([k, v]) => SUBTASK_FIELDS.includes(k) && v != null));
  const t = newSubtask(parent, object, own, ME.name, false);
  db.tasks.push(t);
  return taskSummary(t);
});
// 与后端一致：父任务连同有自己定时的子任务；停用的不算
on("GET", "/v1/tasks/:name/schedule", (p) => {
  const t = findTask(p.name);
  return [t, ...db.tasks.filter((x) => x.extends === t.name && ownFields(x).includes("triggers"))]
    .filter((x) => effective(x).enabled && t.enabled).flatMap((x) => firesOf(effective(x))).sort((a, b) => a.at.localeCompare(b.at));
});

// ———————— 每个版本跑出来的效果（任务 / 角色 / 平台提示词；回归重放不算） ————————

function versionStats(versionOf: (r: db.MockRun) => number | null | undefined): VersionStat[] {
  const groups = new Map<number, db.MockRun[]>();
  for (const r of db.runs) {
    const v = versionOf(r);
    if (v == null || r.trigger.type === "replay") continue;
    groups.set(v, [...(groups.get(v) ?? []), r]);
  }
  const avg = (xs: (number | null)[]) => {
    const ys = xs.filter((x): x is number => x !== null);
    return ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : null;
  };
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([version, rs]) => {
    const at = rs.map((r) => r.created_at).sort();
    return {
      version, runs: rs.length, success: rs.filter((r) => r.status === "success").length, failed: rs.filter((r) => r.status === "failed").length,
      negative: rs.filter((r) => r.feedback.some((f) => f.score < 0)).length,
      avg_tokens: avg(rs.map((r) => r.tokens)), avg_ms: avg(rs.map((r) => r.duration_ms)), first_at: at[0], last_at: at[at.length - 1],
    };
  });
}
on("GET", "/v1/tasks/:name/version-stats", (p) => { findTask(p.name); return versionStats((r) => (r.task === p.name ? r.task_version : null)); });
on("GET", "/v1/roles/:name/version-stats", (p) => { findRole(p.name); return versionStats((r) => (r.role === p.name ? r.role_version : null)); });
on("GET", "/v1/settings/prompts/version-stats", () => versionStats((r) => r.recipe?.prompts));

// ———————— 版本历史（三种定义 + 设置各节） ————————

for (const [kind, find] of [["services", findService], ["roles", findRole], ["tasks", findTask]] as const) {
  on("GET", `/v1/${kind}/:name/versions`, (p) => versionsOf(`${kind}/${p.name}`, find(p.name) as unknown as Record<string, unknown>));
  on("POST", `/v1/${kind}/:name/versions/:v/restore`, (p) => {
    const item = find(p.name) as unknown as Ledgered;
    const old = versionsOf(`${kind}/${p.name}`, item as unknown as Record<string, unknown>).find((v) => v.version === Number(p.v));
    if (!old) throw notFound("版本 " + p.v);
    return bump(`${kind}/${p.name}`, item, old.definition as Partial<Ledgered>);
  });
}

// ———————— 运行 ————————

/** 失败原因码（与 detailOf 一致，不用拼整份详情） */
const errorCodeOf = (r: db.MockRun): string | null => r._error_code ?? (r.status === "cancelled" ? "cancelled"
  : r.status === "failed" ? String(db.eventsOf(r).find((e) => e.kind === "error")?.payload.title ?? "error") : null);
const listItem = (r: db.MockRun): RunListItem => {
  const { _events, _answer, _output, _error_code, _scenario, _priority, _queuedAt, _ckey, _climit, input: _i, output: _o, context: _c, feedback: _f, task_version: _tv, role_version: _rv, recipe: _rc, error_code: _e, memory: _m, replay_of: _ro, ...rest } = r;
  void _events; void _answer; void _output; void _error_code; void _scenario; void _priority; void _queuedAt; void _ckey; void _climit; void _i; void _o; void _c; void _f; void _tv; void _rv; void _rc; void _e; void _m; void _ro;
  return { ...rest, error_code: errorCodeOf(r) };
};
const findRun = (id: string) => db.runs.find((x) => x.run_id === id) ?? (() => { throw notFound("运行 " + id); })();

/** 前后关系里的一条运行（没查到的只有 run_id） */
const brief = (id: string): RunBrief => {
  const x = db.runs.find((y) => y.run_id === id);
  return x ? { run_id: x.run_id, status: x.status, task: x.task, task_title: x.task_title, env: x.env, summary: x.summary, retry_at: x.retry_at } : { run_id: id };
};
/** 与后端 views.run_detail 一致：列表字段 + 详情 + 前后关系 + 排队中的在等什么 */
function runDetail(r: db.MockRun): Run {
  const downstream = db.runs.filter((x) => (x.trigger.type === "after" && x.trigger.source === r.run_id) || x.depends_on.includes(r.run_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(listItem);
  return {
    ...db.detailOf(r), error_code: errorCodeOf(r),
    lineage: { triggered_by: r.trigger.type === "after" && r.trigger.source ? brief(r.trigger.source) : null, depends_on: r.depends_on.map(brief), downstream },
    queue: r.status === "queued" ? {
      waiting_for: r.depends_on.map((id) => db.runs.find((x) => x.run_id === id)).filter((x): x is db.MockRun => !!x && x.status !== "success")
        .map((x) => ({ run_id: x.run_id, status: x.status, task: x.task })),
      concurrency: r._climit ? { limit: r._climit, running: db.runs.filter((x) => x.status === "running" && x._ckey === r._ckey).length } : null,
      hosts: serving(r.env, r.service).map((w) => ({ host: w.host, running: w.running, max_concurrent: w.max_concurrent })),
      priority: r._priority ?? 1,
      since: r._queuedAt ?? r.created_at,
    } : null,
  };
}

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
on("GET", "/v1/runs/:id", (p) => runDetail(findRun(p.id)));
on("GET", "/v1/runs/:id/events", (p, q) => db.eventsOf(findRun(p.id)).filter((e) => !q.after || e.seq > Number(q.after)));
on("POST", "/v1/runs", (_p, _q, body) => submitRun(body, "web"));
/** 往运行的时间线后面接一条事件 */
function appendEvent(r: db.MockRun, kind: RunEvent["kind"], payload: RunEvent["payload"]) {
  const evs = db.eventsOf(r);
  r._events = [...evs, { seq: (evs[evs.length - 1]?.seq ?? 0) + 1, kind, at: now(), payload }];
}
on("POST", "/v1/runs/:id/cancel", (p) => {
  const r = findRun(p.id);
  // 与后端 submitter.cancel 一致：失败后正等着自动重试的，取消的是这次重试（运行就此失败，照常触发「失败后」的联动）
  if (r.status === "failed" && r.retry_at) {
    r.retry_at = null;
    appendEvent(r, "stage", { stage: "retry", title: `自动重试已取消（${ME.name}）` });
    return runDetail(r);
  }
  if (["success", "failed", "cancelled"].includes(r.status)) throw new ApiError(409, "already_finished", `运行已结束（${r.status}）`);
  // 落 cancelled、error_code=cancelled，时间线上一条 error 事件；点名等它的排队运行跟着不执行（调度循环里处理）
  const wasQueued = r.status === "queued";
  Object.assign(r, { status: "cancelled", finished_at: now(), _events: wasQueued ? [] : undefined, _error_code: "cancelled" });
  if (wasQueued) appendEvent(r, "error", { title: "cancelled", content: `被 ${ME.name} 取消（还没开始执行）` });
  return runDetail(r);
});
const TERMINAL = ["success", "failed", "cancelled"];
on("POST", "/v1/runs/:id/rerun", (p) => {
  const r = findRun(p.id);
  const [task, subtask] = r.task.split(":");
  const accepted = submitRun({ task, subtask, service: r.service, env: r.env, input: r.input, memory: r.memory }, "rerun");
  // 与后端 Submitter.rerun 一致：原运行还等着自动重试的，重试取消掉（不然同一份输入跑两遍），原运行就此算失败
  if (r.status === "failed" && r.retry_at) {
    r.retry_at = null;
    appendEvent(r, "stage", { stage: "retry", title: `自动重试已取消（${ME.name} 改为重跑 ${accepted.run_id.slice(0, 8)}）` });
  }
  return accepted;
});
/** 与后端 submitter.resume 一致：同一个 run_id 接着跑，事件接在后面（页面按 after=seq 增量取）；没走到 agent 的从头执行。
 *  auto：任务配置的自动重试发起的；人点续跑时顺手取消还在等的自动重试（attempt +1、retry_at 清掉） */
function resumeRun(r: db.MockRun, auto = false): RunAccepted {
  if (r.status !== "failed") throw new ApiError(409, "conflict", `只有失败的运行能续跑（当前 ${r.status}）`);
  if (errorCodeOf(r) === "upstream_failed") throw new ApiError(409, "conflict", "这次运行还没执行过（它等的上游失败了）：等上游成功后用重跑");
  const task = db.tasks.find((x) => x.name === r.task);
  if (!task || effective(task).form !== "agent") throw new ApiError(409, "conflict", "只有单角色任务支持续跑；内建任务请用重跑");
  if (r.resolution === "rule") throw new ApiError(409, "conflict", "规则命中的运行没有可续的步骤，请用重跑");
  const live = db.runs.find((x) => x.session_id === r.session_id && x !== r && !TERMINAL.includes(x.status));
  if (live) throw new ApiError(409, "conflict", `这个会话还有一轮在执行（${live.run_id.slice(0, 8)}），等它结束或先停止`);
  const prev = db.eventsOf(r);
  const started = prev.some((e) => e.kind === "model_call" || e.kind === "thought" || (e.kind === "stage" && e.payload.stage === "system"));
  const how = auto ? `自动重试（第 ${r.attempt + 1} 次执行）` : `续跑（${ME.name}）`;
  appendEvent(r, "stage", { stage: "resume", title: started ? how : `${how}；上次没走到 agent，从头开始` });
  Object.assign(r, { status: "running", finished_at: null, _error_code: undefined, duration_ms: null, attempt: r.attempt + 1, retry_at: null, _queuedAt: now() });
  settled.delete(r.run_id);
  setTimeout(() => {
    if (r.status !== "running") return;
    appendEvent(r, "model_call", { model: "kimi-k2.7-code", ms: 4200, input_tokens: 9800, output_tokens: 260, tokens: 10060, tool_calls: [], content: "接着上次的进度把结论整理出来。" });
    appendEvent(r, "final", { content: "（续跑）按上次查到的依据给出结论：上游分区晚到，重跑当日分区即可。" });
    Object.assign(r, { status: "success", resolution: "agent", finished_at: now() });
  }, 5000);
  return { run_id: r.run_id, session_id: r.session_id, status: "queued", output: null, dedup: false, subtask_created: null };
}
on("POST", "/v1/runs/:id/resume", (p) => resumeRun(findRun(p.id)));
on("POST", "/v1/runs/:id/correct", (p, _q, body) => {
  const r = findRun(p.id);
  if (!TERMINAL.includes(r.status)) throw new ApiError(409, "conflict", "运行还没结束，结束后再纠正");
  const live = db.runs.find((x) => x.session_id === r.session_id && !TERMINAL.includes(x.status));
  if (live) throw new ApiError(409, "conflict", `这个会话还有一轮在执行（${live.run_id.slice(0, 8)}），等它结束或先停止`);
  const [task, subtask] = r.task.split(":");
  return submitRun({ task, subtask, service: r.service, env: r.env, input: { ...r.input, question: `[纠正] ${body.text}` }, session_id: r.session_id, memory: r.memory }, "correction", false, r.run_id);
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

interface SubmitBody { task?: string | null; service?: string | null; env?: string | null; subtask?: string | null; input?: Record<string, unknown>; session_id?: string | null; memory?: object; after?: string[] }

/** 自动触发（定时 / 事件 / 上游联动）：服务×环境暂停了自动触发时不建运行 */
const AUTOMATIC = ["schedule", "event", "after"];
/** 认领顺序（与 domain/runs.PRIORITY 一致）：人在等的先跑 */
const PRIORITY: Record<string, number> = { chat: 0, web: 0, correction: 0, api: 1, rerun: 1, resume: 1, schedule: 2, event: 2, after: 2, replay: 2 };

/** 与后端 submitter._check_upstream 一致：点名的上游都要存在；已经失败 / 取消（且没在等自动重试）的直接拒 */
function checkUpstream(after: string[] | undefined): string[] {
  const wanted = [...new Set((after ?? []).map((a) => String(a).trim()).filter(Boolean))];
  if (wanted.length > 20) throw new ApiError(422, "invalid_request", "after 最多点名 20 个上游运行");
  const missing = wanted.filter((a) => !db.runs.some((r) => r.run_id === a));
  if (missing.length) throw new ApiError(404, "unknown_run", `点名等的运行不存在：${missing.join("、")}`);
  const dead = wanted.filter((a) => { const r = findRun(a); return (r.status === "failed" || r.status === "cancelled") && !r.retry_at; });
  if (dead.length) throw new ApiError(409, "upstream_failed", `点名等的运行已经失败或取消：${dead.join("、")}`);
  return wanted;
}

/** POST /v1/runs：task 不填 = 通用入口 ask。闸门：任务存在且启用、服务与环境启用、环境在任务允许的范围内、必填输入齐全 */
/** manual：调用方自己把运行收尾（对话的流式回答）；extra：上游联动建的运行带上 来源运行 / 调用身份 */
function submitRun(body: SubmitBody, trigger: string, manual = false, triggerId: string | null = null,
  extra: { source?: string; caller?: string } = {}): RunAccepted {
  const [base, inlineSub] = (body.task || "ask").split(":");
  const parent = db.tasks.find((x) => x.name === base);
  if (!parent) throw new ApiError(404, "unknown_task", `任务 ${base} 不存在`);
  const input = { ...(body.input ?? {}) };
  // 与后端 submitter 一致：没点名对象、但任务声明了对象字段 → 按这个字段的值落到对应子任务；点名了对象 → 对象字段自动填上
  const derived = !body.subtask && !inlineSub && parent.object_input && typeof input[parent.object_input] === "string" && !objectError(String(input[parent.object_input]).trim())
    ? String(input[parent.object_input]).trim() : "";
  const object = body.subtask || inlineSub || derived;
  if (object && parent.form === "builtin") throw new ApiError(400, "invalid_subtask", `${base} 是内建任务，没有子任务`);
  if (object && objectError(object)) throw new ApiError(400, "invalid_subtask", objectError(object)!);
  if (object && parent.object_input && !input[parent.object_input]) input[parent.object_input] = object;
  const name = object ? `${base}:${object}` : base;
  const existing = object ? db.tasks.find((x) => x.name === name) : undefined;
  // 闸门按生效定义判断：已有的子任务用它合并后的（可能有自己的环境、停用），新对象用父任务的
  const t = existing ? effective(existing) : parent;
  if (body.session_id && trigger === "chat") {
    const live = db.runs.find((r) => r.session_id === body.session_id && (r.status === "running" || r.status === "queued"));
    if (live) throw new ApiError(409, "conflict", `这个会话还有一轮在执行（${live.run_id.slice(0, 8)}），等它结束或先停止`);
  }
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
  if (!t.enabled) throw new ApiError(400, "task_disabled", `任务 ${name} 已停用`);
  if (existing && !parent.enabled) throw new ApiError(400, "task_disabled", `父任务 ${base} 已停用`);
  if (t.envs.length && !t.envs.includes(env)) throw new ApiError(400, "env_not_allowed", `任务 ${name} 不能在 ${env} 运行（允许：${t.envs.join("、")}）`);
  if (AUTOMATIC.includes(trigger) && svc?.envs[env]?.triggers_paused)
    throw new ApiError(409, "triggers_paused", `服务 ${service} 在 ${env} 暂停了自动触发（定时、事件、上游联动）`);
  const dependsOn = checkUpstream(body.after);
  // 与后端 TaskDef.validate_input 一致：没给就用默认值，null / 空串都算没填；类型也查
  const problems = Object.entries(t.input).flatMap(([k, f]) => {
    const v = k in input ? input[k] : f.default;
    if (v == null || v === "") return f.required ? [`${k} 必填`] : [];
    if (f.type === "int" && !(Number.isInteger(v) || (typeof v === "string" && /^-?\d+$/.test(v)))) return [`${k} 需要整数`];
    if (f.type === "bool" && typeof v !== "boolean") return [`${k} 需要 true/false`];
    if (f.type === "enum" && f.options?.length && !f.options.includes(String(v))) return [`${k} 取值须为 ${f.options.join("/")}`];
    return [];
  });
  if (problems.length) throw new ApiError(400, "invalid_input", "输入不合法：" + problems.join("；"));
  for (const [k, f] of Object.entries(t.input)) if (!(k in input) && f.default != null) input[k] = f.default;
  let created: string | null = null;
  if (object && !existing) {
    db.tasks.push(newSubtask(parent, object, {}, "auto:" + ME.name, true));
    created = name;
  }
  const run_id = db.hex(12);
  const session_id = body.session_id || run_id;
  const run: db.MockRun = {
    run_id, session_id, task: name, task_title: parent.title, service: service ?? null, env, role: t.role, status: manual ? "running" : "queued", resolution: null,
    trigger: { type: trigger as "web", id: triggerId, source: extra.source ?? null, caller: extra.caller ?? ME.name },
    summary: String(input.question ?? Object.values(input)[0] ?? t.title), tokens: null, duration_ms: null,
    created_at: now(), finished_at: null, task_version: db.tasks.find((x) => x.name === name)?.version ?? t.version,
    role_version: db.roles.find((r) => r.name === t.role)?.version ?? null, recipe: null,
    replay_of: null, input, output: null, error_code: null, memory: body.memory ?? {},
    attempt: 1, retry_at: null, depends_on: dependsOn,
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
    feedback: [],
    // 任务并发：同一个环境里（连同子任务）最多同时执行几个
    _priority: PRIORITY[trigger] ?? 1, _ckey: t.concurrency ? `${base}@${env}` : undefined, _climit: t.concurrency ?? undefined,
  };
  run.recipe = db.recipeOf(run, 0);
  db.runs.unshift(run);
  if (!manual && claimable(run)) startRun(run);
  return { run_id, session_id, status: "queued", output: null, dedup: false, subtask_created: created };
}

// ———————— 调度：认领、上游联动、点名等的上游、自动重试（与 orchestration/chain.py、scheduler.retry_due 一致） ————————

/** 在线、负责这个环境（和服务）的主机：env 为空的什么都认领 */
const serving = (env: string, service: string | null) => workersNow().filter((w) => w.online && (!w.env || w.env === env)
  && (!service || !w.services.length || w.services.includes(service)));
function workersNow() {
  return db.workers.map((w) => {
    const running = w.online ? db.runs.filter((r) => r.status === "running" && (!w.env || r.env === w.env) && (!w.services.length || w.services.includes(r.service ?? ""))).length : 0;
    return { ...w, running: Math.min(running, w.max_concurrent), seen_at: w.online ? new Date(Date.now() - 2000 - Math.random() * 15000).toISOString() : w.seen_at };
  });
}

/** 服务在这个环境暂停了自动触发 */
const paused = (service: string | null, env: string) => !!db.services.find((s) => s.name === service)?.envs[env]?.triggers_paused;

/** 排着队的能不能开始：点名的上游都成功了、任务并发没满、有在线的主机负责；暂停了自动触发的那里，自动触发建的先不认领 */
function claimable(r: db.MockRun): boolean {
  if (AUTOMATIC.includes(r.trigger.type) && paused(r.service, r.env)) return false;
  if (r.depends_on.some((id) => db.runs.find((x) => x.run_id === id)?.status !== "success")) return false;
  if (r._climit && db.runs.filter((x) => x.status === "running" && x._ckey === r._ckey).length >= r._climit) return false;
  return serving(r.env, r.service).length > 0;
}

/** 认领：开始执行，6.5 秒后按任务形态收尾 */
function startRun(run: db.MockRun) {
  const builtin = db.tasks.find((x) => x.name === run.task.split(":")[0])?.form === "builtin";
  Object.assign(run, { status: "running", _events: undefined });
  setTimeout(() => { if (run.status === "running") Object.assign(run, builtin
    ? { status: "success", resolution: "builtin", duration_ms: 6400, tokens: 0, finished_at: now(), _events: undefined, _output: { env: run.env, drift_expired: 0 } }
    : { status: "success", resolution: "agent", duration_ms: 6400, tokens: 8120, finished_at: now(), _events: undefined }); }, 6500);
}

function addTick(t: Omit<Tick, "id" | "at" | "detail"> & { detail?: Tick["detail"] }) {
  db.ticks.unshift({ id: db.nextTickId(), at: now(), detail: null, ...t });
}

/** 上游联动能引用的扁平字段（与 domain/tasks.run_fields 一致） */
function runFields(r: db.MockRun, prefix = ""): Record<string, unknown> {
  const output = db.detailOf(r).output ?? {};
  const out: Record<string, unknown> = { run_id: r.run_id, task: r.task, env: r.env, service: r.service, status: r.status, error_code: errorCodeOf(r),
    caller: r.trigger.caller, error: output.error, "output.answer": output.answer };
  for (const [k, v] of Object.entries(r.input)) out[`input.${k}`] = v;
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === "object" && !Array.isArray(node)) for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    else out[path] = node;
  };
  if (output.data && typeof output.data === "object") walk(output.data, "output.data");
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null).map(([k, v]) => [prefix + k, v]));
}

const watches = (tr: AfterTrigger, task: string) => tr.tasks.includes(task) || tr.tasks.includes(task.split(":")[0]);
/** 声明了「在它结束后跑」的任务（子任务要自己写了 triggers 才算） */
const listeners = (task: string) => db.tasks.filter((t) => !t.extends || ownFields(t).includes("triggers"))
  .flatMap((t) => effective(t).triggers.filter((tr): tr is AfterTrigger => tr.type === "after" && tr.enabled !== false && watches(tr, task) && t.name !== task)
    .map((tr) => [t.name, tr] as const));
/** 这次运行在联动链上的第几层 */
function depthOf(r: db.MockRun): number {
  let depth = 0, cur: db.MockRun | undefined = r;
  while (cur && cur.trigger.type === "after" && cur.trigger.source && depth < 50) { depth++; cur = db.runs.find((x) => x.run_id === cur!.trigger.source); }
  return depth;
}
const MAX_DEPTH = 5;
const afterKeys = new Set<string>();

function considerAfter(r: db.MockRun, depth: number, down: string, tr: AfterTrigger) {
  const key = `after:${r.run_id}:${r.status}:${down}:${tr.id}`;
  if (afterKeys.has(key)) return;
  afterKeys.add(key);
  const common = { kind: "after" as const, task: down, trigger_id: tr.id, env: r.env, source: r.run_id, run_id: null };
  const fields = runFields(r);
  const accepts = Object.entries(tr.filter ?? {}).every(([f, pattern]) => { try { return new RegExp(pattern, "i").test(String(fields[f] ?? "")); } catch { return false; } });
  if (!accepts) return addTick({ ...common, outcome: "filtered", reason: `上游 ${r.task} 的这次运行不满足过滤条件`, detail: { filter: tr.filter ?? {} } });
  if (depth >= MAX_DEPTH) return addTick({ ...common, outcome: "rejected", reason: `联动已经 ${depth} 层，超过 ${MAX_DEPTH} 层不再往下触发` });
  const values: Record<string, unknown> = { ...fields };
  if (tr.mode === "all") {
    const window = tr.window_s ?? 86400;
    // 下游按对象字段落到子任务时运行记在「任务:对象」上：连同子任务一起算（与 store/runs.last_after_fire 一致）
    const lastFire = db.runs.filter((x) => (x.task === down || x.task.startsWith(down + ":")) && x.trigger.type === "after" && x.trigger.id === tr.id && x.env === r.env).map((x) => x.created_at).sort().pop();
    const since = [new Date(Date.now() - window * 1000).toISOString(), lastFire ?? ""].sort().pop()!;
    const missing: string[] = [];
    for (const up of tr.tasks) {
      if (r.task === up || r.task.split(":")[0] === up) { Object.assign(values, runFields(r, `${up}.`)); continue; }
      const other = db.runs.filter((x) => (x.task === up || x.task.startsWith(up + ":")) && x.env === r.env && (tr.on as string[]).includes(x.status)
        && x.trigger.type !== "replay" && !x.retry_at && (x.finished_at ?? "") > since).sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? ""))[0];
      if (other) Object.assign(values, runFields(other, `${up}.`));
      else missing.push(up);
    }
    if (missing.length) {
      const span = window >= 3600 && window % 3600 === 0 ? `${window / 3600} 小时` : `${Math.round(window / 60)} 分钟`;
      return addTick({ ...common, outcome: "waiting", reason: `还在等 ${missing.join("、")} 结束（${span}内）`, detail: { have: tr.tasks.filter((u) => !missing.includes(u)) } });
    }
  }
  const target = db.tasks.find((x) => x.name === down);
  if (!target) return;
  const spec = effective(target);
  const input = tr.map && Object.keys(tr.map).length
    ? Object.fromEntries(Object.entries(tr.map).filter(([, path]) => values[path] != null).map(([k, path]) => [k, values[path]]))
    : Object.fromEntries(Object.entries(r.input).filter(([k]) => k in spec.input));
  const [base, obj] = down.split(":");
  try {
    const accepted = submitRun({ task: base, subtask: obj ?? null, env: r.env, service: spec.service === "*" ? tr.service || r.service : null, input }, "after", false, tr.id,
      { source: r.run_id, caller: r.trigger.caller });
    addTick({ ...common, outcome: "fired", run_id: accepted.run_id, reason: `上游 ${r.task} ${r.status === "success" ? "成功" : "失败"}` });
  } catch (e) {
    const err = e as ApiError;
    addTick({ ...common, outcome: "rejected", reason: err.message, detail: { code: err.code } });
  }
}

/** 一次运行最终结束（失败后还要自动重试的不算）：点名等它的排队运行、上游联动 */
function onFinished(r: db.MockRun) {
  if (r.trigger.type === "replay") return;
  if (r.status !== "success") {
    const what = r.status === "failed" ? "失败" : "被取消";
    const reason = `点名等的上游运行 ${r.run_id.slice(0, 8)}（${r.task}）${what}了，这次没有执行`;
    for (const d of db.runs.filter((x) => x.status === "queued" && x.depends_on.includes(r.run_id))) {
      Object.assign(d, { status: "failed", finished_at: now(), _error_code: "upstream_failed", _events: [] });
      appendEvent(d, "error", { title: "upstream_failed", content: reason });
    }
  }
  if (r.status !== "success" && r.status !== "failed") return;
  const depth = depthOf(r);
  for (const [down, tr] of listeners(r.task)) if ((tr.on as string[]).includes(r.status)) considerAfter(r, depth, down, tr);
}

/** 已经处理过结束的运行（启动时的历史运行都算处理过，不往回补联动） */
const settled = new Set(db.runs.filter((r) => TERMINAL.includes(r.status) && !r.retry_at).map((r) => r.run_id));
setInterval(() => {
  // 到点的自动重试 → 续跑；开始不了的按最终失败收尾
  for (const r of db.runs.filter((x) => x.status === "failed" && x.retry_at && x.retry_at <= now())) {
    const common = { kind: "retry" as const, task: r.task, trigger_id: null, env: r.env, source: r.run_id, run_id: r.run_id };
    const attempt = r.attempt;
    // 与后端 scheduler._retry_one 一致：暂停了自动触发的，顺延 5 分钟
    if (paused(r.service, r.env)) {
      r.retry_at = new Date(Date.now() + 300_000).toISOString();
      addTick({ ...common, outcome: "skipped", reason: `服务 ${r.service} 在 ${r.env} 暂停了自动触发，重试顺延` });
      continue;
    }
    try {
      resumeRun(r, true);
      addTick({ ...common, outcome: "fired", reason: `第 ${attempt} 次执行失败后自动重试` });
    } catch (e) {
      r.retry_at = null;
      appendEvent(r, "stage", { stage: "retry", title: "自动重试没能开始", content: (e as Error).message });
      addTick({ ...common, outcome: "rejected", reason: (e as Error).message, detail: { code: (e as ApiError).code } });
    }
  }
  for (const r of [...db.runs]) {
    if (!TERMINAL.includes(r.status) || settled.has(r.run_id) || (r.status === "failed" && r.retry_at)) continue;
    settled.add(r.run_id);
    onFinished(r);
  }
  // 认领：优先级高的、早的先
  for (const r of db.runs.filter((x) => x.status === "queued").sort((a, b) => (a._priority ?? 1) - (b._priority ?? 1) || a.created_at.localeCompare(b.created_at)))
    if (claimable(r)) startRun(r);
}, 1000);

// ———————— 回归重放 ————————
// 拿被 👎 的 agent 运行用当前定义重跑（新会话、不沉淀、不投递），重放结束后模型对照判定（mock：确定性地给判定）

const answerOf = (r: db.MockRun) => { const o = db.detailOf(r).output; return o?.answer ?? o?.error ?? null; };

const disliked = (r: db.MockRun) => r.feedback.some((x) => x.score < 0);
/** agent 运行：有角色、不是规则命中 / 内建（失败的 agent 运行 resolution 是空的） */
const agentRun = (r: db.MockRun) => !!r.role && (r.resolution ?? "agent") === "agent" && r.trigger.type !== "replay";

function replayItemOf(it: db.MockReplayItem): ReplayItem {
  const src = findRun(it.source_run);
  const next = it.new_run ? db.runs.find((r) => r.run_id === it.new_run) : undefined;
  return {
    id: it.id, source_run: it.source_run, new_run: it.new_run, verdict: it.verdict, reason: it.reason, judged_at: it.judged_at,
    task: src.task, service: src.service, env: src.env, summary: src.summary, negative: disliked(src),
    before: { task_version: src.task_version, role_version: src.role_version, recipe: src.recipe, answer: answerOf(src), status: src.status },
    after: next ? { task_version: next.task_version, role_version: next.role_version, recipe: next.recipe, answer: answerOf(next), status: next.status }
      : { task_version: null, role_version: null, recipe: null, answer: null, status: null },
  };
}

function replaySummaryOf(r: db.MockReplay): ReplaySummary {
  const n = (v: ReplayVerdict | null) => r.items.filter((i) => i.verdict === v).length;
  return {
    id: r.id, title: r.title, filter: r.filter, note: r.note, created_by: r.created_by, created_at: r.created_at,
    regression: r.items.some((i) => !disliked(findRun(i.source_run))),
    counts: { total: r.items.length, fixed: n("fixed"), same: n("same"), worse: n("worse"), unclear: n("unclear") + n("error"), pending: n(null) },
  };
}
const replayDetailOf = (r: db.MockReplay): ReplayDetail => ({ ...replaySummaryOf(r), items: r.items.map(replayItemOf) });
const findReplay = (id: string) => db.replays.find((r) => r.id === Number(id)) ?? (() => { throw notFound("回归重放 " + id); })();

const JUDGE: Record<Exclude<ReplayVerdict, "error">, string> = {
  fixed: "新答案在被指出的问题上已经改对，也没有引入明显的新错误。",
  same: "被指出的问题还在：新答案沿用了原来的口径。",
  worse: "问题还在，而且新答案引入了新的错误。",
  unclear: "要看实际数据才能确认新答案是否正确。",
};

/** 判定一条（重放运行已结束才判）：没成功结束 → 原运行成功则 worse 否则 same；其余按运行 id 确定性地给 */
const JUDGE_REGRESSION: Record<Exclude<ReplayVerdict, "error">, string> = {
  fixed: "新答案结论与原答案一致，依据更充分（多给了 SQL 与时间范围）。",
  same: "新答案与原答案结论一致、质量相当，没有退步。",
  worse: "新答案的结论和原答案矛盾，又没给出更充分的依据。",
  unclear: "要看实际数据才能确认哪个答案对。",
};

function judgeItem(it: db.MockReplayItem) {
  const next = it.new_run ? db.runs.find((r) => r.run_id === it.new_run) : undefined;
  if (!next || !["success", "failed", "cancelled"].includes(next.status)) return;
  it._attempts = (it._attempts ?? 0) + 1;
  const src = findRun(it.source_run);
  let verdict: Exclude<ReplayVerdict, "error">;
  let reason: string;
  if (next.status !== "success") {
    verdict = src.status === "success" ? "worse" : "same";
    reason = `重放没有成功结束：${answerOf(next) ?? next.status}`.slice(0, 500);
  } else if (!disliked(src)) {
    verdict = (["same", "same", "fixed", "worse"] as const)[(next.run_id.charCodeAt(0) + it._attempts) % 4];
    reason = JUDGE_REGRESSION[verdict];
  } else {
    verdict = (["fixed", "fixed", "same", "unclear"] as const)[(next.run_id.charCodeAt(0) + it._attempts) % 4];
    reason = JUDGE[verdict];
  }
  Object.assign(it, { verdict, reason, judged_at: now() });
}

/** 重放运行 6~9 秒后结束并判定 */
function finishLater(it: db.MockReplayItem, delay = 6000 + Math.random() * 3000) {
  setTimeout(() => {
    const next = it.new_run ? db.runs.find((r) => r.run_id === it.new_run) : undefined;
    if (next && next.status === "running") Object.assign(next, { status: "success", resolution: "agent", duration_ms: 7200, tokens: 9400, finished_at: now(), _events: undefined });
    judgeItem(it);
  }, delay);
}
// 样例里"判定中"的那条：预览打开后几秒内跑完
for (const r of db.replays) for (const it of r.items) if (it.verdict === null) finishLater(it, 8000);

/** 被 👎 过（整次或某一步）的 agent 运行，最近被评的在前（不含重放运行本身） */
/** 最近结束的 agent 运行（不限 👎），新的在前 */
function recentRuns(f: ReplayFilter): string[] {
  return db.runs
    .filter((r) => agentRun(r) && (r.status === "success" || r.status === "failed")
      && (!f.service || r.service === f.service) && (!f.env || r.env === f.env) && taskMatch(f.task, r.task)
      && (!f.hours || within(r.created_at, Number(f.hours))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Math.max(1, Math.min(100, f.limit ?? 20))).map((r) => r.run_id);
}

function negativeRuns(f: ReplayFilter): string[] {
  return db.runs
    .filter((r) => agentRun(r) && !["queued", "running"].includes(r.status) && disliked(r)
      && (!f.service || r.service === f.service) && (!f.env || r.env === f.env) && taskMatch(f.task, r.task)
      && (!f.hours || r.feedback.some((x) => x.score < 0 && within(x.updated_at, Number(f.hours)))))
    .map((r) => ({ id: r.run_id, at: r.feedback.filter((x) => x.score < 0).map((x) => x.updated_at).sort().pop() ?? "" }))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(1, Math.min(100, f.limit ?? 20))).map((x) => x.id);
}

on("GET", "/v1/replays", (_p, q) => [...db.replays].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Number(q.limit) || 50).map(replaySummaryOf));
on("POST", "/v1/replays", (_p, _q, body) => {
  const limit = Number(body.limit ?? 20);
  const named = !!body.run_ids?.length;
  const negativeOnly = body.negative_only !== false;
  const filter: ReplayFilter = Object.fromEntries(Object.entries({ run_ids: named ? body.run_ids : undefined, task: body.task, service: body.service, env: body.env, hours: body.hours, limit,
    negative_only: !named && !negativeOnly ? false : undefined })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")) as ReplayFilter;
  const sources: string[] = named ? [...new Set<string>(body.run_ids)] : negativeOnly ? negativeRuns(filter) : recentRuns(filter);
  if (!sources.length) throw new ApiError(400, "nothing_to_replay", negativeOnly ? "没有符合条件的被 👎 的运行" : "没有符合条件的 agent 运行");
  for (const id of sources) findRun(id);          // 点名的运行要存在
  const scope = [body.task, body.service, body.env].filter(Boolean).join(" · ") || "全部";
  const replay: db.MockReplay = {
    id: Math.max(0, ...db.replays.map((r) => r.id)) + 1, title: String(body.title || (named ? `指定的 ${sources.length} 条运行` : `${scope} · ${sources.length} 条${negativeOnly ? "👎" : "最近运行"}`)), filter,
    note: String(body.note ?? ""), created_by: ME.name, created_at: now(), items: [],
  };
  for (const runId of sources) {
    const item: db.MockReplayItem = { id: db.nextReplayItemId(), source_run: runId, new_run: null, verdict: null, reason: "", judged_at: null };
    replay.items.push(item);
    // 与提交同样过开关：原运行不在了、任务停用、服务在该环境停用 → 这一条没建成（error）
    const src = db.runs.find((r) => r.run_id === runId);
    const task = src && db.tasks.find((t) => t.name === src.task.split(":")[0]);
    const svc = src?.service ? db.services.find((s) => s.name === src.service) : undefined;
    const why = !src ? `运行 ${runId} 不存在` : src.trigger.type === "replay" ? "这是重放出来的运行，请重放它的原运行"
      : !agentRun(src) || ["queued", "running"].includes(src.status) ? "只能重放已经结束的 agent 运行（内建任务、规则命中、还在跑的不行）"
      : !task ? `任务 ${src.task} 已不存在` : !task.enabled ? `任务 ${task.name} 已停用`
      : svc && !envEnabled(svc, src.env) ? `服务 ${svc.name} 在 ${src.env} 环境已停用` : null;
    if (why || !src) { Object.assign(item, { verdict: "error", reason: why, judged_at: now() }); continue; }
    const run = db.replayRunOf(src, now(), "running", ME.name);
    db.runs.unshift(run);
    item.new_run = run.run_id;
    finishLater(item);
  }
  db.replays.unshift(replay);
  return replayDetailOf(replay);
});
on("GET", "/v1/replays/:id", (p) => replayDetailOf(findReplay(p.id)));
on("POST", "/v1/replays/:id/judge", (p) => {
  const r = findReplay(p.id);
  for (const it of r.items) if (it.new_run && (it.verdict === null || it.verdict === "unclear")) judgeItem(it);
  return replayDetailOf(r);
});

// ———————— 对话 ————————

on("GET", "/v1/sessions", (_p, q) => db.sessionsList()
  .filter((s) => (!q.service || s.service === q.service) && (!q.env || s.env === q.env) && (!q.task || s.task.split(":")[0] === q.task)
    && (!q.q || s.title.includes(String(q.q)) || s.turns.some((t) => t.question.includes(String(q.q)))))
  .map(({ turns: _t, ...s }) => { void _t; return s; }));
on("GET", "/v1/sessions/:id", (p) => db.sessionDetail(p.id) ?? (() => { throw notFound("会话"); })());

// ———————— 记忆 ————————

const taskMatch = (wanted: unknown, task: string) => !wanted || task === wanted || task.startsWith(wanted + ":");

/** env 过滤 = 对该环境成立的：该环境自己的 + 所有环境通用的（env=""）；env="*" 只看通用的 */
const envMatch = (wanted: unknown, env: string) => !wanted || (wanted === "*" ? env === "" : env === "" || env === wanted);
/** kind 不给 = 事实与教训（交接摘要是会话内部用的） */
const kindMatch = (wanted: unknown, kind: Knowledge["kind"]) => (wanted ? kind === wanted : kind !== "handoff");

/** status：空 = 生效中；negative = 生效中且挨过 👎（feedback_score < 0）；all = 全部；其余按状态精确匹配 */
const statusMatch = (wanted: unknown, k: Knowledge) =>
  wanted === "all" || (wanted === "negative" ? k.status === "active" && k.feedback_score < 0 : wanted ? k.status === wanted : k.status === "active");

on("GET", "/v1/knowledge", (_p, q) => db.knowledge.filter((k) =>
  (!q.service || k.service === q.service) && envMatch(q.env, k.env) && taskMatch(q.task, k.task) && kindMatch(q.kind, k.kind)
  && statusMatch(q.status, k)
  && (!q.q || k.key.includes(String(q.q)) || k.content.includes(String(q.q))))
  .sort((a, b) => a.service.localeCompare(b.service) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)));
on("GET", "/v1/knowledge/promotable", (_p, q) => db.knowledge
  .filter((k) => db.isPromotable(k) && (!q.service || k.service === q.service) && envMatch(q.env, k.env))
  .sort((a, b) => b.hits_30d - a.hits_30d).slice(0, 30));
const findKnowledge = (id: string) => db.knowledge.find((x) => x.id === Number(id)) ?? (() => { throw notFound("记忆 " + id); })();
on("GET", "/v1/knowledge/:id", (p) => findKnowledge(p.id));
on("GET", "/v1/knowledge/:id/history", (p) => {
  const k = findKnowledge(p.id);
  return [{ version: 2, content: k.content.replace(/；.*$/, "。"), source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 5 * 24 * H).toISOString() }, { version: 1, content: k.content.slice(0, 18) + "…", source: "upsert:" + db.hex(8), created_at: new Date(Date.now() - 12 * 24 * H).toISOString() }];
});

/** 报错指纹（mock）：抹掉数字、引号里的内容、路径行号后取末两行做哈希，同类报错指纹一致 */
function fingerprint(error: string): string {
  let text = error.trim().split("\n").slice(-2).join("\n");
  text = text.replace(/[\w./\\-]+\.(py|sql|yaml|yml|json|js|ts):\d+/g, "<file:line>").replace(/0x[0-9a-fA-F]+/g, "0x?")
    .replace(/\b\d+\b/g, "?").replace(/'[^']*'/g, "'?'").replace(/"[^"]*"/g, '"?"');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) { h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619); h2 = Math.imul(h2 + text.charCodeAt(i), 2246822519); }
  return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0")).slice(0, 16);
}

on("POST", "/v1/knowledge", (_p, _q, body) => {
  findService(body.service);
  const env = String(body.env ?? "");
  const kind = body.kind === "lesson" ? "lesson" : "fact";
  const where = env || "所有环境";
  const base = { service: body.service, env, task: body.task ?? "", source_run: null, code_ref: null, status: "active" as const, superseded_by: null, feedback_score: 0, hits_30d: 0, last_hit_at: null, updated_at: now() };
  if (kind === "lesson") {
    const error = String(body.error ?? "").trim();
    if (!error) throw new ApiError(400, "invalid_input", "教训要给报错原文（error），按它算指纹，同类报错才能命中");
    const fp = fingerprint(error);
    const key = `lesson:${fp}`;
    const lastLine = error.split("\n").reverse().find((l) => l.trim())?.trim().slice(0, 200) ?? "";
    const content = lastLine ? `${body.content}\n（报错：${lastLine}）` : body.content;
    const old = db.knowledge.find((k) => k.service === body.service && k.env === env && k.key === key);
    if (old) return Object.assign(old, { content, category: body.category || "code", task: body.task ?? old.task, status: "active", superseded_by: null, updated_at: now() });
    const k: Knowledge = { ...base, id: Math.max(...db.knowledge.map((x) => x.id)) + 1, kind, key, content, fingerprint: fp, category: body.category || "code" };
    db.knowledge.unshift(k);
    return k;
  }
  if (!String(body.key ?? "").trim()) throw new ApiError(400, "invalid_input", "事实要给 key（如 metric:account_pnl）");
  if (db.knowledge.some((k) => k.service === body.service && k.env === env && k.key === body.key)) throw new ApiError(409, "conflict", `${body.service}（${where}）已有记忆 ${body.key}，请直接编辑`);
  const k: Knowledge = { ...base, id: Math.max(...db.knowledge.map((x) => x.id)) + 1, kind, key: body.key, content: body.content, fingerprint: null, category: null };
  db.knowledge.unshift(k);
  return k;
});
on("PATCH", "/v1/knowledge/:id", (p, _q, body) => {
  const k = findKnowledge(p.id);
  if (body.content !== undefined) Object.assign(k, { content: body.content, updated_at: now() });
  if (body.status === "expired") Object.assign(k, { status: "expired" });
  else if (body.status === "active") Object.assign(k, { status: "active", superseded_by: null });
  return k;
});
on("DELETE", "/v1/knowledge/:id", (p) => Object.assign(findKnowledge(p.id), { status: "expired", updated_at: now() }));

/** 同一个键已有内容就接在后面（已经包含就不重复）——与后端 _merged 一致 */
const mergedProfile = (profile: Record<string, string>, key: string, text: string) => {
  const old = String(profile[key] ?? "").trim();
  return { ...profile, [key]: !old ? text : old.includes(text) ? old : `${old}；${text}` };
};

/** 升格进档案：写进服务档案（条目只在某环境成立时写进该环境的覆盖）或任务档案，原条目标为被取代 */
on("POST", "/v1/knowledge/:id/promote", (p, _q, body) => {
  const e = findKnowledge(p.id);
  if (e.status !== "active") throw new ApiError(409, "conflict", "只有生效中的记忆能升格");
  const key = String(body.key ?? "").trim();
  if (!key || key.length > 60) throw new ApiError(422, "invalid_request", "档案的键不能为空，且不超过 60 个字符");
  const text = String(body.content || e.content).trim();
  let where: string;
  if (body.target === "service") {
    const s = findService(e.service);
    if (e.env) {
      const override = { ...(s.envs[e.env] ?? {}) };
      override.profile = mergedProfile(override.profile ?? {}, key, text);
      bump("services/" + s.name, s, { envs: { ...s.envs, [e.env]: override } });
    } else {
      bump("services/" + s.name, s, { profile: mergedProfile(s.profile, key, text) });
    }
    where = `service:${s.name}` + (e.env ? `@${e.env}` : "");
  } else {
    const taskName = String(body.task || e.task);
    if (!taskName) throw new ApiError(400, "invalid_input", "这条记忆没有来源任务，请指定写进哪个任务（task）");
    const t = findTask(taskName);
    bump("tasks/" + t.name, t, { profile: mergedProfile(t.profile, key, text) });
    where = `task:${t.name}`;
  }
  Object.assign(e, { status: "superseded", superseded_by: `profile:${where}:${key}` });
  return { entry: e, profile: { target: where, key } };
});

const findAsset = (id: string) => db.assetList.find((x) => x.id === Number(id)) ?? (() => { throw notFound("方法 " + id); })();
/** q：名字、摘要、内容里不分大小写地找（与后端 ILIKE 一致） */
const assetHit = (a: Asset, q: unknown) => {
  const term = String(q ?? "").trim().toLowerCase();
  return !term || (a.name + "\n" + a.summary + "\n" + a.content).toLowerCase().includes(term);
};
on("GET", "/v1/assets", (_p, q) => db.assetList.filter((a) => (!q.service || a.service === q.service) && (!q.env || a.env === q.env)
  && (!q.kind || a.kind === q.kind) && taskMatch(q.task, a.task) && (!q.status || q.status === "all" || a.status === q.status) && assetHit(a, q.q)));
on("POST", "/v1/assets", (_p, _q, body) => {
  const a: Asset = { id: Math.max(...db.assetList.map((x) => x.id)) + 1, files: [], source_run: null, use_count: 0, last_used_at: null, feedback_score: 0, status: "active", updated_at: now(), task: "", ...body };
  db.assetList.unshift(a);
  return a;
});
on("PATCH", "/v1/assets/:id", (p, _q, body) => Object.assign(findAsset(p.id), body, { updated_at: now() }));
on("DELETE", "/v1/assets/:id", (p) => Object.assign(findAsset(p.id), { status: "superseded", updated_at: now() }));

// ———————— 设置 ————————

const SECTIONS: ConfigSection[] = ["envs", "notifications", "memory", "prompts"];

/** 提示词模板段 → 可用占位（与 domain/prompts.PLACEHOLDERS 一致）：去掉 {{ }} 后只能剩认识的 {名字} */
const PLACEHOLDERS: Record<string, string[]> = {
  compaction: ["messages"], distill: ["service", "env", "task", "input", "output"],
  handoff_summary: ["task", "input", "output"], replay_judge: ["task", "where", "input", "old", "issues", "new"],
};
function checkPrompts(body: Record<string, unknown>) {
  for (const key of ["base", "subagent"]) if (!String(body[key] ?? "").trim()) throw new ApiError(422, "invalid_definition", `prompts.${key}：不能为空`);
  for (const [key, keys] of Object.entries(PLACEHOLDERS)) {
    const text = String(body[key] ?? "").replaceAll("{{", "").replaceAll("}}", "");
    const hint = `可用：${keys.map((k) => `{${k}}`).join("、")}；字面花括号写成 {{ }}`;
    const unknown = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]).find((k) => !keys.includes(k));
    if (unknown !== undefined) throw new ApiError(422, "invalid_definition", `prompts.${key}：占位 '${unknown}' 不认识（${hint}）`);
    if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ""))) throw new ApiError(422, "invalid_definition", `prompts.${key}：模板格式不对，有落单的花括号（${hint}）`);
  }
  if (!String(body.compaction ?? "").includes("{messages}")) throw new ApiError(422, "invalid_definition", "prompts.compaction：压缩提示必须包含 {messages}（要压缩的历史放在这里）");
}
/** 渠道 token 不回显（与后端 settings._masked 一致）；保存时传回 *** 表示不改 */
function masked<T>(section: string, body: T): T {
  if (section !== "notifications") return body;
  const b = structuredClone(body) as { channels?: Record<string, { token?: string }> };
  for (const ch of Object.values(b.channels ?? {})) if (ch.token) ch.token = "***";
  return b as T;
}
/** 环境一节的校验（与后端 EnvDef / EnvsConfig 一致） */
function checkEnvs(body: { items: { name: string }[]; default: string }) {
  body.items.forEach((e, i) => {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(e.name)) throw new ApiError(422, "invalid_definition", `items.${i}.name：环境名不合法：'${e.name}'（小写字母开头，可含数字与连字符）`);
  });
  const names = body.items.map((e) => e.name);
  if (!names.length) throw new ApiError(422, "invalid_definition", "至少要有一个环境");
  if (new Set(names).size !== names.length) throw new ApiError(422, "invalid_definition", "环境名重复");
  if (!names.includes(body.default)) throw new ApiError(422, "invalid_definition", `默认环境 ${body.default} 不在环境列表里`);
}
/** 移除的环境还被引用：409 in_use，列出引用的地方（与后端 registry 的引用检查一致） */
function checkEnvsInUse(next: { items: { name: string }[] }) {
  const kept = new Set(next.items.map((e) => e.name));
  for (const env of db.settings.envs.items.map((e) => e.name).filter((n) => !kept.has(n))) {
    const users = [
      ...db.services.filter((s) => env in s.envs).map((s) => `服务 ${s.name} 的环境覆盖`),
      ...db.tasks.filter((t) => t.envs.includes(env) || t.triggers.some((tr) => tr.type === "schedule" && tr.envs.includes(env))).map((t) => `任务 ${t.name}`),
      ...db.settings.notifications.rules.filter((r) => r.envs.includes(env)).map((r) => `通知规则「${r.name}」`),
      ...[...new Set([...db.agentConfigs.keys()].filter((k) => k.includes(`@${env}|`)).map((k) => k.split("@")[0]))].map((s) => `服务 ${s} 给 agent 的配置`),
    ];
    if (users.length) throw new ApiError(409, "in_use", `环境 ${env} 正被使用：${users.join("、")}。先改掉这些引用再移除`);
  }
}
/** 移除的渠道还被任务的结果投递引用：409 in_use */
function checkChannelsInUse(next: { channels: Record<string, unknown> }) {
  const users = db.tasks.filter((t) => t.deliver?.channel && !(t.deliver.channel in next.channels)).map((t) => `任务 ${t.name}（投递到 ${t.deliver!.channel}）`);
  if (users.length) throw new ApiError(409, "in_use", `渠道正被任务的结果投递使用：${users.join("、")}。先改掉这些任务的投递再移除`);
}
on("GET", "/v1/settings", () => Object.fromEntries(SECTIONS.map((s) => [s, masked(s, db.settings[s])])));
/** 平台内置的默认提示词（与后端 PromptsConfig() 一致） */
on("GET", "/v1/settings/prompts/defaults", () => db.PROMPT_DEFAULTS);
for (const section of SECTIONS) {
  on("GET", `/v1/settings/${section}`, () => masked(section, db.settings[section]));
  on("PUT", `/v1/settings/${section}`, (_p, _q, body) => {
    const target = db.settings[section] as unknown as Ledgered;
    const { section: _s, version: _v, updated_by: _u, updated_at: _a, ...rest } = body;
    void _s; void _v; void _u; void _a;
    if (section === "envs") { checkEnvs(rest); checkEnvsInUse(rest); }
    if (section === "notifications") {
      checkChannelsInUse(rest);
      const previous = db.settings.notifications.channels as Record<string, { token: string }>;
      for (const [name, ch] of Object.entries(rest.channels as Record<string, { url: string; token: string }>)) {
        if (!/^https?:\/\//.test(ch.url)) throw new ApiError(422, "invalid_definition", `channels.${name}.url：地址需以 http:// 或 https:// 开头`);
        if (ch.token === "***") ch.token = previous[name]?.token ?? "";
      }
      const missing = (rest.rules as { channel: string }[]).map((r) => r.channel).filter((c) => !(c in rest.channels));
      if (missing.length) throw new ApiError(422, "invalid_definition", `规则引用了不存在的渠道：${[...new Set(missing)].join("、")}`);
    }
    if (section === "prompts") checkPrompts(rest);
    const saved = bump(`settings/${section}`, target, rest);
    // 先记版本再改 meta 的环境列表（它和这一节的 items 起初是同一个数组）
    if (section === "envs") db.envs.splice(0, db.envs.length, ...rest.items);
    return masked(section, saved);
  });
  on("GET", `/v1/settings/${section}/versions`, () => versionsOf(`settings/${section}`, db.settings[section] as unknown as Record<string, unknown>)
    .map((v) => ({ ...v, definition: masked(section, v.definition) })));
  on("POST", `/v1/settings/${section}/versions/:v/restore`, (p) => {
    const target = db.settings[section] as unknown as Ledgered;
    const old = versionsOf(`settings/${section}`, target as unknown as Record<string, unknown>).find((v) => v.version === Number(p.v));
    if (!old) throw notFound("版本 " + p.v);
    const restored = bump(`settings/${section}`, target, structuredClone(old.definition) as Partial<Ledgered>);
    // 恢复环境一节：meta 里的环境列表跟着变
    if (section === "envs") db.envs.splice(0, db.envs.length, ...(restored as unknown as { items: typeof db.envs }).items);
    return masked(section, restored);
  });
}
on("POST", "/v1/settings/notifications/test", (_p, _q, body) => {
  if (!(body.channel in db.settings.notifications.channels)) throw new ApiError(400, "unknown_channel", `通知渠道 ${body.channel} 不存在`);
  return { ok: true };
});

on("GET", "/v1/api-keys", () => db.apiKeys);
on("POST", "/v1/api-keys", (_p, _q, body) => {
  const name = String(body?.name ?? "");
  if (!/^[\w.-]{2,40}$/.test(name)) throw new ApiError(422, "invalid_request", "密钥名：2–40 个字母、数字、. _ -");
  if (db.apiKeys.some((k) => k.name === name)) throw new ApiError(409, "conflict", `已有名为 ${name} 的密钥`);
  const token = "ap_" + db.hex(43);
  const key: ApiKey = { id: Math.max(...db.apiKeys.map((k) => k.id)) + 1, name, prefix: token.slice(0, 9), note: String(body?.note ?? ""), created_by: ME.name, created_at: now(), expires_at: body?.expires_at ?? null, last_used_at: null, revoked_at: null };
  db.apiKeys.unshift(key);
  return { ...key, token };
});
const findKey = (id: string) => db.apiKeys.find((k) => k.id === Number(id)) ?? (() => { throw notFound("密钥 " + id); })();
/** 只能改备注与过期时间 */
on("PATCH", "/v1/api-keys/:id", (p, _q, body) => {
  const k = findKey(p.id);
  if (body?.note !== undefined) k.note = String(body.note);
  if (body?.expires_at !== undefined) k.expires_at = body.expires_at;
  return k;
});
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
  // 与后端一致：不含内建任务（记忆园丁每个服务×环境各一条，会把业务定时挤掉），带任务显示名与总次数
  const fires = db.tasks.filter((t) => t.enabled && effective(t).form !== "builtin")
    .flatMap((t) => firesOf(effective(t)).map((f) => ({ ...f, task_title: effective(t).title || t.name })))
    .filter((f) => (!q.env || f.env === q.env) && (!q.service || f.service === q.service)).sort((a, b) => a.at.localeCompare(b.at));
  const stats: Stats = {
    hours,
    totals: { runs: rs.length, success: rs.filter((r) => r.status === "success").length, failed: rs.filter((r) => r.status === "failed").length, running: db.runs.filter((r) => r.status === "running" && (!q.env || r.env === q.env) && (!q.service || r.service === q.service)).length },
    by_env: byEnv, series, top_failures: [...failMap.values()].sort((a, b) => b.failed - a.failed).slice(0, 5),
    upcoming: fires.slice(0, 8), upcoming_total: fires.length,
    tokens: rs.reduce((n, r) => n + (r.tokens ?? 0), 0),
  };
  return stats;
});

// ———————— 调度的可见面：触发记录、执行主机与排队情况 ————————

const TICK_KINDS = ["schedule", "event", "after", "retry"];
const TICK_OUTCOMES = ["fired", "deduped", "skipped", "filtered", "waiting", "rejected", "unmatched"];
on("GET", "/v1/ticks", (_p, q) => {
  if (q.kind && !TICK_KINDS.includes(String(q.kind))) throw new ApiError(422, "invalid_request", `kind 只能是 ${TICK_KINDS.join("、")}`);
  if (q.outcome && !TICK_OUTCOMES.includes(String(q.outcome))) throw new ApiError(422, "invalid_request", `outcome 只能是 ${TICK_OUTCOMES.join("、")}`);
  const limit = Math.max(1, Math.min(Number(q.limit) || 100, 500));
  const items = db.ticks.filter((t) => (!q.task || t.task === q.task || (t.task ?? "").startsWith(q.task + ":"))
    && (!q.kind || t.kind === q.kind) && (!q.outcome || t.outcome === q.outcome) && (!q.env || t.env === q.env)
    && (!q.hours || within(t.at, Number(q.hours))) && (!q.before || t.id < Number(q.before))).slice(0, limit);
  return { items, next_before: items.length >= limit ? items[items.length - 1].id : null };
});
on("GET", "/v1/workers", (): WorkersResponse => {
  const hosts = workersNow();
  const groups = new Map<string, WorkersResponse["queue"]["groups"][number]>();
  for (const r of db.runs.filter((x) => x.status === "queued")) {
    const k = `${r.env}|${r.service}`;
    const g = groups.get(k) ?? { env: r.env, service: r.service, queued: 0, oldest_at: r.created_at, waiting_upstream: 0, stuck: 0, served: false };
    g.queued++;
    if (r.created_at < g.oldest_at) g.oldest_at = r.created_at;
    if (r.depends_on.length) g.waiting_upstream++;
    if (!r.depends_on.length && Date.now() - new Date(r.created_at).getTime() > 600_000) g.stuck++;
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => a.env.localeCompare(b.env) || String(a.service).localeCompare(String(b.service)))
    .map((g) => ({ ...g, served: serving(g.env, g.service).length > 0 }));
  return { workers: hosts.sort((a, b) => Number(b.online) - Number(a.online) || a.env.localeCompare(b.env) || a.host.localeCompare(b.host)),
    queue: { groups: list, total: list.reduce((n, g) => n + g.queued, 0) }, queued_alert_s: 600 };
});

on("GET", "/v1/search", (_p, q) => {
  const term = String(q.q || "").toLowerCase();
  if (!term) return [];
  const hits: SearchHit[] = [];
  const firstLine = (text: string, limit = 60) => { const l = text.split("\n").map((x) => x.trim()).find(Boolean) ?? ""; return l.length > limit ? l.slice(0, limit) + "…" : l; };
  for (const s of db.services) if ((s.name + s.title + s.description).toLowerCase().includes(term)) hits.push({ type: "service", id: s.name, title: s.title || s.name, subtitle: s.description ? `${s.name} · ${firstLine(s.description, 40)}` : s.name, href: `/services/${s.name}` });
  for (const t of db.tasks) if ((t.name + t.title).toLowerCase().includes(term)) hits.push({ type: "task", id: t.name, title: t.title || t.name, subtitle: t.name, href: `/tasks/${encodeURIComponent(t.name)}` });
  for (const r of db.roles) if ((r.name + r.title).toLowerCase().includes(term)) hits.push({ type: "role", id: r.name, title: r.title, subtitle: r.name, href: `/settings/roles/${r.name}` });
  for (const r of db.runs) if (r.run_id.startsWith(term) || r.summary.toLowerCase().includes(term)) hits.push({ type: "run", id: r.run_id, title: r.summary, subtitle: `${r.task} · ${r.env} · ${r.run_id.slice(0, 8)}`, href: `/runs/${r.run_id}` });
  // 教训的键是 lesson:<指纹>，人看不懂：标题用结论的第一行（与后端一致）
  for (const k of db.knowledge.filter((x) => x.kind !== "handoff" && x.status === "active" && (x.key + x.content).toLowerCase().includes(term)).slice(0, 6)) {
    const lesson = k.kind === "lesson";
    hits.push({ type: "knowledge", id: String(k.id), title: lesson ? `教训：${firstLine(k.content)}` : k.key,
      subtitle: `${k.service}@${k.env || "所有环境"}${lesson ? "" : ` · ${firstLine(k.content, 40)}`}`, href: `/memory?knowledge=${k.id}` });
  }
  for (const a of db.assetList.filter((x) => x.status === "active" && assetHit(x, term)).slice(0, 6))
    hits.push({ type: "asset", id: String(a.id), title: a.name, subtitle: `${a.service}@${a.env} · ${firstLine(a.summary, 40)}`, href: `/memory?tab=assets&id=${a.id}` });
  return hits.slice(0, 30);
});

// ———————— 流式：对话 ————————

export function handleStream(path: string, body: any, onEvent: (ev: Record<string, unknown>) => void, onDone: (err?: Error) => void): () => void {
  if (path !== "/v1/chat") { setTimeout(() => onDone(new ApiError(404, "not_found", path)), 50); return () => {}; }
  let accepted: RunAccepted;
  try {
    // 没指定任务：续会话沿用上一轮的任务；否则该服务专属的对话任务优先，其次通用入口 ask
    const last = body.session_id ? db.runs.filter((r) => r.session_id === body.session_id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : undefined;
    const chatTasks = db.tasks.filter((t) => !t.extends && t.enabled && t.triggers.some((tr) => tr.type === "chat" && tr.enabled !== false));
    const task = body.task || last?.task.split(":")[0] || (chatTasks.find((t) => t.service === body.service) ?? chatTasks.find((t) => t.name === "ask") ?? chatTasks.find((t) => t.service === "*"))?.name;
    if (!task) throw new ApiError(404, "unknown_task", `服务 ${body.service || "—"} 没有可对话的任务（任务需声明 chat 触发）`);
    const chosen = db.tasks.find((t) => t.name === task);
    if (chosen && !chosen.triggers.some((tr) => tr.type === "chat" && tr.enabled !== false))
      throw new ApiError(400, "trigger_not_allowed", `任务 ${task} 没有声明 chat 触发`);
    // 续会话：任务的其它输入沿用上一轮（这轮写了的以这轮为准）；对象也沿用
    const carried = Object.fromEntries(Object.entries(last?.input ?? {}).filter(([k]) => k !== "question"));
    const subtask = body.subtask ?? (last ? last.task.split(":")[1] ?? null : null);
    accepted = submitRun({ task, subtask, service: body.service ?? last?.service, env: body.env ?? last?.env, input: { ...carried, ...(body.input ?? {}), question: body.message }, session_id: body.session_id, memory: body.memory }, "chat", true);
  } catch (e) {
    const err = e as ApiError;
    setTimeout(() => { onEvent({ type: "error", code: err.code, message: err.message }); onDone(); }, 150);
    return () => {};
  }
  const q = String(body.message || "");
  const recall = body.memory?.recall !== false;
  const svc = db.services.find((s) => s.name === body.service);
  const hasCk = !!svc && Object.keys(svc.databases).length > 0;
  const days = db.TD.slice(0, 5).reverse();
  const rows = days.map((d, i) => [d, [412380.55, -86204.1, 233918.4, 157702.25, 301446.9][i], 1190 + (i % 3)] as [string, number, number]);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  const sql = `SELECT trade_date, round(sum(realized_pnl + unrealized_pnl), 2) AS pnl, uniqExact(account_id) AS accounts\nFROM dws_account_pnl_daily\nWHERE trade_date >= '${days[0]}'\nGROUP BY trade_date ORDER BY trade_date`;
  const yuan = (n: number) => (n < 0 ? "-¥" : "¥") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  const steps: Record<string, unknown>[] = [
    { type: "run", run_id: accepted.run_id, session_id: accepted.session_id, subtask_created: accepted.subtask_created },
    ...(recall ? [{ type: "stage", stage: "recall", title: "召回 · 记忆 2 条", content: "[历史记忆]\n- metric:account_pnl: 账户收益 = 已实现 + 浮动，按交易日汇总，单位元\n- table:dws_account_pnl_daily: 一行 = 一个账户一个交易日" }] : []),
    ...(hasCk ? [
      { type: "model_call", model: db.MODEL, ms: 4140, input_tokens: 5820, output_tokens: 264, tokens: 6084, tool_calls: ["db_query"],
        content: `问题是「${q.slice(0, 40)}」。按记忆里的口径，账户收益在 dws_account_pnl_daily，按交易日汇总；先查最近 5 个交易日，数据量小，直接看结果。` },
      { type: "tool_call", tool: "db_query", call: "q1", args: { query: sql, db: "ck" } },
      { type: "tool_result", tool: "db_query", call: "q1", output: db.ckOut({ rows: rows.length, cols: ["trade_date", "pnl", "accounts"], preview: rows, ms: 214 }), duration_ms: 240 },
    ] : [
      { type: "model_call", model: db.MODEL, ms: 3920, input_tokens: 5310, output_tokens: 233, tokens: 5543, tool_calls: ["py"],
        content: `问题是「${q.slice(0, 40)}」。${svc?.title ?? "这个服务"}没有登记只读库，配置都在 vision_cfg 的模型里，用 py 在项目内核里只读查 ORM。` },
      { type: "tool_call", tool: "py", call: "p1", args: { code: "from vision_cfg.models import Strategy, Account, Portfolio\nprint(Strategy.objects.count(), Account.objects.count(), Portfolio.objects.count())" } },
      { type: "tool_result", tool: "py", call: "p1", output: "38 214 17", duration_ms: 610 },
    ]),
    { type: "model_call", model: db.MODEL, ms: 5310, input_tokens: 6580, output_tokens: 412, tokens: 6992, tool_calls: [], content: "结果拿到了，整理成表格回答。" },
  ];
  const answer = hasCk
    ? `最近 5 个交易日账户收益合计 **${yuan(total)}**（已实现 + 浮动，按交易日汇总）：\n\n| 交易日 | 收益 | 账户数 |\n|---|---|---|\n${rows.map(([d, v, n]) => `| ${d} | ${yuan(v)} | ${n.toLocaleString("en-US")} |`).join("\n")}\n\n\`\`\`sql\n${sql}\n\`\`\``
    : "当前 vision_cfg 里有 **38 个策略、214 个账户、17 个组合**。\n\n依据：`vision_cfg.models` 的 ORM 只读计数（没有改任何配置）。要看某个策略挂在哪些账户上，告诉我策略代码。";
  const timers: number[] = [];
  const run = db.runs.find((r) => r.run_id === accepted.run_id);
  const started = Date.now();
  const recorded: RunEvent[] = [];
  let t = 0;
  steps.forEach((s) => {
    t += 500 + Math.random() * 600;
    timers.push(window.setTimeout(() => {
      onEvent(s);
      const { type, ...payload } = s;
      if (type !== "run") recorded.push({ seq: recorded.length + 1, kind: type as RunEvent["kind"], at: now(), payload: payload as RunEvent["payload"] });
    }, t));
  });
  t += 900;
  timers.push(window.setTimeout(() => {
    onEvent({ type: "final", status: "success", output: { answer } });
    // 运行详情里看到的就是这次流出来的过程
    if (run) Object.assign(run, {
      status: "success", resolution: "agent", duration_ms: Date.now() - started, tokens: 18_619, finished_at: now(),
      _events: [...recorded, { seq: recorded.length + 1, kind: "final", at: now(), payload: { content: answer } }], _answer: answer,
    });
    onDone();
  }, t));
  return () => timers.forEach(clearTimeout);
}
