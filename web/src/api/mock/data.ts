/**
 * mock 数据：确定性随机（固定种子），时间相对"现在"生成，
 * 让预览里的列表、统计、时间线看起来像一个跑了几天的真实平台。
 */
import type {
  ApiKey, Approval, Asset, ChatTurn, Env, FeedbackReason, Instance, Knowledge, ReplayFilter, ReplayVerdict,
  Role, Run, RunEvent, RunStatus, Service, SessionDetail, Settings, Task, Trigger,
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
  { name: "prod", title: "生产", description: "线上环境（受保护：审批打开时这里的危险命令与进程启停要人放行）", protected: true, color: "red" },
  { name: "test", title: "测试", description: "集成测试环境，数据每周从生产脱敏同步", protected: false, color: "amber" },
  { name: "dev", title: "开发", description: "开发自测，库每周一重置", protected: false, color: "blue" },
];

// ———————— 服务 ————————

const by = (name: string, at: number) => ({ updated_by: name, updated_at: iso(at) });

export const services: Service[] = [
  {
    name: "dagster", title: "Dagster 数据编排", description: "数仓 ETL 编排：ods → dwd → ads 三层资产，按天物化",
    root: "/srv/svc/dagster/code/{env}", code_paths: [], repo: "git@gitlab.internal:data/dagster.git", ref: "main",
    python: "/srv/svc/dagster/venv/{env}/bin/python", env_vars: { DAGSTER_HOME: "/srv/svc/dagster/home/{env}", TZ: "Asia/Shanghai" },
    hosts: ["10.0.0.11"], readonly_dsn: null,
    configs: [{ canonical: "/srv/svc/dagster/code/{env}/dagster.yaml", template: "/srv/svc/dagster/conf/{env}/dagster.yaml" },
      { canonical: "/srv/svc/dagster/code/{env}/workspace.yaml", template: "/srv/svc/dagster/conf/{env}/workspace.yaml" }],
    processes: {
      webserver: { cmd: ["{python}", "-m", "dagster_webserver", "-w", "workspace.yaml", "-p", "{port}"], ports: { prod: 3000, test: 3001, dev: 3002 }, lease_hours: 2 },
      daemon: { cmd: ["/srv/svc/dagster/venv/{env}/bin/dagster-daemon", "run", "-w", "workspace.yaml"], lease_hours: 2 },
    },
    urls: { local: "http://127.0.0.1:{port:webserver}" },
    // 服务自己的 MCP：写了 envs 就只在列出的环境可用（dev 没有线上 Dagster，不连）
    mcp: {
      dagster: {
        transport: "stdio", command: "{platform_python}", args: ["{platform}/mcp_servers/dagster_mcp.py"],
        env: { DAGSTER_URL: "{url:deployed}" }, envs: { prod: {}, test: {} },
      },
    },
    envs: {
      prod: { ref: "release", hosts: ["10.0.0.11", "10.0.0.12"], readonly_dsn: "postgresql://ro:${DAGSTER_RO_PASSWORD}@prod-db:5432/dagster", urls: { deployed: "http://10.0.0.11:3000" } },
      test: { ref: "test", hosts: ["10.0.1.11"], readonly_dsn: "postgresql://ro:${DAGSTER_RO_PASSWORD}@test-db:5432/dagster", urls: { deployed: "http://10.0.1.11:3001" } },
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
    root: "/srv/svc/board/code/{env}", code_paths: [], repo: "git@gitlab.internal:bi/board.git", ref: "main",
    python: "/srv/svc/board/venv/{env}/bin/python", env_vars: { BOARD_ENV: "{env}", TZ: "Asia/Shanghai" },
    hosts: ["10.0.0.21"], readonly_dsn: null,
    configs: [{ canonical: "/srv/svc/board/code/{env}/.env", template: "/srv/svc/board/conf/{env}/.env" }],
    processes: { server: { cmd: ["node", "server.js"], ports: { prod: 8080, test: 8081, dev: 8082 }, lease_hours: 4 } },
    urls: { local: "http://127.0.0.1:{port:server}" },
    mcp: {},
    envs: {
      prod: { ref: "release", readonly_dsn: "postgresql://ro:${BOARD_RO_PASSWORD}@prod-db:5432/board", urls: { site: "https://board.internal" } },
      test: { ref: "test", readonly_dsn: "postgresql://ro:${BOARD_RO_PASSWORD}@test-db:5432/board", hosts: ["10.0.1.21"], urls: { site: "https://board-test.internal" } },
      dev: { ref: "dev", readonly_dsn: "postgresql://ro:***@dev-db:5432/board" },
    },
    profile: {
      conventions: "GMV 不含退款；total_fee 单位是分；“本月”按自然月，不是近 30 天",
      pitfalls: "看板缓存 10 分钟，刚改的数据不会立刻出现",
    },
    enabled: true, version: 4, ...by("wangzh", 5 * DAY),
  },
  {
    name: "config-center", title: "配置中心", description: "各服务运行时配置的发布与审计（Java）",
    root: "/srv/svc/config-center/code/{env}", code_paths: [], repo: "git@gitlab.internal:infra/config-center.git", ref: "master",
    python: "", env_vars: { SPRING_PROFILES_ACTIVE: "{env}" },
    hosts: ["10.0.0.31"], readonly_dsn: "postgresql://ro:${CONFIG_RO_PASSWORD}@prod-db:5432/config",
    configs: [{ canonical: "/srv/svc/config-center/code/{env}/application.yaml", template: "/srv/svc/config-center/conf/{env}/application.yaml" }],
    processes: { app: { cmd: ["./bin/config-center", "--port", "{port}"], ports: { prod: 9080, test: 9081, dev: 9082 }, lease_hours: 2 } },
    urls: {}, mcp: {},
    envs: { dev: { enabled: false } },
    profile: { no_go: "发布接口在 prod 只读调用，审计只看不改" },
    enabled: true, version: 2, ...by("lihf", 9 * DAY),
  },
  {
    name: "report-engine", title: "报表引擎", description: "定时报表渲染与邮件分发",
    root: "/srv/report-engine", code_paths: ["/srv/report-engine"], repo: "", ref: "", hosts: ["10.0.0.41"], readonly_dsn: null,
    python: "/srv/report-engine/.venv/bin/python", env_vars: {},
    configs: [{ canonical: "/srv/report-engine/config.toml", template: "/srv/report-engine/conf/config.{env}.toml" }],
    processes: { worker: { cmd: ["{python}", "-m", "report_engine.worker"], workdir: "/srv/report-engine", lease_hours: 2 } },
    urls: {}, mcp: {},
    envs: { test: { python: "/srv/report-engine/.venv-py312/bin/python" } }, profile: {}, enabled: false, version: 1, ...by("chenyu", 14 * DAY),
  },
];

// ———————— 角色 ————————

// tools 可写 "*"（全部内置 + 全部平台 MCP）和 "mcp:<server>"（某个平台 MCP server 的全部工具）；
// 继承：子角色写了 tools（非空）/ subagents（非 null）/ service_tools（非 null）就整体替换父角色的，没写就跟随
export const roles: Role[] = [
  {
    name: "generalist", title: "通用", description: "什么都能做：读代码、跑项目代码、查库、看配置、按需起进程、用服务工具",
    prompt: "你是这个服务的全能工程师，用户可能问口径、查数据、分析报错、看代码、验证改动，也可能交代一件具体的事。\n- 先弄清楚要什么；档案里的约定优先；\n- 跑项目代码用 py，查库用 sql_query，看配置用 service_info；需要长驻才用 service_ctl 起进程，用完停掉；\n- 子问题很深、需要独立排查（报错根因、复杂取数）时，委派给对应的子代理；\n- 结论要可核对：给出依据（命令输出、SQL、代码位置），不确定就明说。",
    tools: ["*"], subagents: ["ops_analyst", "data_searcher"], service_tools: true,
    extends: null, prompt_append: "", version: 1, ...by("seed", 2 * DAY),
  },
  {
    name: "ops_analyst", title: "运维分析", description: "报错定位与根因分析：读日志、读代码、在项目环境里复现、查库",
    prompt: "你是运维分析工程师。拿到一次失败时：\n1. 先看档案里的已知坑、同类报错的教训和前序交接摘要，排除已知原因；\n2. 读相关代码和本环境的配置文件，定位出错的步骤；服务有自己的工具（如 dagster 的运行记录）时先用它看线上现场；\n3. 用 py 在本环境的项目里直接调用出错的函数 / 资产复现；数据假设要验证时可以委派给 data_searcher；\n4. 结论按「根因 / 证据 / 影响范围 / 建议」四段输出。\n\n不要猜测，没有证据的结论标注为推测。",
    tools: ["py", "bash", "run_code", "service_info", "service_ctl", "sql_query", "host_metrics", "save_asset"],
    subagents: ["data_searcher"], service_tools: true,
    extends: null, prompt_append: "", version: 6, ...by("lihf", 3 * DAY),
  },
  {
    name: "data_searcher", title: "数据口径问答", description: "回答指标口径和取数问题，给出依据与结果",
    prompt: "你是数据分析师，回答业务方关于指标口径与数据的问题。\n- 先确认口径（档案里的约定优先），其次读项目代码里的口径实现；\n- 项目里有现成的口径函数就用 py 直接调用，没有再用 sql_query 写 SQL；结果超过 20 行时给汇总；\n- 回答里附上用到的函数或 SQL。",
    tools: ["py", "sql_query", "service_info", "run_code"], subagents: [], service_tools: true,
    extends: null, prompt_append: "", version: 4, ...by("wangzh", 6 * DAY),
  },
  {
    name: "qa_engineer", title: "冒烟测试", description: "部署后按沉淀的方法跑冒烟脚本和页面检查，失败时给出复现步骤",
    prompt: "你是测试工程师。部署完成后执行冒烟测试：优先复用方法里的脚本，不要重写；要看页面时用浏览器工具打开运行环境里列出的地址；失败时给出复现步骤与证据，根因不明显就委派给 ops_analyst。",
    tools: ["py", "bash", "service_info", "service_ctl", "save_asset", "mcp:browser"], subagents: ["ops_analyst"], service_tools: true,
    extends: null, prompt_append: "", version: 3, ...by("chenyu", 8 * DAY),
  },
  {
    name: "inspector", title: "巡检", description: "按沉淀的方法做日常巡检，异常才通知",
    prompt: "",
    tools: ["py", "bash", "service_info", "sql_query", "host_metrics", "save_asset", "notify"], subagents: [], service_tools: null,
    extends: "ops_analyst",
    prompt_append: "你在做巡检：按方法逐项检查，正常项只计数，异常项给证据并用 notify 通知。没有既定方法时先探索，结束后用 save_asset 沉淀成方法。输出控制在 15 行以内。", version: 2, ...by("lihf", 10 * DAY),
  },
];

// ———————— 任务 ————————

const trig = {
  api: (id = "api"): Trigger => ({ id, type: "api" }),
  chat: (id = "chat"): Trigger => ({ id, type: "chat" }),
};

const taskBase = { enabled: true, profile: {}, memory: {}, deliver: null, extends: null, auto_created: false, dedup: null, handler: null };

export const tasks: Task[] = [
  // 通用入口：任何服务、任何环境直接提问或交代一件事，不用先建任务；要定时、事件、投递、去重时再建正式任务
  {
    ...taskBase, name: "ask", title: "问一下", description: "通用入口：对这个服务这个环境直接提问或交代一件事",
    service: "*", role: "generalist", form: "agent",
    input: { question: { type: "text", required: true, description: "问题或要做的事" } },
    envs: [], triggers: [trig.chat(), trig.api()], timeout_s: 900,
    version: 1, ...by("seed", 2 * DAY),
  },
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
    deliver: { channel: "default" }, dedup: { key: "run_id", window_s: 600 }, timeout_s: 300,
    profile: { pitfalls: "资产失败先看上游是否完成，80% 的失败是上游延迟级联" },
    version: 9, ...by("lihf", 1 * DAY),
  },
  {
    ...taskBase, name: "failure-analysis:dwd_trade_order", title: "", description: "", service: "dagster", role: "ops_analyst", form: "agent",
    input: {}, envs: [], triggers: [], deliver: { channel: "default" }, timeout_s: 300, extends: "failure-analysis",
    profile: {
      code_refs: "/srv/dagster/assets/dwd/trade_order.py",
      upstream: "ods_order、ods_payment（03:00 前到齐）",
      pitfalls: "支付回调乱序时会出现 amount 为负的脏数据，过滤规则在 transform_payment()",
    },
    version: 3, ...by("lihf", 2 * DAY),
  },
  {
    ...taskBase, name: "failure-analysis:ads_gmv_daily", title: "", description: "", service: "dagster", role: "ops_analyst", form: "agent",
    input: {}, envs: [], triggers: [], deliver: { channel: "default" }, timeout_s: 300, extends: "failure-analysis", auto_created: true,
    version: 1, ...by("auto:event", 6 * HOUR),
  },
  {
    ...taskBase, name: "data-qa", title: "数据口径问答", description: "业务方提问指标口径、取数；对话页默认任务",
    service: "*", role: "data_searcher", form: "agent",
    input: { question: { type: "text", required: true, description: "问题" } },
    envs: [], triggers: [trig.chat(), trig.api()], deliver: null, timeout_s: 180,
    profile: { conventions: "金额单位统一为元；日期按支付日；口径冲突时以指标字典为准" },
    version: 5, ...by("wangzh", 4 * DAY),
  },
  // 数据口径问答的对象 = 一个指标：每个指标挂自己的口径档案
  {
    ...taskBase, name: "data-qa:gmv", title: "GMV", description: "", service: "*", role: "data_searcher", form: "agent",
    input: {}, envs: [], triggers: [], timeout_s: 180, extends: "data-qa",
    profile: { conventions: "GMV = 已支付订单金额（含运费），不扣退款；退款单独看 refund_amount", code_refs: "ads_gmv_daily.gmv / dwd_trade_order.pay_amount" },
    version: 4, ...by("wangzh", 3 * DAY),
  },
  {
    ...taskBase, name: "data-qa:retention_7d", title: "7 日留存", description: "", service: "*", role: "data_searcher", form: "agent",
    input: {}, envs: [], triggers: [], timeout_s: 180, extends: "data-qa",
    profile: { conventions: "分母 = 当日新增用户（首次 app_open）；分子 = 第 7 天仍有 app_open；内部账号剔除" },
    version: 2, ...by("zhaoq", 6 * DAY),
  },
  {
    ...taskBase, name: "data-qa:refund_rate", title: "退款率", description: "", service: "*", role: "data_searcher", form: "agent",
    input: {}, envs: [], triggers: [], timeout_s: 180, extends: "data-qa", auto_created: true,
    version: 1, ...by("auto:chat", 20 * HOUR),
  },
  {
    ...taskBase, name: "pipeline-debug", title: "数据链路排查", description: "对话里排查某张表、某条链路为什么没数据或数据不对",
    service: "dagster", role: "ops_analyst", form: "agent",
    input: { question: { type: "text", required: true, description: "问题" }, date: { type: "str", description: "业务日期，默认昨天" } },
    envs: ["prod", "test"], triggers: [trig.chat(), trig.api()], timeout_s: 600,
    profile: { pitfalls: "先看上游分区是否到齐，再看本资产的物化日志" },
    version: 3, ...by("lihf", 5 * DAY),
  },
  {
    ...taskBase, name: "pipeline-debug:dwd_trade_order", title: "订单明细表", description: "", service: "dagster", role: "ops_analyst", form: "agent",
    input: {}, envs: [], triggers: [], timeout_s: 600, extends: "pipeline-debug",
    profile: { upstream: "ods_order、ods_payment（03:00 前到齐）", code_refs: "/srv/dagster/assets/dwd/trade_order.py" },
    version: 2, ...by("lihf", 4 * DAY),
  },
  {
    ...taskBase, name: "board-ops", title: "看板运维问答", description: "看板接口慢、页面报错、缓存、发布相关的问题",
    service: "board", role: "ops_analyst", form: "agent",
    input: { question: { type: "text", required: true, description: "问题" } },
    envs: [], triggers: [trig.chat()], timeout_s: 300,
    version: 1, ...by("chenyu", 9 * DAY),
  },
  {
    ...taskBase, name: "frontend-smoke", title: "看板冒烟测试", description: "GitLab 部署成功后跑冒烟脚本",
    service: "board", role: "qa_engineer", form: "agent",
    input: { version: { type: "str", required: true, description: "部署版本（ref）" }, project: { type: "str", description: "GitLab 项目" } },
    envs: ["test", "prod"],
    triggers: [{ id: "on-deploy", type: "event", source: "gitlab", event: "deployment", filter: { project: "^board$" }, map: { version: "ref", project: "project" } }, trig.api()],
    deliver: { channel: "default" }, dedup: { key: "version", window_s: 1800 }, timeout_s: 600,
    version: 4, ...by("chenyu", 7 * DAY),
  },
  {
    ...taskBase, name: "daily-inspection", title: "看板日常巡检", description: "每天早上检查看板数据新鲜度、接口错误率和主机资源",
    service: "board", role: "inspector", form: "agent", input: { scope: { type: "enum", options: ["full", "quick"], default: "full" } },
    envs: ["prod", "test"],
    triggers: [{ id: "morning", type: "schedule", cron: "50 8 * * *", envs: ["prod", "test"], input: { scope: "full" }, timezone: "Asia/Shanghai" }, trig.api()],
    deliver: { channel: "default" }, timeout_s: 600, version: 6, ...by("lihf", 3 * DAY),
  },
  {
    ...taskBase, name: "config-audit", title: "配置变更审计", description: "工作日早上汇总前一天的配置发布，标出高风险变更",
    service: "config-center", role: "ops_analyst", form: "agent", input: {},
    envs: ["prod"],
    triggers: [{ id: "weekday", type: "schedule", cron: "30 8 * * 1-5", envs: ["prod"], input: {} }],
    deliver: { channel: "default" }, timeout_s: 900,
    profile: { conventions: "高风险：timeout 放大 >5 倍、连接池缩小、支付相关开关 on→off；只有高风险才需要单独列出" },
    version: 3, ...by("lihf", 12 * DAY),
  },
  {
    ...taskBase, name: "report-regression", title: "报表回归对比", description: "渲染报表与基线逐格对比", service: "report-engine", role: "inspector", form: "agent",
    input: { report: { type: "str", required: true }, baseline: { type: "str" } }, envs: ["test"],
    triggers: [trig.api()], deliver: { url: "http://10.0.0.41:7000/hooks/regression" }, timeout_s: 900,
    enabled: false, version: 1, ...by("chenyu", 14 * DAY),
  },
  {
    ...taskBase, name: "code-sync", title: "代码同步", description: "把服务在某个环境的代码目录切到指定版本；GitLab 部署成功后自动切到刚部署的提交",
    service: "*", role: null, form: "builtin", handler: "code-sync", envs: [],
    input: { ref: { type: "str", description: "分支 / tag / 提交；不填 = 该环境跟踪的分支" } },
    triggers: [trig.api(), { id: "board-deploy", type: "event", source: "gitlab", event: "deployment", filter: { project: "^board$" }, map: { ref: "sha" }, rules: [], session: null, service: "board" }],
    dedup: { key: "ref", window_s: 300 }, timeout_s: 600, version: 1, ...by("seed", 20 * DAY),
  },
  {
    ...taskBase, name: "memory-gardener", title: "记忆园丁", description: "夜间维护：code_ref 漂移巡检、负反馈条目处置提示",
    service: null, role: null, form: "builtin", handler: "memory-gardener", input: {}, envs: [],
    triggers: [{ id: "nightly", type: "schedule", cron: "0 3 * * *", envs: ["prod", "test", "dev"], input: {} }],
    deliver: null, timeout_s: 1800, version: 2, ...by("seed", 20 * DAY),
  },
];

