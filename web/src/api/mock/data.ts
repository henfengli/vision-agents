/**
 * mock 数据：确定性随机（固定种子），时间相对"现在"生成，
 * 让预览里的列表、统计、时间线看起来像一个跑了几天的真实平台。
 */
import type {
  Approval, Asset, Case, ChatTurn, Env, Instance, Knowledge, Policy, Role, Run, RunEvent,
  RunStatus, Service, SessionDetail, Task, Trigger,
} from "../types";

// ———————— 随机工具 ————————

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261020);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (a: number, b: number) => Math.round(a + rand() * (b - a));
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ———————— 环境 ————————

export const envs: Env[] = [
  { name: "prod", title: "生产", description: "线上环境：写操作与进程启停需审批", enabled: true, protected: true, color: "red", order: 1, version: 3 },
  { name: "test", title: "测试", description: "集成测试环境，数据每周从生产脱敏同步", enabled: true, protected: false, color: "amber", order: 2, version: 2 },
  { name: "dev", title: "开发", description: "开发自测，库每周一重置", enabled: true, protected: false, color: "blue", order: 3, version: 1 },
];

// ———————— 服务 ————————

const by = (name: string, at: number) => ({ updated_by: name, updated_at: iso(at) });

export const services: Service[] = [
  {
    name: "dagster", title: "Dagster 数据编排", description: "数仓 ETL 编排：ods → dwd → ads 三层资产，按天物化",
    root: "/srv/dagster", code_paths: ["/srv/dagster"], hosts: ["10.0.0.11"], readonly_dsn: null,
    configs: [{ canonical: "/srv/dagster/dagster.yaml", template: "/srv/dagster/conf/dagster.{env}.yaml" },
      { canonical: "/srv/dagster/workspace.yaml", template: "/srv/dagster/conf/workspace.{env}.yaml" }],
    processes: {
      webserver: { cmd: ["/srv/dagster/venv/bin/dagster-webserver", "-w", "workspace.yaml", "-p", "{port}"], workdir: "/srv/dagster", ports: { prod: 3000, test: 3001, dev: 3002 }, lease_hours: 2 },
      daemon: { cmd: ["/srv/dagster/venv/bin/dagster-daemon", "run", "-w", "workspace.yaml"], workdir: "/srv/dagster", lease_hours: 2 },
    },
    envs: {
      prod: { hosts: ["10.0.0.11", "10.0.0.12"], readonly_dsn: "postgresql://ro@prod-db:5432/dagster" },
      test: { hosts: ["10.0.1.11"], readonly_dsn: "postgresql://ro@test-db:5432/dagster" },
    },
    profile: {
      conventions: "资产按 dt 分区（yyyy-mm-dd），T+1 物化；ads 层依赖 dwd 全部完成",
      no_go: "prod 不手工触发 backfill，需走变更单",
      env_notes: "test 的 ods 数据是生产前一周的脱敏快照，金额字段乘了随机系数",
      pitfalls: "上游 ods_order 延迟到 03:00 后会导致 dwd_trade_order 级联失败，先看上游",
    },
    enabled: true, version: 7, ...by("lihf", 2 * DAY),
  },
  {
    name: "board", title: "经营看板", description: "面向业务的经营指标看板（Node.js），数据来自 ads 层",
    root: "/srv/board", code_paths: ["/srv/board"], hosts: ["10.0.0.21"], readonly_dsn: "postgresql://ro@prod-db:5432/board",
    configs: [{ canonical: "/srv/board/.env", template: "/srv/board/conf/.env.{env}" }],
    processes: { server: { cmd: ["node", "server.js"], workdir: "/srv/board", ports: { prod: 8080, test: 8081, dev: 8082 }, lease_hours: 4 } },
    envs: {
      prod: { readonly_dsn: "postgresql://ro@prod-db:5432/board" },
      test: { readonly_dsn: "postgresql://ro@test-db:5432/board", hosts: ["10.0.1.21"] },
      dev: { readonly_dsn: "postgresql://ro@dev-db:5432/board" },
    },
    profile: {
      conventions: "GMV 不含退款；total_fee 单位是分；“本月”按自然月，不是近 30 天",
      pitfalls: "看板缓存 10 分钟，刚改的数据不会立刻出现",
    },
    enabled: true, version: 4, ...by("wangzh", 5 * DAY),
  },
  {
    name: "config-center", title: "配置中心", description: "各服务运行时配置的发布与审计（Java）",
    root: "/srv/config-center", code_paths: ["/srv/config-center"], hosts: ["10.0.0.31"], readonly_dsn: "postgresql://ro@prod-db:5432/config",
    configs: [{ canonical: "/srv/config-center/application.yaml", template: "/srv/config-center/conf/application.{env}.yaml" }],
    processes: { app: { cmd: ["./bin/config-center", "--port", "{port}"], workdir: "/srv/config-center", ports: { prod: 9080, test: 9081, dev: 9082 }, lease_hours: 2 } },
    envs: {},
    profile: { no_go: "发布接口在 prod 只读调用，审计只看不改" },
    enabled: true, version: 2, ...by("lihf", 9 * DAY),
  },
  {
    name: "report-engine", title: "报表引擎", description: "定时报表渲染与邮件分发",
    root: "/srv/report-engine", code_paths: ["/srv/report-engine"], hosts: ["10.0.0.41"], readonly_dsn: null,
    configs: [{ canonical: "/srv/report-engine/config.toml", template: "/srv/report-engine/conf/config.{env}.toml" }],
    processes: { worker: { cmd: ["python", "-m", "report_engine.worker"], workdir: "/srv/report-engine", lease_hours: 2 } },
    envs: {}, profile: {}, enabled: false, version: 1, ...by("chenyu", 14 * DAY),
  },
];

// ———————— 角色 ————————

export const roles: Role[] = [
  {
    name: "ops_analyst", title: "运维分析", description: "报错定位与根因分析：读日志、读代码、查库、必要时在测试环境复现",
    prompt: "你是运维分析工程师。拿到一次失败时：\n1. 先看档案里的已知坑和前序交接摘要，排除已知原因；\n2. 读相关代码和对应环境的配置文件，定位出错的步骤；\n3. 用只读库验证数据假设；需要复现时只在非受保护环境起进程；\n4. 结论按「根因 / 证据 / 影响范围 / 建议」四段输出。\n\n不要猜测，没有证据的结论标注为推测。",
    tools: ["bash", "run_code", "service_info", "service_ctl", "sql_query", "host_metrics", "save_asset"],
    extends: null, prompt_append: "", version: 6, ...by("lihf", 3 * DAY),
  },
  {
    name: "data_searcher", title: "数据口径问答", description: "回答指标口径和取数问题，给出 SQL 与结果",
    prompt: "你是数据分析师，回答业务方关于指标口径与数据的问题。\n- 先确认口径（档案里的约定优先），再写 SQL；\n- 只用 sql_query 查只读库，结果超过 20 行时给汇总；\n- 回答里附上使用的 SQL。",
    tools: ["sql_query", "service_info", "run_code"], extends: null, prompt_append: "", version: 4, ...by("wangzh", 6 * DAY),
  },
  {
    name: "qa_engineer", title: "前端冒烟测试", description: "部署后按方法资产跑冒烟脚本，失败截图并定位",
    prompt: "你是测试工程师。部署完成后执行冒烟测试：优先复用方法资产里的脚本，不要重写；失败时截图、给出复现步骤。",
    tools: ["bash", "service_info", "save_asset", "browser_navigate", "browser_snapshot"], extends: null, prompt_append: "", version: 3, ...by("chenyu", 8 * DAY),
  },
  {
    name: "inspector", title: "巡检", description: "按方法资产做日常巡检，异常才通知",
    prompt: "你是巡检员：按沉淀的巡检方法逐项检查，正常项只计数，异常项给证据。没有既定方法时先探索，结束后用 save_asset 沉淀方法。",
    tools: ["bash", "service_info", "sql_query", "host_metrics", "save_asset", "notify"], extends: "ops_analyst",
    prompt_append: "巡检输出控制在 15 行以内。", version: 2, ...by("lihf", 10 * DAY),
  },
];

// ———————— 任务 ————————

const trig = {
  api: (id = "api"): Trigger => ({ id, type: "api" }),
  chat: (id = "chat"): Trigger => ({ id, type: "chat" }),
};

const taskBase = { enabled: true, context: {}, extends: null, auto_created: false, dedup: null, graph: null, handler: null };

export const tasks: Task[] = [
  {
    ...taskBase, name: "failure-analysis", title: "Dagster 失败分析", description: "Dagster 资产物化失败时分析根因，结论推钉钉群",
    service: "dagster", role: "ops_analyst", form: "agent",
    input: {
      run_id: { type: "str", required: true, description: "Dagster run id" },
      asset_key: { type: "str", required: true, description: "失败的资产" },
      error: { type: "text", required: true, description: "报错堆栈" },
    },
    envs: ["prod", "test"],
    triggers: [
      { id: "on-failure", type: "event", source: "dagster", event: "run_failure", map: { run_id: "run_id", asset_key: "asset_key", error: "error" },
        rules: [
          { pattern: "connection.*(refused|timeout|reset)", category: "infra", conclusion: "数据库/服务连接失败，检查目标服务存活与网络" },
          { pattern: "duplicate key|unique constraint", category: "data", conclusion: "主键冲突：上游重复投递或任务重复跑" },
          { pattern: "out of memory|oom", category: "infra", conclusion: "内存不足：检查资源配额或拆分分区" },
        ],
        session: "dagster:{asset_key}:{error_class}:{date}" },
      trig.api(),
    ],
    output: { channel: "dingtalk" }, dedup: { key: "run_id", window_s: 600 }, timeout_s: 300,
    context: { pitfalls: "资产失败先看上游是否完成，80% 的失败是上游延迟级联" },
    version: 9, ...by("lihf", 1 * DAY),
  },
  {
    ...taskBase, name: "failure-analysis:dwd_trade_order", title: "", description: "", service: "dagster", role: "ops_analyst", form: "agent",
    input: {}, envs: [], triggers: [], output: { channel: "dingtalk" }, timeout_s: 300, extends: "failure-analysis",
    context: {
      code_refs: "/srv/dagster/assets/dwd/trade_order.py",
      upstream: "ods_order、ods_payment（03:00 前到齐）",
      pitfalls: "支付回调乱序时会出现 amount 为负的脏数据，过滤规则在 transform_payment()",
    },
    version: 3, ...by("lihf", 2 * DAY),
  },
  {
    ...taskBase, name: "failure-analysis:ads_gmv_daily", title: "", description: "", service: "dagster", role: "ops_analyst", form: "agent",
    input: {}, envs: [], triggers: [], output: { channel: "dingtalk" }, timeout_s: 300, extends: "failure-analysis", auto_created: true,
    version: 1, ...by("auto:event", 6 * HOUR),
  },
  {
    ...taskBase, name: "data-qa", title: "数据口径问答", description: "业务方提问指标口径、取数；对话页默认任务",
    service: "*", role: "data_searcher", form: "agent",
    input: { question: { type: "text", required: true, description: "问题" } },
    envs: [], triggers: [trig.chat(), trig.api()], output: { channel: "caller" }, timeout_s: 180,
    version: 5, ...by("wangzh", 4 * DAY),
  },
  {
    ...taskBase, name: "frontend-smoke", title: "看板冒烟测试", description: "GitLab 部署成功后跑冒烟脚本",
    service: "board", role: "qa_engineer", form: "agent",
    input: { version: { type: "str", required: true, description: "部署版本（ref）" }, project: { type: "str", description: "GitLab 项目" } },
    envs: ["test", "prod"],
    triggers: [{ id: "on-deploy", type: "event", source: "gitlab", event: "deployment", filter: { project: "^board$" }, map: { version: "ref", project: "project" } }, trig.api()],
    output: { channel: "dingtalk" }, dedup: { key: "version", window_s: 1800 }, timeout_s: 600,
    version: 4, ...by("chenyu", 7 * DAY),
  },
  {
    ...taskBase, name: "daily-inspection", title: "看板日常巡检", description: "每天早上检查看板数据新鲜度、接口错误率和主机资源",
    service: "board", role: "inspector", form: "agent", input: { scope: { type: "enum", options: ["full", "quick"], default: "full" } },
    envs: ["prod", "test"],
    triggers: [{ id: "morning", type: "schedule", cron: "50 8 * * *", envs: ["prod", "test"], input: { scope: "full" }, timezone: "Asia/Shanghai" }, trig.api()],
    output: { channel: "dingtalk" }, timeout_s: 600, version: 6, ...by("lihf", 3 * DAY),
  },
  {
    ...taskBase, name: "config-audit", title: "配置变更审计", description: "工作日早上汇总前一天的配置发布，标出高风险变更",
    service: "config-center", role: "ops_analyst", form: "graph", input: {},
    envs: ["prod"],
    triggers: [{ id: "weekday", type: "schedule", cron: "30 8 * * 1-5", envs: ["prod"], input: {} }],
    output: { channel: "dingtalk" }, timeout_s: 900,
    graph: {
      changes: { code: "config.collect_changes" },
      risk: { deps: ["changes"], map: "changes", agent: { role: "ops_analyst", contract: "每条变更给出 risk: low|mid|high 与理由" } },
      triage: { deps: ["risk"], route: { by: "risk_level", choices: ["quiet", "notify", "escalate"] } },
      report: { deps: ["risk", "triage"], agent: { role: "ops_analyst", contract: "汇总报告 markdown" }, gate: { when: "triage == 'escalate'" } },
    },
    version: 2, ...by("lihf", 12 * DAY),
  },
  {
    ...taskBase, name: "report-regression", title: "报表回归对比", description: "渲染报表与基线逐格对比", service: "report-engine", role: "inspector", form: "agent",
    input: { report: { type: "str", required: true }, baseline: { type: "str" } }, envs: ["test"],
    triggers: [trig.api()], output: { channel: "http", callback: "http://10.0.0.41:7000/hooks/regression" }, timeout_s: 900,
    enabled: false, version: 1, ...by("chenyu", 14 * DAY),
  },
  {
    ...taskBase, name: "memory-gardener", title: "记忆园丁", description: "夜间维护：code_ref 漂移巡检、负反馈条目处置提示",
    service: null, role: null, form: "builtin", handler: "memory-gardener", input: {}, envs: [],
    triggers: [{ id: "nightly", type: "schedule", cron: "0 3 * * *", envs: ["prod", "test", "dev"], input: {} }],
    output: { channel: "caller" }, timeout_s: 1800, version: 2, ...by("seed", 20 * DAY),
  },
];