// ———————— 运行 ————————

const questions = [
  "3 月以来 total_fee 是多少？", "上周 GMV 环比为什么跌了 12%？", "退款率指标的口径是什么？",
  "dwd_trade_order 昨天行数比前天少了一半，正常吗？", "看板首页 DAU 和埋点平台对不上", "新客定义是首单还是首访？",
  "7 天留存怎么算的？分母是哪天的新客？", "华东区 10 月订单量按天给我一下",
];
const askQuestions = [
  "webserver 在 test 起得来吗？起来以后看一眼首页", "昨天 ads_gmv_daily 是几点物化完的？", "帮我看下 config.toml 里缓存 TTL 配的多少",
  "dwd_trade_order 的 transform_payment 在本环境跑一下 10-19 分区", "最近一次部署改了哪些文件？",
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
  _answer?: string;            // 指定最终答案（回归重放的新答案）；不填按任务与问题生成
}

function makeRun(): MockRun {
  const t = rand();
  const picked = t < 0.08 ? "ask" : t < 0.34 ? "data-qa" : t < 0.58 ? "failure-analysis" : t < 0.72 ? "daily-inspection" : t < 0.82 ? "frontend-smoke" : t < 0.9 ? "config-audit" : t < 0.95 ? "memory-gardener" : "failure-analysis:dwd_trade_order";
  const taskName = picked === "data-qa" && rand() < 0.3 ? pick(["data-qa:gmv", "data-qa:retention_7d"]) : picked;
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
    base.name === "data-qa" ? { question: pick(questions) }
      : base.name === "ask" ? { question: pick(askQuestions) }
      : base.name === "failure-analysis" ? { run_id: hex(8) + "-" + hex(4), asset_key: asset, error: err }
        : base.name === "frontend-smoke" ? { version: `v2.${between(10, 40)}.${between(0, 9)}`, project: "board" }
          : base.name === "daily-inspection" ? { scope: "full" } : {};
  const ruleHit = base.name === "failure-analysis" && err.includes("Connection refused") && rand() < 0.7;
  const summary = String(input.question ?? input.asset_key ?? input.version ?? (base.name === "daily-inspection" ? "定时巡检" : base.title));
  const created = iso(ago);
  return {
    run_id: hex(12), session_id: "", task: taskName, task_title: base.title, service, env, role: base.role,
    status: ruleHit ? "success" : status, resolution: ruleHit ? "rule" : status === "running" ? null : base.form === "builtin" ? "builtin" : "agent",
    trigger: trigger as Run["trigger"], summary, tokens: ruleHit || base.form === "builtin" ? 0 : between(2_000, 48_000),
    duration_ms: ruleHit ? between(40, 300) : duration, created_at: created,
    finished_at: status === "running" ? null : new Date(NOW - ago + (duration ?? 0)).toISOString(),
    task_version: base.version - (rand() < 0.2 ? 1 : 0), role_version: base.role ? roles.find((r) => r.name === base.role)!.version : null,
    replay_of: null, input, output: null, error_code: null, pending_approval: null,
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
    feedback: [],
    memory: {},
    _events: undefined,
  };
}