// ———————— 策略 ————————

export const policies: Policy[] = [
  { name: "prod-destructive", description: "生产环境里提到删除/清空类操作的请求先审批", order: 10,
    applies_to: { tasks: [], services: [], envs: ["prod"] }, match_regex: "\\b(drop|delete|truncate|清空|删除)\\b",
    action: "require_approval", message: "生产环境的破坏性操作需要人工确认", enabled: true, version: 2, ...by("lihf", 15 * DAY) },
  { name: "no-secrets", description: "输入里出现密钥/密码直接拒绝", order: 20,
    applies_to: { tasks: [], services: [], envs: [] }, match_regex: "(password|secret|token)\\s*[:=]",
    action: "deny", message: "请不要在请求里携带密钥", enabled: true, version: 1, ...by("lihf", 30 * DAY) },
  { name: "board-prod-qa", description: "看板 prod 的问答只允许工作时间", order: 30,
    applies_to: { tasks: ["data-qa"], services: ["board"], envs: ["prod"] }, match_regex: ".*",
    action: "require_approval", message: "非工作时间访问生产看板数据需审批", enabled: false, version: 1, ...by("wangzh", 9 * DAY) },
];

// ———————— 运行 ————————

const questions = [
  "3 月以来 total_fee 是多少？", "上周 GMV 环比为什么跌了 12%？", "退款率指标的口径是什么？",
  "dwd_trade_order 昨天行数比前天少了一半，正常吗？", "看板首页 DAU 和埋点平台对不上", "新客定义是首单还是首访？",
  "7 天留存怎么算的？分母是哪天的新客？", "华东区 10 月订单量按天给我一下",
];
const assets = ["dwd_trade_order", "ads_gmv_daily", "dwd_user_active", "ods_order", "ads_refund_rate", "dim_shop"];
const errors = [
  "psycopg.OperationalError: connection to server at \"10.0.2.5\", port 5432 failed: Connection refused",
  "KeyError: 'pay_channel'\n  File \"/srv/dagster/assets/dwd/trade_order.py\", line 88, in transform_payment",
  "dagster._core.errors.DagsterExecutionStepExecutionError: upstream asset ods_order partition 2026-10-19 missing",
  "pandas.errors.MergeError: Merge keys are not unique in right dataset",
  "MemoryError: Unable to allocate 3.2 GiB for an array",
];

export interface MockRun extends Run {
  _events?: RunEvent[];
}