export const runs: MockRun[] = Array.from({ length: 260 }, () => makeRun())
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

// 反馈：约 15% 的已结束运行有人评价；负反馈带问题类型与说明，少数针对某一步
const NEGATIVE: { reasons: FeedbackReason[]; comment: string; step?: number }[] = [
  { reasons: ["wrong_definition"], comment: "GMV 不扣退款，退款单独看 refund_amount；这里把退款减掉了。" },
  { reasons: ["wrong_data"], comment: "应该按支付日 pay_date 统计，不是下单日。" },
  { reasons: ["incomplete"], comment: "只给了华东，没给分省明细。" },
  { reasons: ["wrong_conclusion", "detour"], comment: "根因是上游 ods_payment 延迟，不是代码问题；查了半天无关的日志。" },
  { reasons: ["wrong_tool"], comment: "这里应该查 test 的只读库，不该用 bash 去 grep 日志。", step: 4 },
  { reasons: ["off_topic"], comment: "" },
  { reasons: ["unsafe"], comment: "不要在 prod 上直接重启 webserver，先在 test 复现。", step: 3 },
];
const PEOPLE = ["wangzh", "zhaoq", "lihf", "chenyu"];
for (const r of runs) {
  if (r.status === "running" || r.status === "queued" || r.resolution !== "agent" || rand() > 0.15) continue;
  const by = pick(PEOPLE);
  const negative = rand() < 0.45;
  const at = new Date(new Date(r.created_at).getTime() + between(5, 300) * 60_000).toISOString();
  const base = { id: r.feedback.length + Math.floor(rand() * 1e6), run_id: r.run_id, created_by: by, created_at: at, updated_at: at };
  if (!negative) { r.feedback.push({ ...base, step_seq: 0, score: 1, reasons: [], comment: rand() < 0.3 ? "结论准确，省了半小时。" : "" }); continue; }
  const n = pick(NEGATIVE);
  r.feedback.push({ ...base, step_seq: n.step ?? 0, score: -1, reasons: n.reasons, comment: n.comment });
}