function makeRun(): MockRun {
  const t = rand();
  const taskName = t < 0.34 ? "data-qa" : t < 0.58 ? "failure-analysis" : t < 0.72 ? "daily-inspection" : t < 0.82 ? "frontend-smoke" : t < 0.9 ? "config-audit" : t < 0.95 ? "memory-gardener" : "failure-analysis:dwd_trade_order";
  const task = tasks.find((x) => x.name === taskName)!;
  const base = task.extends ? tasks.find((x) => x.name === task.extends)! : task;
  const ago = Math.floor(Math.pow(rand(), 1.6) * 72 * HOUR) + between(1, 20) * MIN;
  const env = base.envs.length ? pick(base.envs) : pick(["prod", "test", "test", "dev"]);
  const service = base.service === "*" ? pick(["board", "board", "dagster", "config-center"]) : base.service;
  const s = rand();
  let status: RunStatus = s < 0.8 ? "success" : s < 0.93 ? "failed" : "cancelled";
  if (ago < 25 * MIN && rand() < 0.5) status = "running";
  const duration = status === "running" ? null : between(4_000, base.timeout_s * 600);
  const triggerType = base.triggers.find((x) => x.type !== "api")?.type ?? "api";
  const fromTrigger = rand() < 0.75;
  const trigger = fromTrigger && triggerType !== "api"
    ? { type: triggerType, id: base.triggers.find((x) => x.type === triggerType)?.id ?? null, source: triggerType === "event" ? (base.triggers.find((x) => x.type === "event") as { source: string }).source : null, caller: triggerType === "schedule" ? "schedule" : triggerType === "chat" ? pick(["wangzh", "lihf", "zhaoq", "web"]) : triggerType === "event" ? (base.name === "frontend-smoke" ? "gitlab" : "dagster-sensor") : "sdk" }
    : { type: "api" as const, id: "api", source: null, caller: pick(["board-backend", "report-engine", "lihf", "sdk"]) };
  const asset = taskName === "failure-analysis:dwd_trade_order" ? "dwd_trade_order" : pick(assets);
  const err = pick(errors);
  const input: Record<string, unknown> =
    base.name === "data-qa" ? { question: pick(questions), server: service }
      : base.name === "failure-analysis" ? { run_id: hex(8) + "-" + hex(4), asset_key: asset, error: err }
        : base.name === "frontend-smoke" ? { version: `v2.${between(10, 40)}.${between(0, 9)}`, project: "board" }
          : base.name === "daily-inspection" ? { scope: "full" } : {};
  const ruleHit = base.name === "failure-analysis" && err.includes("Connection refused") && rand() < 0.7;
  const summary = String(input.question ?? input.asset_key ?? input.version ?? (base.name === "daily-inspection" ? "定时巡检" : base.title));
  const created = iso(ago);
  return {
    run_id: hex(12), session_id: "", task: taskName, task_title: base.title, service, env, role: base.role,
    status: ruleHit ? "success" : status, resolution: ruleHit ? "rule" : status === "running" ? null : base.form === "graph" ? "graph" : base.form === "builtin" ? "builtin" : "agent",
    trigger: trigger as Run["trigger"], summary, tokens: ruleHit || base.form === "builtin" ? 0 : between(2_000, 48_000),
    duration_ms: ruleHit ? between(40, 300) : duration, created_at: created,
    finished_at: status === "running" ? null : new Date(NOW - ago + (duration ?? 0)).toISOString(),
    task_version: base.version - (rand() < 0.2 ? 1 : 0), role_version: base.role ? roles.find((r) => r.name === base.role)!.version : null,
    input, output: null, error_code: null, pending_approval: null,
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [], graph: null },
    feedback: rand() < 0.12 ? { score: rand() < 0.75 ? 1 : -1, comment: "", at: created } : null,
    langfuse_url: base.form === "agent" && !ruleHit ? "https://langfuse.internal/project/agent/traces/" + hex(16) : null,
    _events: undefined,
  };
}

export const runs: MockRun[] = Array.from({ length: 260 }, () => makeRun())
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

// 会话：data-qa 的对话 run 串成会话；其余 run 自会话
const sessionPool = Array.from({ length: 9 }, () => hex(12));
for (const r of runs) {
  if (r.task === "data-qa" && r.trigger.type === "chat") r.session_id = pick(sessionPool);
  else if (r.task.startsWith("failure-analysis") && r.input.asset_key) r.session_id = `dagster:${r.input.asset_key}:infra:${r.created_at.slice(0, 10)}`;
  else r.session_id = r.run_id;
}

// 两条待审批 + 一条排队
const awaiting = runs.find((r) => r.task === "daily-inspection" && r.env === "prod")!;
awaiting.status = "awaiting_approval"; awaiting.finished_at = null; awaiting.duration_ms = null; awaiting.resolution = null;
awaiting.created_at = iso(14 * MIN);
const awaiting2 = runs.find((r) => r.task === "data-qa" && r.env === "prod" && r.service === "board")!;
awaiting2.status = "awaiting_approval"; awaiting2.finished_at = null; awaiting2.duration_ms = null; awaiting2.resolution = null;
awaiting2.created_at = iso(38 * MIN); awaiting2.input = { question: "把 10 月测试订单从 ads_gmv_daily 删除后重算 GMV", server: "board" };
awaiting2.summary = String(awaiting2.input.question);
runs.sort((a, b) => b.created_at.localeCompare(a.created_at));

// ———————— 运行事件（详情页按需生成，确定性） ————————

export function eventsOf(run: MockRun): RunEvent[] {
  if (run._events) return run._events;
  const r = mulberry32(parseInt(run.run_id.slice(0, 8), 16));
  const start = new Date(run.created_at).getTime();
  let t = start;
  let seq = 0;
  const out: RunEvent[] = [];
  const push = (kind: RunEvent["kind"], payload: RunEvent["payload"], dt = 400) => {
    t += Math.round(dt * (0.5 + r()));
    out.push({ seq: ++seq, kind, at: new Date(t).toISOString(), payload, feedback: null });
  };
  push("stage", { stage: "prepare", title: "准备", content: `任务 v${run.task_version} · 角色 ${run.role ?? "—"} v${run.role_version ?? "—"}` }, 200);
  if (run.resolution === "rule") {
    push("stage", { stage: "rule", title: "规则先行命中", content: "infra：数据库/服务连接失败，检查目标服务存活与网络" }, 30);
    push("final", { content: "**规则判定（infra）**：数据库/服务连接失败，检查目标服务存活与网络。\n\n报错摘要：`" + String(run.input.error ?? "").split("\n")[0] + "`" }, 20);
    push("stage", { stage: "deliver", title: "投递", content: "dingtalk ✓" }, 300);
    return (run._events = out);
  }
  if (run.task === "memory-gardener") {
    push("stage", { stage: "execute", title: "内建处理器 memory-gardener", content: "逐环境巡检 code_ref 漂移" }, 800);
    push("final", { content: "prod：校验 412 条，过期 3 条\ntest：校验 287 条，过期 1 条\ndev：校验 96 条，过期 0 条" }, 12000);
    return (run._events = out);
  }
  push("stage", { stage: "profile", title: "注入档案", content: "服务档案 4 项 · 任务档案 1 项" }, 120);
  push("stage", { stage: "recall", title: "召回记忆", content: "知识 3 条 · 案例 1 条 · 方法 1 条" }, 600);
  const steps = run.task === "data-qa"
    ? [
      ["thought", { content: "先确认口径：档案里约定 total_fee 单位是分、GMV 不含退款。问题问的是 3 月以来，按自然月从 2026-03-01 起算。", tokens: 820 }],
      ["tool_call", { tool: "sql_query", args: { sql: "SELECT date_trunc('month', paid_at) AS m, sum(total_fee)/100.0 AS yuan\nFROM ads_order_daily\nWHERE paid_at >= '2026-03-01'\nGROUP BY 1 ORDER BY 1" } }],
      ["tool_result", { tool: "sql_query", output: "| m | yuan |\n|---|---|\n| 2026-03-01 | 1,284,302.50 |\n| 2026-04-01 | 1,412,880.00 |\n| … | … |\n(8 行)", duration_ms: 842 }],
      ["thought", { content: "数据有 8 个月，汇总并给出月度明细，附 SQL。", tokens: 410 }],
    ]
    : run.task.startsWith("failure-analysis")
      ? [
        ["thought", { content: "报错是上游分区缺失还是代码问题？先看前序交接摘要：昨天同资产同类失败结论是 ods_order 延迟。先查上游物化状态。", tokens: 960 }],
        ["tool_call", { tool: "service_info", args: { what: "config", file: "dagster.yaml" } }],
        ["tool_result", { tool: "service_info", output: "run_coordinator: QueuedRunCoordinator\nstorage: postgres (test-db:5432/dagster)\n…", duration_ms: 35 }],
        ["tool_call", { tool: "bash", args: { command: "cd /srv/dagster && git log -3 --oneline -- assets/dwd/trade_order.py" } }],
        ["tool_result", { tool: "bash", output: "a41c2e9 fix: pay_channel 兼容旧版回调\n7d0f113 feat: 拆分退款\n52be0aa chore: 分区键改 dt", duration_ms: 120 }],
        ["tool_call", { tool: "sql_query", args: { sql: "SELECT partition, status, end_time FROM asset_materializations WHERE asset_key='ods_order' ORDER BY end_time DESC LIMIT 3" } }],
        ["tool_result", { tool: "sql_query", output: "| partition | status | end_time |\n|---|---|---|\n| 2026-10-19 | SUCCESS | 03:41 |\n| 2026-10-18 | SUCCESS | 02:12 |", duration_ms: 230 }],
        ["thought", { content: "ods_order 03:41 才完成，晚于 dwd 的调度时间 03:00。与档案里的已知坑一致。", tokens: 640 }],
      ]
      : [
        ["thought", { content: "按方法资产「看板巡检 v3」逐项执行：数据新鲜度、接口 5xx 比例、主机资源。", tokens: 520 }],
        ["tool_call", { tool: "host_metrics", args: {} }],
        ["tool_result", { tool: "host_metrics", output: "10.0.0.21  内存 61%  负载 0.84  根盘 72%", duration_ms: 410 }],
        ["tool_call", { tool: "sql_query", args: { sql: "SELECT max(dt) FROM ads_gmv_daily" } }],
        ["tool_result", { tool: "sql_query", output: "| max |\n|---|\n| 2026-10-19 |", duration_ms: 95 }],
      ];
  for (const [kind, payload] of steps) push(kind as RunEvent["kind"], payload as RunEvent["payload"], kind === "thought" ? 2400 : kind === "tool_result" ? 900 : 300);
  if (run.status === "running") return (run._events = out);
  if (run.status === "awaiting_approval") {
    push("approval", { title: "等待审批", content: run.task === "data-qa" ? "命中策略 prod-destructive：生产环境的破坏性操作需要人工确认" : "systemctl restart board-prod", approval_id: 101 }, 300);
    return (run._events = out);
  }
  if (run.status === "failed") {
    push("error", { content: run.task === "frontend-smoke" ? "Playwright: Timeout 30000ms exceeded waiting for selector \"#gmv-card\"" : "模型调用失败：429 Too Many Requests（3 个 token 均已限流）" }, 800);
    return (run._events = out);
  }
  if (run.status === "cancelled") {
    push("stage", { stage: "cancelled", title: "已取消", content: "人工取消（lihf）" }, 500);
    return (run._events = out);
  }
  const qa: Record<string, string> = {
    "上周 GMV 环比为什么跌了 12%？": "上周 GMV **环比 -12.1%**，主要来自两处：\n\n1. **华东区大促回落**：前一周有 9.9 大促，华东区 GMV 占比从 41% 回到 34%，贡献了约 -8.6pt；\n2. **退款冲回**：10-15 起一批 9 月订单集中退款，按口径 GMV 不含退款，贡献 -2.9pt。\n\n剔除大促影响后，日均 GMV 与 9 月第三周基本持平（-0.6%）。",
    "退款率指标的口径是什么？": "**退款率 = 当日发起退款的订单数 / 当日支付订单数**。\n\n- 按**发起日**计，不按退款完成日；\n- 分母只算支付成功订单，不含测试店铺（`shop.is_test = true`）；\n- 部分退款也算 1 单。\n\n这条口径来自服务档案，代码位置 `/srv/board/src/metrics/refund.ts`。",
    "新客定义是首单还是首访？": "**首单**。新客 = 首次**支付成功**的用户，不是首次访问。\n\n> 注意：知识库里有一条旧口径（首访）已被取代，看板 2026-08 之前的历史数据仍按首访计，跨期对比时要注意。",
    "7 天留存怎么算的？分母是哪天的新客？": "分母是 **D0 当日的新客**（首单口径），分子是 **D7 当天（含）**有 `app_open` 的人，按自然日计。\n\n例如 10-01 的新客 1,284 人，10-08 有打开的 402 人，7 日留存 = 31.3%。",
    "看板首页 DAU 和埋点平台对不上": "差异来自两处口径不同：\n\n| 项 | 看板 | 埋点平台 |\n|---|---|---|\n| 去重键 | user_id | device_id |\n| 内部账号 | 过滤 | 不过滤 |\n\n昨天看板 DAU 38,120，埋点平台 41,906；按 device_id 去重并保留内部账号重算后为 41,870，差 0.09%，属正常范围。",
  };
  const answer = run.task === "data-qa" && qa[String(run.input.question)]
    ? qa[String(run.input.question)]
    : run.task === "config-audit"
      ? "昨日共 **14 条**配置发布：高风险 1 · 中风险 3 · 低风险 10。\n\n**需要关注**\n- `payment.gateway.timeout` 3s → 30s（payment-svc，prod）：放大 10 倍，超时堆积会拖垮线程池，建议确认是否笔误\n\n**中风险**\n- `db.pool.max` 50 → 20（order-svc）\n- `feature.refund_v2` off → on（board）\n- `cache.ttl.gmv` 600 → 60（board）"
    : run.task === "data-qa"
    ? "3 月以来累计 **total_fee 为 1,082.4 万元**（按自然月，单位已从分换算为元，不含退款）。\n\n| 月份 | 金额（万元） |\n|---|---|\n| 2026-03 | 128.4 |\n| 2026-04 | 141.3 |\n| 2026-05 | 135.0 |\n| 2026-06 | 139.8 |\n| 2026-07 | 133.2 |\n| 2026-08 | 136.7 |\n| 2026-09 | 142.1 |\n| 2026-10（至 19 日） | 125.9 |\n\n```sql\nSELECT date_trunc('month', paid_at) AS m, sum(total_fee)/100.0 AS yuan\nFROM ads_order_daily WHERE paid_at >= '2026-03-01'\nGROUP BY 1 ORDER BY 1\n```"
    : run.task.startsWith("failure-analysis")
      ? "## 根因\n上游 `ods_order` 的 2026-10-19 分区 03:41 才物化完成，晚于 `dwd_trade_order` 03:00 的调度，读到空分区后 merge 失败。\n\n## 证据\n- ods_order 物化记录：end_time 03:41\n- 档案已知坑：上游延迟会级联失败\n\n## 影响范围\n`dwd_trade_order` → `ads_gmv_daily`、`ads_refund_rate` 当日分区未产出。\n\n## 建议\n1. 现在补跑 dwd_trade_order 当日分区（上游已就绪）；\n2. 给 dwd_trade_order 加上游 freshness 依赖，替代固定时间调度。"
      : "巡检完成：**12 项正常，1 项关注**。\n\n- ⚠️ 根盘使用率 72%（阈值 80%），较上周 +6%，建议清理 /srv/board/logs\n- 数据新鲜度：ads_gmv_daily 最新分区 2026-10-19 ✓\n- 接口 5xx 比例 0.02% ✓";
  push("final", { content: answer, tokens: between(600, 1800) }, 2000);
  push("stage", { stage: "finalize", title: "沉淀记忆", content: run.task === "data-qa" ? "知识 1 条（metric:total_fee）" : "案例 1 条 · 交接摘要" }, 1500);
  if (tasks.find((x) => x.name === run.task.split(":")[0])?.output.channel !== "caller") push("stage", { stage: "deliver", title: "投递", content: "dingtalk ✓" }, 400);
  return (run._events = out);
}