// 会话：data-qa 的对话 run 串成会话；其余 run 自会话
const sessionPool = Array.from({ length: 9 }, () => hex(12));
for (const r of runs) {
  if (r.task.startsWith("data-qa") && r.trigger.type === "chat") r.session_id = (r.task === "data-qa" ? "" : r.task.split(":")[1] + "-") + pick(sessionPool);
  else if (r.task === "ask" && r.trigger.type === "chat") r.session_id = "ask-" + pick(sessionPool.slice(0, 4));
  else if (r.task.startsWith("failure-analysis") && r.input.asset_key) r.session_id = `dagster:${r.input.asset_key}:infra:${r.created_at.slice(0, 10)}`;
  else r.session_id = r.run_id;
}

// 审批默认关闭（设置 → 审批）：没有挂起中的运行；审批记录只剩之前打开时处理过的

// ———————— 回归重放（样例） ————————
// 拿被 👎 的 agent 运行用当前定义重跑（新会话、不沉淀、不投递），模型对照原答案 + 人指出的问题 + 新答案判定

// 样例至少要有几条被 👎 的问答与失败分析
for (const [prefix, want] of [["data-qa", 5], ["failure-analysis", 3]] as const) {
  const finished = runs.filter((r) => r.task.startsWith(prefix) && r.resolution === "agent" && r.status !== "running" && r.status !== "queued");
  let have = finished.filter((r) => r.feedback.some((f) => f.score < 0)).length;
  for (const r of finished) {
    if (have >= want) break;
    if (r.feedback.length) continue;
    const n = prefix === "data-qa" ? NEGATIVE[have % 3] : NEGATIVE[3];
    const at = new Date(new Date(r.created_at).getTime() + 40 * MIN).toISOString();
    r.feedback.push({ id: 900_000 + r.feedback.length + have + (prefix === "data-qa" ? 0 : 50), run_id: r.run_id, created_by: "zhaoq", created_at: at, updated_at: at, step_seq: 0, score: -1, reasons: n.reasons, comment: n.comment });
    have++;
  }
}

export interface MockReplayItem {
  id: number;
  source_run: string;
  new_run: string | null;
  verdict: ReplayVerdict | null;
  reason: string;
  judged_at: string | null;
  _attempts?: number;          // mock 重判计数（让"判断不了"的重判后有变化）
}

export interface MockReplay {
  id: number;
  title: string;
  filter: ReplayFilter;
  note: string;
  created_by: string;
  created_at: string;
  items: MockReplayItem[];
}

/** 用当前定义重放一条原运行：同样的任务 / 服务 / 环境 / 输入，新会话，trigger=replay */
export function replayRunOf(source: MockRun, createdAt: string, status: RunStatus, caller: string, answer?: string): MockRun {
  const parent = tasks.find((t) => t.name === source.task.split(":")[0]);
  const run_id = hex(12);
  const done = status !== "running" && status !== "queued";
  return {
    ...source, run_id, session_id: run_id, status, resolution: done ? "agent" : null,
    trigger: { type: "replay", id: source.run_id, source: null, caller },
    tokens: done ? between(3_000, 30_000) : null, duration_ms: done ? between(8_000, 60_000) : null,
    created_at: createdAt, finished_at: done ? new Date(new Date(createdAt).getTime() + 40_000).toISOString() : null,
    task_version: parent?.version ?? source.task_version, role_version: roles.find((r) => r.name === source.role)?.version ?? null,
    replay_of: source.run_id, input: source.input, output: null, error_code: null, pending_approval: null, feedback: [], memory: {},
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
    _events: undefined, _answer: answer,
  };
}

const ANSWERS: Record<string, string> = {
  qaFixed: "按口径重算：GMV = 已支付订单金额，**不扣退款**（退款单独看 `refund_amount`），按**支付日** `pay_date` 统计。\n\n近 7 天 GMV 合计 **31.8 万元**，日均 4.54 万，较前 7 天 **+3.6%**。",
  qaSame: "近 7 天 GMV 合计 **29.4 万元**（已扣除退款），按下单日统计，较前 7 天 +2.1%。",
  qaWorse: "近 7 天 GMV 合计 **27.1 万元**：已扣除退款，并把测试店铺的订单也计入了。",
  qaUnclear: "改用 ads_gmv_daily 的预聚合结果：近 7 天 GMV 合计 **31.2 万元**。与明细表的差异需要核对分区是否到齐。",
  faFixed: "## 根因\n上游 `ods_payment` 的 10-19 分区 03:52 才到齐，晚于 `dwd_trade_order` 03:00 的调度，读到空分区后 merge 失败。\n\n## 证据\n- ods_payment 物化记录：end_time 03:52\n- 本资产近 3 次提交与报错无关\n\n## 建议\n等上游到齐后补跑当日分区；给 dwd_trade_order 加上游 freshness 依赖。",
};