export function detailOf(run: MockRun): Run {
  const ev = eventsOf(run);
  const final = ev.find((e) => e.kind === "final");
  const err = ev.find((e) => e.kind === "error");
  const service = services.find((s) => s.name === run.service);
  const task = tasks.find((t) => t.name === run.task);
  const parent = task?.extends ? tasks.find((t) => t.name === task.extends) : null;
  const ctxLines = [...Object.entries(parent?.context ?? {}), ...Object.entries(task?.context ?? {})];
  const profile = [
    service && Object.keys(service.profile).length ? `[档案——服务 ${service.name}：一手事实，逐字保留，优先级最高]\n` + Object.entries(service.profile).map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
    ctxLines.length ? `[档案——任务 ${run.task}：一手事实，逐字保留，优先级最高]\n` + ctxLines.map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  const graph = task?.form === "graph" && task.graph ? {
    nodes: Object.entries(task.graph).map(([id, n]) => ({
      id, kind: (n.code ? "code" : n.route ? "route" : n.map ? "map" : "agent") as "code",
      status: (run.status === "running" ? (id === "changes" ? "materialized" : id === "risk" ? "running" : "pending") : run.status === "failed" && id === "report" ? "failed" : id === "report" && run.status === "success" ? "skipped" : id === "changes" && run.run_id.charCodeAt(0) % 2 ? "reused" : "materialized") as "materialized",
      summary: id === "changes" ? "昨日发布 14 条" : id === "risk" ? "high 1 · mid 3 · low 10" : id === "triage" ? "notify" : "",
    })),
    edges: Object.entries(task.graph).flatMap(([id, n]) => (n.deps ?? []).map((d) => ({ from: d, to: id }))),
  } : null;
  return {
    ...run,
    output: final ? { answer: String(final.payload.content) } : err ? { error: String(err.payload.content) } : null,
    error_code: err ? "model_unavailable" : null,
    pending_approval: run.status === "awaiting_approval" ? approvals.find((a) => a.run_id === run.run_id) ?? null : null,
    context: {
      profile,
      recalled_knowledge: run.resolution === "agent" ? knowledge.filter((k) => k.service === run.service).slice(0, 3).map((k, i) => ({ id: k.id, key: k.key, rank: i + 1 })) : [],
      recalled_assets: run.task === "daily-inspection" ? assetList.filter((a) => a.task === "daily-inspection").slice(0, 1).map((a) => ({ id: a.id, kind: a.kind, name: a.name })) : [],
      saved_knowledge: run.task === "data-qa" && run.status === "success" ? [{ id: 3, key: "metric:total_fee" }] : [],
      saved_assets: [],
      session_runs: runs.filter((x) => x.session_id === run.session_id && x.run_id !== run.run_id).slice(0, 6)
        .map((x) => ({ run_id: x.run_id, task: x.task, status: x.status, created_at: x.created_at })),
      graph,
    },
  };
}

function label(k: string): string {
  return ({ conventions: "口径与术语", no_go: "禁区", env_notes: "环境差异", pitfalls: "常见坑", code_refs: "代码位置", upstream: "上游依赖", downstream: "下游影响", runbook: "运维备注" } as Record<string, string>)[k] ?? k;
}

// ———————— 审批 ————————

export const approvals: Approval[] = [
  { id: 101, kind: "command", run_id: awaiting.run_id, title: "危险命令", detail: "systemctl restart board-prod\n# 原因：巡检发现 node 进程内存持续增长到 3.1G", service: "board", env: "prod", task: "daily-inspection", requested_by: `run:${awaiting.run_id.slice(0, 8)}`, status: "pending", decided_by: null, comment: null, created_at: iso(12 * MIN), decided_at: null, expires_at: new Date(NOW + 18 * MIN).toISOString() },
  { id: 102, kind: "submit", run_id: awaiting2.run_id, title: "提交审批 · 策略 prod-destructive", detail: "生产环境的破坏性操作需要人工确认\n\n问题：把 10 月测试订单从 ads_gmv_daily 删除后重算 GMV", service: "board", env: "prod", task: "data-qa", requested_by: "wangzh", status: "pending", decided_by: null, comment: null, created_at: iso(38 * MIN), decided_at: null, expires_at: null },
  { id: 103, kind: "process", run_id: null, title: "进程启动 · dagster/webserver@prod", detail: "启动 dagster-webserver（prod，端口 3000），租约 2 小时\n# 用于排查 dwd_trade_order 的 UI 运行记录", service: "dagster", env: "prod", task: null, requested_by: "lihf", status: "pending", decided_by: null, comment: null, created_at: iso(4 * MIN), decided_at: null, expires_at: new Date(NOW + 26 * MIN).toISOString() },
  ...Array.from({ length: 14 }, (_, i): Approval => {
    const ok = rand() < 0.78;
    const at = between(2, 70) * HOUR;
    const kind = pick(["command", "command", "submit", "process", "artifact"] as const);
    return {
      id: 90 - i, kind, run_id: kind === "process" ? null : pick(runs).run_id,
      title: { command: "危险命令", submit: "提交审批 · 策略 prod-destructive", process: "进程启动 · board/server@prod", artifact: "产物门禁 · config-audit/report" }[kind],
      detail: { command: pick(["rm -rf /srv/board/logs/2026-09-*", "kill -9 28812", "systemctl restart dagster-daemon-prod"]), submit: "删除 ads_refund_rate 10-18 分区后重算", process: "启动 board server（prod，端口 8080），租约 4 小时", artifact: "triage = escalate：发现 1 条高风险变更（payment.timeout 3s → 30s）" }[kind],
      service: pick(["board", "dagster", "config-center"]), env: "prod", task: kind === "process" ? null : pick(["daily-inspection", "failure-analysis", "config-audit"]),
      requested_by: pick(["lihf", "run:a41c2e90", "wangzh"]), status: ok ? "approved" : "rejected", decided_by: pick(["lihf", "wangzh", "chenyu"]),
      comment: ok ? (rand() < 0.4 ? "确认过影响范围" : null) : "先在 test 复现", created_at: iso(at + 9 * MIN), decided_at: iso(at), expires_at: null,
    };
  }),
];

// ———————— 进程 ————————

export const instances: Instance[] = services.flatMap((s) => Object.entries(s.processes).flatMap(([proc, def]) =>
  envs.map((e): Instance => {
    const running = (s.name === "dagster" && e.name === "test") || (s.name === "board" && e.name !== "dev" && proc === "server") || (s.name === "config-center" && e.name === "test");
    const startedAgo = between(10, 90) * MIN;
    return {
      service: s.name, env: e.name, process: proc, state: running ? "running" : s.name === "report-engine" && e.name === "test" ? "failed" : "stopped",
      port: def.ports?.[e.name] ?? null, pid: running ? between(2000, 39999) : null,
      started_at: running ? iso(startedAgo) : null, lease_until: running ? new Date(NOW - startedAgo + (def.lease_hours ?? 2) * HOUR).toISOString() : null,
      started_by: running ? pick(["lihf", "run:7d0f1132", "wangzh"]) : null,
      last_exit: running ? null : s.name === "report-engine" && e.name === "test" ? { code: 1, at: iso(3 * HOUR) } : { code: 0, at: iso(between(3, 40) * HOUR) },
    };
  })));

// ———————— 记忆 ————————

const kn = (id: number, service: string, env: string, task: string, key: string, content: string, extra: Partial<Knowledge> = {}): Knowledge => ({
  id, service, env, task, key, content, source_run: pick(runs).run_id, code_ref: null, status: "active",
  feedback_score: between(-1, 6), hits_30d: between(0, 60), last_hit_at: iso(between(1, 200) * HOUR), updated_at: iso(between(1, 30) * DAY), ...extra,
});

export const knowledge: Knowledge[] = [
  kn(1, "board", "prod", "data-qa", "metric:gmv", "GMV = 支付成功订单的 total_fee 之和（单位分），不含退款、不含测试店铺（shop.is_test=true）。", { code_ref: { path: "/srv/board/src/metrics/gmv.ts", commit: "a41c2e9" } }),
  kn(2, "board", "prod", "data-qa", "metric:refund_rate", "退款率 = 当日发起退款的订单数 / 当日支付订单数；按发起日计，不按完成日。"),
  kn(3, "board", "prod", "data-qa", "metric:total_fee", "total_fee 字段单位是分；看板展示时除以 100 并保留两位小数。", { hits_30d: 48 }),
  kn(4, "board", "test", "data-qa", "metric:gmv", "test 环境金额乘了 0.8~1.2 的随机系数，不能与 prod 数值对比。"),
  kn(5, "dagster", "prod", "failure-analysis", "pattern:upstream-delay", "dwd 层失败时先查 ods 上游分区完成时间；03:00 后完成的分区会导致级联失败。", { hits_30d: 31 }),
  kn(6, "dagster", "prod", "failure-analysis:dwd_trade_order", "fact:payment-out-of-order", "支付回调乱序会产生 amount<0 的记录，transform_payment() 第 88 行过滤。", { code_ref: { path: "/srv/dagster/assets/dwd/trade_order.py", commit: "7d0f113" }, status: "expired", feedback_score: 0 }),
  kn(7, "dagster", "test", "failure-analysis", "fact:test-db-reset", "test 库每周一 06:00 重置，周一早上的失败大概率是重置窗口内运行。"),
  kn(8, "board", "prod", "daily-inspection", "topology:board", "board 部署在 10.0.0.21，nginx → node(8080)，缓存 redis 10 分钟过期。", { hits_30d: 0, last_hit_at: null }),
  kn(9, "config-center", "prod", "config-audit", "risk:timeout-keys", "payment.*timeout、db.pool.* 类配置变更视为高风险，需要通知。"),
  kn(10, "board", "prod", "data-qa", "metric:dau", "DAU 以埋点 app_open 去重 user_id；与埋点平台口径差异在于看板过滤了内部账号。", { feedback_score: -2 }),
  kn(11, "dagster", "prod", "", "session:dagster:dwd_trade_order:infra:2026-10-18:summary", "## 结论\n上游 ods_order 延迟\n\n## 被否方案\n- 代码回归（近 3 次提交与报错无关）\n\n## 当前约束\n- prod 不能手工 backfill\n\n## 未决问题\n- 是否改为 freshness 依赖"),
  kn(12, "board", "prod", "data-qa", "metric:new_customer", "新客 = 首次支付成功的用户，不是首次访问。", { status: "superseded" }),
  kn(13, "board", "prod", "data-qa", "metric:retention_7d", "7 日留存分母是当日新客，分子是第 7 天（含）有 app_open 的人。"),
  kn(14, "board", "dev", "data-qa", "fact:dev-reset", "dev 库每周一重置，周一上午的数据不完整。"),
];

export const cases: Case[] = [
  { id: 1, service: "dagster", env: "prod", fingerprint: "a3f19c2e", category: "upstream", conclusion: "上游 ods_order 分区延迟导致级联失败", source_run: runs[3].run_id, thumbs_up: 6, thumbs_down: 0, status: "active", updated_at: iso(1 * DAY) },
  { id: 2, service: "dagster", env: "prod", fingerprint: "77be0d41", category: "code", conclusion: "pay_channel 字段在旧版回调里缺失，KeyError", source_run: runs[9].run_id, thumbs_up: 3, thumbs_down: 1, status: "active", updated_at: iso(3 * DAY) },
  { id: 3, service: "dagster", env: "test", fingerprint: "c0d2e9aa", category: "infra", conclusion: "test 库重置窗口内运行导致连接失败", source_run: runs[14].run_id, thumbs_up: 2, thumbs_down: 0, status: "active", updated_at: iso(6 * DAY) },
  { id: 4, service: "board", env: "test", fingerprint: "19aa03fe", category: "code", conclusion: "首页卡片选择器变更，冒烟脚本未同步", source_run: runs[22].run_id, thumbs_up: 1, thumbs_down: 0, status: "active", updated_at: iso(8 * DAY) },
  { id: 5, service: "dagster", env: "prod", fingerprint: "5e8b11c0", category: "infra", conclusion: "worker 内存不足：ads_gmv_daily 全量重算超过 4G", source_run: runs[30].run_id, thumbs_up: 4, thumbs_down: 2, status: "superseded", updated_at: iso(11 * DAY) },
];

export const assetList: Asset[] = [
  { id: 1, service: "board", env: "prod", task: "daily-inspection", kind: "procedure", name: "看板巡检", summary: "13 项检查：数据新鲜度、接口错误率、主机资源、缓存命中", content: "1. SELECT max(dt) FROM ads_gmv_daily —— 应为 T-1\n2. nginx 5xx 比例 < 0.5%（近 1h）\n3. host_metrics：内存 < 85%，根盘 < 80%\n…", files: [], source_run: runs[5].run_id, use_count: 38, last_used_at: iso(6 * HOUR), feedback_score: 4, status: "active", updated_at: iso(4 * DAY) },
  { id: 2, service: "board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite", summary: "Playwright 冒烟脚本：登录、首页 6 张卡片、导出", content: "运行：cd <path> && npx playwright test smoke.spec.ts", files: [{ name: "smoke.spec.ts", size: 4821 }, { name: "playwright.config.ts", size: 612 }, { name: "fixtures/login.json", size: 188 }], source_run: runs[8].run_id, use_count: 22, last_used_at: iso(1 * DAY), feedback_score: 2, status: "active", updated_at: iso(2 * DAY) },
  { id: 3, service: "dagster", env: "prod", task: "failure-analysis", kind: "query", name: "上游分区完成时间", summary: "查某资产所有上游的最近分区完成时间", content: "SELECT a.asset_key, max(m.end_time) FROM asset_deps a JOIN asset_materializations m ON …", files: [], source_run: runs[12].run_id, use_count: 17, last_used_at: iso(5 * HOUR), feedback_score: 3, status: "active", updated_at: iso(6 * DAY) },
  { id: 4, service: "board", env: "prod", task: "", kind: "baseline", name: "首页指标基线", summary: "近 30 天首页 6 个指标的日均与波动区间", content: "gmv: 4.3万±12%\norders: 3,120±9%\n…", files: [], source_run: null, use_count: 9, last_used_at: iso(2 * DAY), feedback_score: 0, status: "active", updated_at: iso(10 * DAY) },
  { id: 5, service: "config-center", env: "prod", task: "config-audit", kind: "procedure", name: "高风险配置判定", summary: "哪些 key 变更算高风险", content: "timeout 类放大 >5 倍、连接池缩小、开关从 on→off 的支付相关配置", files: [], source_run: runs[18].run_id, use_count: 11, last_used_at: iso(1 * DAY), feedback_score: 1, status: "active", updated_at: iso(12 * DAY) },
  { id: 6, service: "board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite-v1", summary: "旧版冒烟脚本（已被 smoke-suite 取代）", content: "", files: [{ name: "smoke.js", size: 2210 }], source_run: null, use_count: 41, last_used_at: iso(20 * DAY), feedback_score: -1, status: "superseded", updated_at: iso(20 * DAY) },
];

// ———————— 对话 ————————

export function sessionsList(): SessionDetail[] {
  const map = new Map<string, MockRun[]>();
  for (const r of runs) if (r.task === "data-qa" && r.trigger.type === "chat") map.set(r.session_id, [...(map.get(r.session_id) ?? []), r]);
  return [...map.entries()].map(([sid, rs]) => {
    const asc = [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const turns: ChatTurn[] = asc.map((r) => {
      const d = detailOf(r);
      return { run_id: r.run_id, question: String(r.input.question), answer: d.output?.answer ?? null, status: r.status, events: eventsOf(r), feedback: r.feedback?.score ?? null, created_at: r.created_at };
    });
    return { session_id: sid, title: String(asc[0].input.question).slice(0, 28), service: asc[asc.length - 1].service, env: asc[asc.length - 1].env, task: "data-qa", runs: rs.length, last_at: asc[asc.length - 1].created_at, turns };
  }).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

export { NOW, MIN, HOUR, DAY, iso, hex, pick, between };