const negatives = runs.filter((r) => r.resolution === "agent" && r.feedback.some((f) => f.score < 0));
const taken = new Set<string>();
const sample = (list: MockRun[], n: number) => {
  const out = list.filter((r) => !taken.has(r.run_id)).slice(0, n);
  out.forEach((r) => taken.add(r.run_id));
  return out;
};
let replayItemId = 1;
export const nextReplayItemId = () => replayItemId++;

/** plans：[原运行, 判定（null = 重放还在跑）, 理由, 新答案]；判定 error = 重放没建成 */
function makeReplay(id: number, title: string, filter: ReplayFilter, note: string, by: string, msAgo: number,
  plans: [MockRun, ReplayVerdict | null, string, string?][]): MockReplay {
  const createdAt = iso(msAgo);
  const judgedAt = new Date(NOW - msAgo + 90_000).toISOString();
  const items = plans.map(([src, verdict, reason, answer]): MockReplayItem => {
    const parent = tasks.find((t) => t.name === src.task.split(":")[0]);
    if (parent) src.task_version = Math.max(1, parent.version - 1);     // 原运行停在上一版定义
    if (verdict === "error") return { id: nextReplayItemId(), source_run: src.run_id, new_run: null, verdict, reason, judged_at: createdAt };
    const run = replayRunOf(src, createdAt, verdict === null ? "running" : "success", by, answer);
    runs.push(run);
    return { id: nextReplayItemId(), source_run: src.run_id, new_run: run.run_id, verdict, reason, judged_at: verdict ? judgedAt : null };
  });
  return { id, title, filter, note, created_by: by, created_at: createdAt, items };
}

const qaNeg = sample(negatives.filter((r) => r.task.startsWith("data-qa")), 5);
const faNeg = sample(negatives.filter((r) => r.task.startsWith("failure-analysis")), 3);
const oneNeg = sample(negatives, 1);
const QA_PLAN: [ReplayVerdict, string, string][] = [
  ["fixed", "新答案按支付日统计、不再扣减退款，被指出的口径问题已解决，也没有引入新的错误。", ANSWERS.qaFixed],
  ["fixed", "新答案改为不扣退款并单列 refund_amount，与人指出的口径一致。", ANSWERS.qaFixed],
  ["same", "新答案仍按下单日统计、仍扣了退款，人指出的问题还在。", ANSWERS.qaSame],
  ["worse", "新答案仍扣了退款，还把测试店铺订单算了进来，比原答案更偏。", ANSWERS.qaWorse],
  ["unclear", "新答案换了取数表，结果是否正确要核对实际分区数据才能判断。", ANSWERS.qaUnclear],
];
const FA_PLAN: [ReplayVerdict | null, string, string?][] = [
  ["fixed", "新答案把根因落到上游 ods_payment 延迟，并给出补跑建议，没有再归因到代码。", ANSWERS.faFixed],
  ["error", "提交被拒绝：服务 dagster 在 dev 环境已停用"],
  [null, ""],
];

export const replays: MockReplay[] = [
  makeReplay(3, "failure-analysis · dagster · 3 条 👎", { task: "failure-analysis", service: "dagster", limit: 20 },
    "failure-analysis 的任务档案补了上游依赖：ods_order、ods_payment 03:00 前到齐", "lihf", 2 * MIN,
    faNeg.map((r, i) => [r, ...FA_PLAN[i % FA_PLAN.length]] as [MockRun, ReplayVerdict | null, string, string?])),
  makeReplay(2, "全部 · 1 条 👎", { run_ids: oneNeg.map((r) => r.run_id) }, "单独验证一条：改了任务档案之后", "wangzh", 26 * HOUR,
    oneNeg.map((r) => [r, "fixed", "新答案针对人指出的问题做了修正，没有引入新的错误。"] as [MockRun, ReplayVerdict, string])),
  makeReplay(1, "data_searcher 提示词 v4 回归", { task: "data-qa", hours: 168, limit: 20 },
    "data_searcher 的提示词补了「GMV 不扣退款，退款单独看 refund_amount；按支付日统计」", "wangzh", 2 * DAY,
    qaNeg.map((r, i) => [r, ...QA_PLAN[i % QA_PLAN.length]] as [MockRun, ReplayVerdict, string, string])),
];
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
    out.push({ seq: ++seq, kind, at: new Date(t).toISOString(), payload });
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
  push("stage", { stage: "recall", title: "召回记忆", content: run.task.startsWith("failure-analysis") ? "事实 2 条 · 教训 1 条 · 方法 1 条" : "事实 3 条 · 方法 1 条" }, 600);
  const steps = run.task === "ask"
    ? [
      ["thought", { content: "先看运行环境：项目 Python、配置文件、地址都已列出。问题要在本环境的项目里验证，用 py 直接调项目函数。", tokens: 640 }],
      ["tool_call", { tool: "py", args: { code: "from board.metrics import cache\nprint(cache.ttl_seconds(), cache.backend())" } }],
      ["tool_result", { tool: "py", output: "600 redis://10.0.0.21:6379/2", duration_ms: 310 }],
      ["thought", { content: "结果与配置文件一致，整理成结论并附上依据。", tokens: 280 }],
    ]
    : run.task === "data-qa"
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
    const pending = approvals.find((a) => a.run_id === run.run_id && a.status === "pending");
    push("approval", { title: "等待审批 · 危险命令", content: pending?.detail ?? "systemctl restart board-prod", approval_id: pending?.id }, 300);
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
  const answer = run._answer ?? (run.task.startsWith("data-qa") && qa[String(run.input.question)]
    ? qa[String(run.input.question)]
    : run.task === "ask"
      ? `在 ${run.service}@${run.env} 的项目环境里直接验证了：缓存 TTL 为 **600 秒**，后端是 redis（10.0.0.21:6379/2），与本环境配置文件一致。\n\n依据：\`board.metrics.cache.ttl_seconds()\` 的返回值。需要定期检查的话，可以建一个正式任务配上定时触发。`
    : run.task === "config-audit"
      ? "昨日共 **14 条**配置发布：高风险 1 · 中风险 3 · 低风险 10。\n\n**需要关注**\n- `payment.gateway.timeout` 3s → 30s（payment-svc，prod）：放大 10 倍，超时堆积会拖垮线程池，建议确认是否笔误\n\n**中风险**\n- `db.pool.max` 50 → 20（order-svc）\n- `feature.refund_v2` off → on（board）\n- `cache.ttl.gmv` 600 → 60（board）"
    : run.task.startsWith("data-qa")
    ? "3 月以来累计 **total_fee 为 1,082.4 万元**（按自然月，单位已从分换算为元，不含退款）。\n\n| 月份 | 金额（万元） |\n|---|---|\n| 2026-03 | 128.4 |\n| 2026-04 | 141.3 |\n| 2026-05 | 135.0 |\n| 2026-06 | 139.8 |\n| 2026-07 | 133.2 |\n| 2026-08 | 136.7 |\n| 2026-09 | 142.1 |\n| 2026-10（至 19 日） | 125.9 |\n\n```sql\nSELECT date_trunc('month', paid_at) AS m, sum(total_fee)/100.0 AS yuan\nFROM ads_order_daily WHERE paid_at >= '2026-03-01'\nGROUP BY 1 ORDER BY 1\n```"
    : run.task.startsWith("failure-analysis")
      ? "## 根因\n上游 `ods_order` 的 2026-10-19 分区 03:41 才物化完成，晚于 `dwd_trade_order` 03:00 的调度，读到空分区后 merge 失败。\n\n## 证据\n- ods_order 物化记录：end_time 03:41\n- 档案已知坑：上游延迟会级联失败\n\n## 影响范围\n`dwd_trade_order` → `ads_gmv_daily`、`ads_refund_rate` 当日分区未产出。\n\n## 建议\n1. 现在补跑 dwd_trade_order 当日分区（上游已就绪）；\n2. 给 dwd_trade_order 加上游 freshness 依赖，替代固定时间调度。"
      : "巡检完成：**12 项正常，1 项关注**。\n\n- ⚠️ 根盘使用率 72%（阈值 80%），较上周 +6%，建议清理 /srv/board/logs\n- 数据新鲜度：ads_gmv_daily 最新分区 2026-10-19 ✓\n- 接口 5xx 比例 0.02% ✓");
  push("final", { content: answer, tokens: between(600, 1800) }, 2000);
  // 回归重放：新会话、不沉淀记忆、不投递
  if (run.trigger.type === "replay") return (run._events = out);
  push("stage", { stage: "finalize", title: "沉淀记忆", content: run.task === "data-qa" ? "事实 1 条（metric:total_fee）" : run.task.startsWith("failure-analysis") ? "教训 1 条 · 交接摘要" : "交接摘要" }, 1500);
  if (tasks.find((x) => x.name === run.task.split(":")[0])?.deliver) push("stage", { stage: "deliver", title: "投递", content: "渠道 default ✓" }, 400);
  return (run._events = out);
}

export function detailOf(run: MockRun): Run {
  const ev = eventsOf(run);
  const final = ev.find((e) => e.kind === "final");
  const err = ev.find((e) => e.kind === "error");
  const service = services.find((s) => s.name === run.service);
  const task = tasks.find((t) => t.name === run.task);
  const parent = task?.extends ? tasks.find((t) => t.name === task.extends) : null;
  const ctxLines = Object.entries({ ...(parent?.profile ?? {}), ...(task?.profile ?? {}) });
  const profile = [
    service && Object.keys(service.profile).length ? `[档案——服务 ${service.name}：一手事实，逐字保留，优先级最高]\n` + Object.entries(service.profile).map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
    ctxLines.length ? `[档案——任务 ${run.task}：一手事实，逐字保留，优先级最高]\n` + ctxLines.map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  // 召回：该环境的 + 所有环境通用的；教训优先给失败分析
  const recallable = knowledge.filter((k) => k.service === run.service && k.status === "active" && k.kind !== "handoff" && (!k.env || k.env === run.env))
    .sort((a, b) => (run.task.startsWith("failure-analysis") ? Number(b.kind === "lesson") - Number(a.kind === "lesson") : Number(a.kind === "lesson") - Number(b.kind === "lesson")));
  const replay = run.trigger.type === "replay";
  const savedLesson = knowledge.find((k) => k.kind === "lesson" && k.service === run.service && k.task.startsWith("failure-analysis"));
  return {
    ...run,
    output: final ? { answer: String(final.payload.content) } : err ? { error: String(err.payload.content) } : null,
    error_code: err ? "model_unavailable" : null,
    pending_approval: run.status === "awaiting_approval" ? approvals.find((a) => a.run_id === run.run_id) ?? null : null,
    context: {
      profile,
      recalled_knowledge: run.resolution === "agent" ? recallable.slice(0, 3).map((k, i) => ({ id: k.id, key: k.key, kind: k.kind, rank: i + 1 })) : [],
      recalled_assets: run.task === "daily-inspection" ? assetList.filter((a) => a.task === "daily-inspection").slice(0, 1).map((a) => ({ id: a.id, kind: a.kind, name: a.name })) : [],
      saved_knowledge: replay || run.status !== "success" || run.resolution !== "agent" ? []
        : run.task === "data-qa" ? [{ id: 3, key: "metric:total_fee", kind: "fact" }]
          : run.task.startsWith("failure-analysis") && savedLesson ? [{ id: savedLesson.id, key: savedLesson.key, kind: "lesson" }] : [],
      saved_assets: [],
      session_runs: runs.filter((x) => x.session_id === run.session_id && x.run_id !== run.run_id).slice(0, 6)
        .map((x) => ({ run_id: x.run_id, task: x.task, status: x.status, created_at: x.created_at })),
    },
  };
}

function label(k: string): string {
  return ({ conventions: "口径与术语", no_go: "禁区", env_notes: "环境差异", pitfalls: "常见坑", code_refs: "代码位置", upstream: "上游依赖", downstream: "下游影响", runbook: "运维备注" } as Record<string, string>)[k] ?? k;
}

// ———————— 审批 ————————
// 只有危险命令与进程启停两类；审批默认关闭，这里是之前打开时留下的记录（103 是关闭前提交、还没处理的一条）

export const approvals: Approval[] = [
  { id: 103, kind: "process", run_id: null, title: "进程启动 · dagster/webserver@prod", detail: "启动 dagster-webserver（prod，端口 3000），租约 2 小时\n# 用于排查 dwd_trade_order 的 UI 运行记录", service: "dagster", env: "prod", task: null, payload: { service: "dagster", env: "prod", process: "webserver", action: "start", executor: "api" }, requested_by: "lihf", status: "pending", decided_by: null, comment: null, created_at: iso(4 * MIN), decided_at: null, expires_at: new Date(NOW + 26 * MIN).toISOString() },
  ...Array.from({ length: 14 }, (_, i): Approval => {
    const ok = rand() < 0.78;
    const at = between(2, 70) * HOUR;
    const kind = pick(["command", "command", "command", "process", "process"] as const);
    return {
      id: 90 - i, kind, run_id: kind === "process" ? null : pick(runs).run_id,
      title: { command: "危险命令", process: pick(["进程启动 · board/server@prod", "进程停止 · dagster/webserver@prod"]) }[kind],
      detail: { command: pick(["rm -rf /srv/board/logs/2026-09-*", "kill -9 28812", "systemctl restart dagster-daemon-prod"]), process: "lihf 请求在 prod 启停进程（租约 4 小时）" }[kind],
      service: pick(["board", "dagster", "config-center"]), env: "prod", task: kind === "process" ? null : pick(["daily-inspection", "failure-analysis", "config-audit"]), payload: {},
      requested_by: pick(["lihf", "run:a41c2e90", "wangzh"]), status: ok ? "approved" : "rejected", decided_by: pick(["lihf", "wangzh", "chenyu"]),
      comment: ok ? (rand() < 0.4 ? "确认过影响范围" : null) : "先在 test 复现", created_at: iso(at + 9 * MIN), decided_at: iso(at), expires_at: null,
    };
  }),
];

// ———————— 进程 ————————

export const instances: Instance[] = services.flatMap((s) => Object.entries(s.processes).flatMap(([proc, def]) =>
  envs.map((e): Instance => {
    const running = (s.name === "dagster" && e.name === "test") || (s.name === "board" && e.name === "test" && proc === "server") || (s.name === "config-center" && e.name === "test");
    const startedAgo = between(10, 90) * MIN;
    return {
      service: s.name, env: e.name, process: proc, state: running ? "running" : s.name === "report-engine" && e.name === "test" ? "failed" : "stopped",
      port: def.ports?.[e.name] ?? null, pid: running ? between(2000, 39999) : null,
      started_at: running ? iso(startedAgo) : null, lease_until: running ? new Date(NOW - startedAgo + (def.lease_hours ?? 2) * HOUR).toISOString() : null,
      started_by: running ? pick(["lihf", "run:7d0f1132", "wangzh"]) : null,
      last_exit: running ? null : s.name === "report-engine" && e.name === "test" ? { code: 1, at: iso(3 * HOUR) } : { code: 0, at: iso(between(3, 40) * HOUR) },
      enabled: s.enabled && s.envs[e.name]?.enabled !== false,
    };
  })));

// ———————— 记忆 ————————

// 记忆 = agent 记下的（人写的档案在服务 / 任务定义里）。env "" = 对该服务所有环境成立。
// feedback_score 只罚不奖（≤ 0）：被 👎 的运行沉淀或召回过它才扣分。

const kn = (id: number, service: string, env: string, task: string, key: string, content: string, hits: number, extra: Partial<Knowledge> = {}): Knowledge => ({
  id, service, env, task, kind: "fact", key, content, fingerprint: null, category: null,
  source_run: pick(runs).run_id, code_ref: null, status: "active", superseded_by: null,
  feedback_score: 0, hits_30d: hits, last_hit_at: hits ? iso(between(1, 200) * HOUR) : null, updated_at: iso(between(1, 30) * DAY), ...extra,
});

/** 教训：报错 → 结论；key = lesson:<指纹>，同一服务同一指纹只有一条 */
const lesson = (id: number, service: string, env: string, task: string, fp: string, category: string, conclusion: string, error: string, hits: number, extra: Partial<Knowledge> = {}) =>
  kn(id, service, env, task, `lesson:${fp}`, `${conclusion}\n（报错：${error}）`, hits, { kind: "lesson", fingerprint: fp, category, ...extra });

export const knowledge: Knowledge[] = [
  kn(1, "board", "", "data-qa", "metric:gmv", "GMV = 支付成功订单的 total_fee 之和（单位分），不含退款、不含测试店铺（shop.is_test=true）。", 46, { code_ref: { path: "/srv/board/src/metrics/gmv.ts", commit: "a41c2e9" } }),
  kn(2, "board", "prod", "data-qa", "metric:refund_rate", "退款率 = 当日发起退款的订单数 / 当日支付订单数；按发起日计，不按完成日。", 12),
  kn(3, "board", "", "data-qa", "metric:total_fee", "total_fee 字段单位是分；看板展示时除以 100 并保留两位小数。", 48),
  kn(4, "board", "test", "data-qa", "fact:test-amount-noise", "test 环境金额乘了 0.8~1.2 的随机系数，不能与 prod 数值对比。", 9),
  kn(5, "dagster", "", "failure-analysis", "pattern:upstream-delay", "dwd 层失败时先查 ods 上游分区完成时间；03:00 后完成的分区会导致级联失败。", 31),
  kn(6, "dagster", "prod", "failure-analysis:dwd_trade_order", "fact:payment-out-of-order", "支付回调乱序会产生 amount<0 的记录，transform_payment() 第 88 行过滤。", 4, { code_ref: { path: "/srv/dagster/assets/dwd/trade_order.py", commit: "7d0f113" }, status: "expired" }),
  kn(7, "dagster", "test", "failure-analysis", "fact:test-db-reset", "test 库每周一 06:00 重置，周一早上的失败大概率是重置窗口内运行。", 14),
  kn(8, "board", "prod", "daily-inspection", "topology:board", "board 部署在 10.0.0.21，nginx → node(8080)，缓存 redis 10 分钟过期。", 0),
  kn(9, "config-center", "prod", "config-audit", "risk:timeout-keys", "payment.*timeout、db.pool.* 类配置变更视为高风险，需要通知。", 22),
  kn(10, "board", "prod", "data-qa", "metric:dau", "DAU 以埋点 app_open 去重 user_id；与埋点平台口径差异在于看板过滤了内部账号。", 24, { feedback_score: -2 }),
  kn(11, "dagster", "prod", "failure-analysis:dwd_trade_order", "session:dagster:dwd_trade_order:infra:2026-10-18:summary", "## 结论\n上游 ods_order 延迟\n\n## 被否方案\n- 代码回归（近 3 次提交与报错无关）\n\n## 当前约束\n- prod 不能手工 backfill\n\n## 未决问题\n- 是否改为 freshness 依赖", 3, { kind: "handoff" }),
  kn(12, "board", "", "data-qa", "metric:new_customer_v1", "新客 = 首次访问的用户（2026-08 之前的旧口径）。", 0, { status: "superseded", superseded_by: "metric:new_customer" }),
  kn(13, "board", "", "data-qa:retention_7d", "metric:retention_7d", "7 日留存分母是当日新客，分子是第 7 天（含）有 app_open 的人。", 7),
  kn(14, "board", "dev", "data-qa", "fact:dev-reset", "dev 库每周一重置，周一上午的数据不完整。", 3),
  kn(15, "board", "", "data-qa", "metric:new_customer", "新客 = 首次支付成功的用户，不是首次访问；2026-08 之前的历史数据仍按首访计。", 16),
  kn(16, "board", "", "data-qa:gmv", "metric:gmv_refund", "GMV 不扣退款，退款单独看 refund_amount。", 0, { status: "superseded", superseded_by: "profile:service:board:conventions", source_run: null }),
  // 教训（原"案例"）：同类报错再出现时按指纹精确命中
  lesson(17, "dagster", "prod", "failure-analysis", "a3f19c2e5b7d8810", "upstream", "上游 ods_order 分区延迟导致级联失败：等上游到齐后补跑当日分区",
    "dagster._core.errors.DagsterExecutionStepExecutionError: upstream asset ods_order partition ? missing", 11),
  lesson(18, "dagster", "", "failure-analysis", "77be0d41c9a2f063", "code", "pay_channel 字段在旧版回调里缺失：transform_payment() 里改用 .get 兜底",
    "KeyError: '?'", 6, { feedback_score: -1 }),
  lesson(19, "dagster", "test", "failure-analysis", "c0d2e9aa71f4b3e5", "infra", "test 库重置窗口（周一 06:00）内运行导致连接失败，窗口过后重跑即可",
    "psycopg.OperationalError: connection to server at \"?\", port ? failed: Connection refused", 4),
  lesson(20, "board", "test", "frontend-smoke", "19aa03fe8c6d2b47", "code", "首页卡片选择器改成了 [data-card=gmv]，冒烟脚本没同步",
    "Playwright: Timeout ?ms exceeded waiting for selector \"?\"", 3),
  lesson(21, "dagster", "prod", "failure-analysis", "5e8b11c0d4e6a9f2", "infra", "worker 内存不足：ads_gmv_daily 全量重算超过 4G，改成按分区重算",
    "MemoryError: Unable to allocate ? GiB for an array", 0, { status: "expired" }),
];

/** mock 用 30 天命中次数近似"近 30 天被 ≥5 次运行召回" */
export const PROMOTE_MIN_HITS = 20;
export const isPromotable = (k: Knowledge) => k.kind === "fact" && k.status === "active" && k.feedback_score >= 0 && k.hits_30d >= PROMOTE_MIN_HITS;

export const assetList: Asset[] = [
  { id: 1, service: "board", env: "prod", task: "daily-inspection", kind: "procedure", name: "看板巡检", summary: "13 项检查：数据新鲜度、接口错误率、主机资源、缓存命中", content: "1. SELECT max(dt) FROM ads_gmv_daily —— 应为 T-1\n2. nginx 5xx 比例 < 0.5%（近 1h）\n3. host_metrics：内存 < 85%，根盘 < 80%\n…", files: [], source_run: runs[5].run_id, use_count: 38, last_used_at: iso(6 * HOUR), feedback_score: 0, status: "active", updated_at: iso(4 * DAY) },
  { id: 2, service: "board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite", summary: "Playwright 冒烟脚本：登录、首页 6 张卡片、导出", content: "运行：cd <path> && npx playwright test smoke.spec.ts", files: [{ name: "smoke.spec.ts", size: 4821 }, { name: "playwright.config.ts", size: 612 }, { name: "fixtures/login.json", size: 188 }], source_run: runs[8].run_id, use_count: 22, last_used_at: iso(1 * DAY), feedback_score: 0, status: "active", updated_at: iso(2 * DAY) },
  { id: 3, service: "dagster", env: "prod", task: "failure-analysis", kind: "query", name: "上游分区完成时间", summary: "查某资产所有上游的最近分区完成时间", content: "SELECT a.asset_key, max(m.end_time) FROM asset_deps a JOIN asset_materializations m ON …", files: [], source_run: runs[12].run_id, use_count: 17, last_used_at: iso(5 * HOUR), feedback_score: -1, status: "active", updated_at: iso(6 * DAY) },
  { id: 4, service: "board", env: "prod", task: "", kind: "baseline", name: "首页指标基线", summary: "近 30 天首页 6 个指标的日均与波动区间", content: "gmv: 4.3万±12%\norders: 3,120±9%\n…", files: [], source_run: null, use_count: 9, last_used_at: iso(2 * DAY), feedback_score: 0, status: "active", updated_at: iso(10 * DAY) },
  { id: 5, service: "config-center", env: "prod", task: "config-audit", kind: "procedure", name: "高风险配置判定", summary: "哪些 key 变更算高风险", content: "timeout 类放大 >5 倍、连接池缩小、开关从 on→off 的支付相关配置", files: [], source_run: runs[18].run_id, use_count: 11, last_used_at: iso(1 * DAY), feedback_score: 0, status: "active", updated_at: iso(12 * DAY) },
  { id: 6, service: "board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite-v1", summary: "旧版冒烟脚本（已被 smoke-suite 取代）", content: "", files: [{ name: "smoke.js", size: 2210 }], source_run: null, use_count: 41, last_used_at: iso(20 * DAY), feedback_score: -1, status: "superseded", updated_at: iso(20 * DAY) },
];

// ———————— 对话 ————————

export function sessionsList(): SessionDetail[] {
  const map = new Map<string, MockRun[]>();
  for (const r of runs) if ((r.task.startsWith("data-qa") || r.task === "ask") && r.trigger.type === "chat") map.set(r.session_id, [...(map.get(r.session_id) ?? []), r]);
  return [...map.entries()].map(([sid, rs]) => {
    const asc = [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const turns: ChatTurn[] = asc.map((r) => {
      const d = detailOf(r);
      return { run_id: r.run_id, question: String(r.input.question), answer: d.output?.answer ?? null, status: r.status, events: eventsOf(r), feedback: r.feedback.find((f) => f.step_seq === 0 && f.created_by === "lihf") ?? null, created_at: r.created_at };
    });
    return { session_id: sid, title: String(asc[0].input.question).slice(0, 28), service: asc[asc.length - 1].service, env: asc[asc.length - 1].env, task: asc[0].task, runs: rs.length, last_at: asc[asc.length - 1].created_at, turns };
  }).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

// ———————— 设置 ————————

const entry = <T extends object>(section: string, v: T, version: number, by_: string, at: number) =>
  ({ section, ...v, version, updated_by: by_, updated_at: iso(at) });

export const settings = {
  envs: entry("envs", { items: envs, default: "test" }, 3, "lihf", 9 * DAY),
  approvals: entry("approvals", {
    danger_patterns: ["\\brm\\s+-[a-z]*[rf]", "\\bdrop\\s+(table|database|schema)\\b", "\\btruncate\\b", "\\bdelete\\s+from\\b", "\\bkill(all)?\\b", "\\bsystemctl\\s+(stop|restart|disable)\\b", "\\bgit\\s+push\\b"],
    required_in: "off", timeout_minutes: 30,
  }, 2, "lihf", 12 * DAY),
  notifications: entry("notifications", {
    channels: {
      default: { type: "dingtalk", url: "https://alert-notification.ipa.zs/robot/send", token: "***" },
      "data-team": { type: "dingtalk", url: "https://alert-notification.ipa.zs/robot/send", token: "***" },
      "ops-webhook": { type: "webhook", url: "https://ops.internal/hooks/agent", token: "" },
    },
    rules: [
      { name: "审批提醒", enabled: true, events: ["approval_requested"], services: [], envs: [], tasks: [], triggers: [], channel: "default" },
      { name: "自动运行失败", enabled: true, events: ["run_failed"], services: [], envs: [], tasks: [], triggers: ["schedule", "event"], channel: "default" },
      { name: "看板问答失败", enabled: true, events: ["run_failed"], services: ["board"], envs: ["prod"], tasks: ["data-qa"], triggers: [], channel: "data-team" },
      { name: "进程停止", enabled: false, events: ["process_stopped"], services: [], envs: ["prod"], tasks: [], triggers: [], channel: "ops-webhook" },
      { name: "问答负反馈", enabled: true, events: ["feedback_negative"], services: [], envs: [], tasks: ["data-qa"], triggers: [], channel: "data-team" },
    ],
  }, 5, "wangzh", 2 * DAY),
  memory: entry("memory", { recall: true, save: true, handoff_summary: true, knowledge_limit: 5, asset_limit: 8 }, 1, "seed", 20 * DAY),
  processes: entry("processes", { default_lease_hours: 2, max_lease_hours: 24 }, 2, "lihf", 7 * DAY),
} as unknown as Settings;

export const apiKeys: ApiKey[] = [
  { id: 1, name: "board-backend", prefix: "ap_x8Kq2m", scope: "run", services: ["board"], envs: [], note: "看板后端调用问答", created_by: "lihf", created_at: iso(30 * DAY), expires_at: null, last_used_at: iso(4 * MIN), revoked_at: null },
  { id: 2, name: "dagster-sensor", prefix: "ap_N3pZ0c", scope: "run", services: ["dagster"], envs: ["prod", "test"], note: "run_failure_sensor 回调", created_by: "lihf", created_at: iso(28 * DAY), expires_at: null, last_used_at: iso(26 * MIN), revoked_at: null },
  { id: 3, name: "gitlab", prefix: "ap_7Hh1Wd", scope: "run", services: [], envs: [], note: "GitLab 部署 Webhook（X-Gitlab-Token）", created_by: "chenyu", created_at: iso(21 * DAY), expires_at: null, last_used_at: iso(5 * HOUR), revoked_at: null },
  { id: 4, name: "report-engine", prefix: "ap_q0LmE4", scope: "run", services: ["report-engine"], envs: ["test"], note: "报表回归", created_by: "chenyu", created_at: iso(15 * DAY), expires_at: new Date(NOW + 45 * DAY).toISOString(), last_used_at: null, revoked_at: null },
  { id: 5, name: "lihf-console", prefix: "ap_Bx9tYv", scope: "admin", services: [], envs: [], note: "控制台登录", created_by: "root", created_at: iso(40 * DAY), expires_at: null, last_used_at: iso(1 * MIN), revoked_at: null },
  { id: 6, name: "old-cli", prefix: "ap_Ze2Rr8", scope: "run", services: [], envs: [], note: "旧 CLI，已停用", created_by: "lihf", created_at: iso(60 * DAY), expires_at: null, last_used_at: iso(33 * DAY), revoked_at: iso(20 * DAY) },
];

export { NOW, MIN, HOUR, DAY, iso, hex, pick, between };
