/**
 * mock 数据：确定性随机（固定种子），时间相对"现在"生成，
 * 让预览里的列表、统计、时间线看起来像一个跑了几天的真实平台。
 *
 * 服务 / 角色 / 任务 / 平台配置与 conf/seeds/ 一致（vision-dagster、vision-board、vision-web）；
 * 运行、记忆、方法、反馈、回归重放围绕这三个项目编：Dagster 资产（成交 → 持仓 → 账户收益 → 策略报表）、
 * Django 报表（vision-board）、配置管理（vision-web 的 vision_cfg），数据在 ClickHouse（库名 ck）。
 *
 * 同机部署：每台部署主机上一个 agent 服务，部署配置里写它管哪个环境——生产主机 172.24.16.100（三个服务的国内生产都在这台）、
 * 测试主机 172.24.24.136（dagster 的国内测试）和 172.21.0.45（board 与 web 的国内测试）。
 * 过渡期（transition 分支）只在两台测试机上部署，生产的运行由它们代管（REMOTE_ENVS）。
 */
import type {
  ApiKey, Asset, ChatTurn, Env, FeedbackReason, Knowledge, PromptsConfig, Recipe, ReplayFilter, ReplayVerdict,
  Role, Run as ApiRun, RunEvent, RunStatus, Service, SessionDetail, Settings, Task, Tick, TodoItem, Trigger, Worker,
} from "../types";

/** mock 存的运行：前后关系（lineage）、排队状态（queue）由 server 按当时的台账算 */
type Run = Omit<ApiRun, "lineage" | "queue">;

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

/** 版本时间线（与 server.ts 的 versionsOf 一致）：当前版 31 小时前生效，再往前每版 31 小时 */
const VERSION_STEP = 31 * HOUR;
const versionAt = (current: number, msAgo: number) => Math.max(1, current - Math.floor(Math.max(0, msAgo) / VERSION_STEP));
const MODEL = "kimi-k2.7-code";
const PLATFORM = "9.0.0";
/**
 * 过渡期只在测试机部署（transition 分支）：两台测试机各管本机的服务，并代管生产（部署配置 remote_envs）。
 * 代管的运行看不到生产主机：logs / host_status 返回不可用（emit 里按它换掉），代码以测试机那份作参考。
 */
export const REMOTE_ENVS = ["prod"];
const PROMPTS_VERSION = 3;
/** 更早的运行是升级到 9.0 之前的：没有配方（详情页退回任务 / 角色版本），查库工具还叫 sql_query、思考是 thought 事件 */
const RECIPE_SINCE = 66 * HOUR;
/** 部署用户的 home（平台和项目是同一个用户部署的）：服务定义里 ~ 开头的路径展开成它 */
export const HOME = "/home/vision-service";
/** agent 的工作目录（db_query 的大结果写在它下面的 queries/<run_id>/） */
const SCRATCH = `${HOME}/.local/share/agent-platform/scratch`;

/** 最近 n 个交易日（跳过周末），新的在前；第一个是今天之前最近的一个 */
function tradingDays(n: number): string[] {
  const out: string[] = [];
  for (let t = NOW - DAY; out.length < n; t -= DAY) {
    const d = new Date(t);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
const TD = tradingDays(12);

// ———————— 环境（conf/seeds/settings.yaml） ————————

export const envs: Env[] = [
  { name: "prod", title: "国内生产", description: "线上生产部署；过渡期由测试机代管执行（看不到生产主机的日志与主机状况，代码以测试机那份作参考）；受保护：真实配置看不到，用控制台填的只读版", protected: true, color: "red" },
  { name: "test", title: "国内测试", description: "线上测试部署；agent 装在测试主机上，直接用项目的真实配置，库只读靠提示词约束", protected: false, color: "amber" },
];

// ———————— 服务（conf/seeds/services/*.yaml） ————————

const by = (name: string, at: number) => ({ updated_by: name, updated_at: iso(at) });

const CK_TEST = "clickhouse://${CK_RO_USER}:${CK_TEST_RO_PASSWORD}@172.24.17.66:8123/default";
const CK_PROD = "clickhouse://${CK_RO_USER}:${CK_PROD_RO_PASSWORD}@172.168.0.125:8123/default";

export const services: Service[] = [
  {
    name: "vision-dagster", title: "Vision Dagster",
    description: "Vision 的数据编排（Dagster）：资产、调度、传感器；docker 部署，国内生产 / 测试各一套",
    root: "~/deploy/vision-dagster", code_paths: [],
    python: "~/miniconda3/envs/vision-dagster/bin/python",
    env_vars: {}, urls: {},
    databases: { ck: CK_TEST },
    configs: ["~/deploy/vision-dagster/.env", "~/deploy/vision-dagster/dagster.yaml"],
    hidden: ["~/deploy/vision-dagster/docker-compose.yaml"],
    logs: { webserver: "docker:vision-dagster-webserver", daemon: "docker:vision-dagster-daemon", code: "docker:vision-dagster-code" },
    mcp: {
      dagster: {
        transport: "stdio", command: "{platform_python}", args: ["{platform}/mcp_servers/dagster_mcp.py"],
        env: { DAGSTER_URL: "{url:deployed}", DAGSTER_LAUNCH_JOBS: ".*" }, envs: { prod: {}, test: {} },
      },
    },
    envs: {
      prod: { urls: { deployed: "https://vision-dagster-prod.ipa.zs:9902" }, databases: { ck: CK_PROD } },
      test: { urls: { deployed: "https://vision-dagster-test.ipa.zs:9901" } },
    },
    profile: {
      env_notes: "线上是 docker 部署（docker-compose.template.yaml 生成 docker-compose.yaml）：国内生产 172.24.16.100、国内测试 172.24.24.136。*.india 模板是印度部署的，不用",
      no_go: "不在宿主上起 dagster-daemon / webserver；要在线上重跑作业用 dagster 的 MCP 工具（launch_job / reexecute_run），不要在 py 里 materialize 去写库",
      code_refs: "vision_dagster/（资产与作业定义）、vision_dagster_tests/（测试，用 py 跑 pytest）、scripts/、notebooks/（探索用的 ipynb）",
      upstream: "ClickHouse 国内生产 172.168.0.125、国内测试 172.24.17.66（HTTP 8123 / TCP 9000）",
      runbook: "线上运维 @高殿磊",
    },
    enabled: true, version: 4, ...by("gaodl", 2 * DAY),
  },
  {
    name: "vision-board", title: "Vision Board",
    description: "Vision 报表展示系统（Django）：报表页面与离线 HTML 导出；nginx + 源码服务",
    root: "~/deploy/vision-board", code_paths: [],
    python: "~/miniconda3/envs/vision-board/bin/python",
    env_vars: { DJANGO_SETTINGS_MODULE: "vision_board.settings-{env}" },
    urls: {},
    databases: { ck: CK_TEST },
    configs: ["~/deploy/vision-board/vision_board/settings-{env}.py"],
    hidden: [],
    logs: {
      app: "~/deploy/vision-board/vision-board.log", access: "~/deploy/vision-board/vision-board-access.log", crontab: "~/deploy/vision-board/crontab.log",
      nginx_access: "/var/log/nginx/access.log", nginx_error: "/var/log/nginx/error.log",
    },
    mcp: {},
    envs: {
      prod: { urls: { site: "https://vision-board.moon-prod.ipa.zs/" }, databases: { ck: CK_PROD } },
      test: { urls: { site: "https://vision-board.ipa.zs/" } },
    },
    profile: {
      conventions: "每个环境一份 settings：vision_board/settings-{环境}.py，DJANGO_SETTINGS_MODULE=vision_board.settings-{环境}；manage.py 命令都按它的配置走",
      no_go: "不执行 python manage.py crontab add / collectstatic / migrate 这类会改线上状态的命令；不改 nginx",
      env_notes: "nginx + 源码服务：生产 172.24.16.100（https://vision-board.moon-prod.ipa.zs/），测试 172.21.0.45（https://vision-board.ipa.zs/）。离线 HTML 导出用代码目录里的 chrome-linux",
      code_refs: "report/（报表）、templates/、vision_board/（项目配置与 settings）、scripts/、check_deps.py（依赖检查脚本）",
      upstream: "ClickHouse 国内生产 172.168.0.125、国内测试 172.24.17.66；登录走认证服务（settings 里配应用授权）",
      runbook: "运维 @李艳东",
    },
    enabled: true, version: 5, ...by("liyd", 3 * DAY),
  },
  {
    name: "vision-web", title: "Vision Web",
    description: "Vision 配置管理与展示系统（Django）：策略 / 账户 / 组合等配置的维护与展示（vision_cfg）",
    root: "~/deploy/vision-web", code_paths: [],
    python: "~/miniconda3/envs/vision-web/bin/python",
    env_vars: { DJANGO_SETTINGS_MODULE: "vision_web.settings-{env}" },
    urls: {},
    databases: {},
    configs: ["~/deploy/vision-web/vision_web/settings-{env}.py"],
    hidden: [],
    logs: { nginx_access: "/var/log/nginx/access.log", nginx_error: "/var/log/nginx/error.log" },
    mcp: {},
    envs: {},
    profile: {
      conventions: "每个环境一份 settings：vision_web/settings-{环境}.py，DJANGO_SETTINGS_MODULE=vision_web.settings-{环境}",
      no_go: "只读查看配置，不通过页面或 manage.py 改任何配置数据",
      env_notes: "用户登录走 FreeIPA 认证；本地应用授权要手动生成授权码（写进该环境的 settings）",
      code_refs: "vision_cfg/（配置模型与接口）、vision_web/（项目配置）、static/css/、docs/（接口文档）、scripts/",
    },
    enabled: true, version: 3, ...by("liyd", 6 * DAY),
  },
];

// ———————— 给 agent 的只读版配置（存库，按 服务×环境×路径 带版本） ————————
// 只有受保护的环境（生产）要填；测试环境直接用项目的真实配置，这里没有它的版本

/** 一个版本；同一个键下旧的在前 */
export interface ConfigRow { version: number; content: string; updated_by: string; updated_at: string }

/** 键：服务@环境|定义里的路径（含 {env}） */
export const agentConfigs = new Map<string, ConfigRow[]>();
const CK_HOST: Record<string, string> = { prod: "172.168.0.125", test: "172.24.17.66" };

function seedConfig(service: string, env: string, key: string, versions: [string, number, string][]) {
  agentConfigs.set(`${service}@${env}|${key}`, versions.map(([content, msAgo, who], i) => ({ version: i + 1, content, updated_by: who, updated_at: iso(msAgo) })));
}

const boardSettings = (env: string, o: { user?: string; chrome?: boolean } = {}) => `# 给 agent 的只读版：照抄线上的 vision_board/settings-${env}.py，库口令换成只读账号
from .settings import *  # noqa: F401,F403

DEBUG = False
ALLOWED_HOSTS = ["${env === "prod" ? "vision-board.moon-prod.ipa.zs" : "vision-board.ipa.zs"}", "127.0.0.1", "localhost"]

CLICKHOUSE = {
    "host": "${CK_HOST[env]}",
    "port": 8123,
    "user": "${o.user ?? "board_ro"}",
    "password": "mock-${env}-Bd31ro",
    "database": "default",
}

STATIC_ROOT = "${HOME}/deploy/vision-board/static"
CRONTAB_COMMAND_PREFIX = "DJANGO_SETTINGS_MODULE=vision_board.settings-${env}"
${o.chrome ? `CHROME_BIN = "${HOME}/deploy/vision-board/chrome-linux/chrome"\n` : ""}
AUTH_SERVER = "https://auth.ipa.zs"
AUTH_APP_ID = "vision-board-${env}"
AUTH_APP_SECRET = "mock-${env}-9f1c2a"
`;
const dagsterEnv = (env: string, doris = false) => [
  `# 给 agent 的只读版 .env（线上那份给 docker 里的 dagster 用；这份只给宿主上的项目内核）`,
  `CK_HOST=${CK_HOST[env]}`, "CK_PORT=8123", "CK_USER=ck_ro", `CK_PASSWORD=mock-${env}-Ck82ro`,
  ...(doris ? ["DORIS_HOST=172.24.24.88", "DORIS_PORT=9030", "DORIS_USER=dagster_ro", `DORIS_PASSWORD=mock-${env}-Dr19ro`] : []),
  "TZ=Asia/Shanghai", "",
].join("\n");
const DAGSTER_YAML = `# 给 agent 的只读版 dagster.yaml：不写 run_storage / event_log_storage / schedule_storage 的连接，
# 项目内核不该连 Dagster 自己的库；线上的运行记录用 dagster 的 MCP 工具查
telemetry:
  enabled: false
`;
const webSettings = (env: string) => `# 给 agent 的只读版：照抄线上的 vision_web/settings-${env}.py，库换成只读账号
from .settings import *  # noqa: F401,F403

DEBUG = False
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "HOST": "${env === "prod" ? "172.24.16.31" : "172.24.24.31"}",
        "NAME": "vision_cfg",
        "USER": "vision_web_ro",
        "PASSWORD": "mock-${env}-Wb77ro",
    }
}

# 用户登录走 FreeIPA；本地应用授权码手动生成后写在这里
FREEIPA_SERVER = "ipa.ipa.zs"
AUTH_APP_CODE = "mock-${env}-a7c03e"
`;

{
  const board = "~/deploy/vision-board/vision_board/settings-{env}.py";
  // 生产：liyd 先照抄了一份；gaodl 把 CK 账号换成只读的 board_ro；3 小时前 liyd 补上离线导出用的 CHROME_BIN
  seedConfig("vision-board", "prod", board, [
    [boardSettings("prod", { user: "readonly" }), 9 * DAY, "liyd"],
    [boardSettings("prod"), 4 * DAY, "gaodl"],
    [boardSettings("prod", { chrome: true }), 3 * HOUR, "liyd"],
  ]);
  // dagster 生产的 .env：30 小时前 gaodl 补了 doris 接口
  seedConfig("vision-dagster", "prod", "~/deploy/vision-dagster/.env", [[dagsterEnv("prod"), 8 * DAY, "gaodl"], [dagsterEnv("prod", true), 30 * HOUR, "gaodl"]]);
  seedConfig("vision-dagster", "prod", "~/deploy/vision-dagster/dagster.yaml", [[DAGSTER_YAML, 8 * DAY, "gaodl"]]);
  seedConfig("vision-web", "prod", "~/deploy/vision-web/vision_web/settings-{env}.py", [[webSettings("prod"), 5 * DAY, "liyd"]]);
}

// ———————— 角色（conf/seeds/roles.yaml） ————————

// tools 可写 "*"（全部内置 + 全部平台 MCP）和 "mcp:<server>"（某个平台 MCP server 的全部工具）；
// 继承：子角色写了 tools（非空）/ subagents（非 null）/ service_tools（非 null）就整体替换父角色的，没写就跟随
export const roles: Role[] = [
  {
    name: "generalist", title: "通用", description: "什么都能做：读线上代码、跑项目代码、查库、看日志和主机、用服务工具",
    prompt: "你是这个服务的全能工程师，用户可能问口径、查数据、分析报错、看代码，也可能交代一件具体的事。\n你在哪台主机上见 [运行环境]：在这个环境的部署主机上时，读到的代码就是线上在跑的那份；代管执行时看不到那个环境的日志和主机，\n代码只当参考。\n- 先弄清楚要什么；档案里的约定优先；\n- 跑项目代码用 py，查库用 db_query，看配置用 service_info，看线上日志用 logs，看主机用 host_status（代管时这两个不可用）；\n- 子问题很深、需要独立排查（报错根因、复杂取数）时，委派给对应的子代理；\n- 结论要可核对：给出依据（命令输出、日志、SQL、代码位置），不确定就明说。",
    tools: ["*"], subagents: ["ops_analyst", "data_searcher"], service_tools: null,
    extends: null, prompt_append: "", version: 3, ...by("liyd", 2 * DAY),
  },
  {
    name: "ops_analyst", title: "运维分析", description: "报错定位与根因分析：看线上日志与主机、读代码、在项目环境里复现、查库",
    prompt: "你是运维分析工程师，一般就在出问题的服务的部署主机上（代管执行时不是，见 [运行环境]）。拿到一次失败时：\n1. 先看档案里的已知坑、同类报错的教训和前序交接摘要，排除已知原因；\n2. 看线上现场：服务有自己的工具（如 dagster 的运行记录和运行日志）时先用它；logs 看应用 / nginx / 容器日志\n   （先 grep error|exception|traceback），host_status 看内存、磁盘、容器状态——代管执行时这两个不可用，结论里写明缺主机侧的证据；\n3. 读相关代码和本环境的配置，定位出错的步骤；用 py 直接调用出错的函数复现。只复现读的部分：生产的库是只读账号，\n   写库的步骤会失败，这是预期的；测试用的是真实配置，账号能写，写库的步骤一律跳过不调；数据假设要验证时委派给 data_searcher；\n4. 确认可以安全重跑时（档案或任务说明允许），用服务工具在线上重跑（如 dagster 的 reexecute_run），并跟踪结果；\n5. 结论按「根因 / 证据 / 影响范围 / 建议」四段输出。\n没有证据的结论标注为推测。",
    tools: ["py", "bash", "service_info", "logs", "host_status", "db_query", "save_asset", "notify"],
    subagents: ["data_searcher"], service_tools: null,
    extends: null, prompt_append: "", version: 6, ...by("gaodl", 3 * DAY),
  },
  {
    name: "data_searcher", title: "数据口径问答", description: "回答指标口径和取数问题，给出依据与结果",
    prompt: "你是数据分析师，回答业务方关于指标口径与数据的问题。\n- 先确认口径：档案里的约定优先，其次读项目代码里的口径实现（指标函数 / SQL 模板）；\n- 项目里有现成的口径函数或查询封装，就用 py 直接调用它取数，口径与线上一致；没有再用 db_query 写 SQL（用该库自己的方言）；\n- db_query 的大结果在文件里：用 py 的 pandas 读它做汇总，别把明细整份贴出来；回答里附上用到的函数或 SQL。",
    tools: ["py", "bash", "db_query", "service_info"], subagents: null, service_tools: null,
    extends: null, prompt_append: "", version: 4, ...by("wangzh", 2 * DAY),
  },
  {
    name: "qa_engineer", title: "冒烟测试", description: "部署后按沉淀的方法检查线上页面和接口，失败时给出复现步骤",
    prompt: "你是测试工程师，一般就在被测服务的部署主机上（代管执行时不是，见 [运行环境]）。部署完成后执行冒烟测试：优先复用方法里的脚本，不要重写；\n先用 service_info(what=git) 看线上代码目录的提交是不是待测版本，对不上就如实报告，不要拿旧代码下结论；\n代管执行时本机的代码不是被测环境的，版本看不了就如实说，只按页面和接口的表现下结论；\n项目自带的测试用 py 跑（如 pytest.main([...])）；要看页面时用浏览器工具打开运行环境里列出的地址（site 是线上部署）；\n页面报错时用 logs 看应用和 nginx 日志里同一时刻的记录；\n失败时给出复现步骤与证据，根因不明显就委派给 ops_analyst。",
    tools: ["py", "bash", "service_info", "logs", "host_status", "save_asset", "mcp:browser"], subagents: ["ops_analyst"], service_tools: null,
    extends: null, prompt_append: "", version: 3, ...by("liyd", 5 * DAY),
  },
  {
    name: "inspector", title: "巡检", description: "按沉淀的方法做日常巡检，异常才通知",
    prompt: "",
    tools: ["py", "bash", "service_info", "logs", "host_status", "db_query", "save_asset", "notify", "mcp:browser"], subagents: [], service_tools: null,
    extends: "ops_analyst",
    prompt_append: "你在做巡检：按方法逐项检查，正常项只计数，异常项给证据并用 notify 通知。\n没有既定方法时先探索（数据新鲜度、页面、日志里的错误、主机资源；代管执行时没有日志和主机这两项），\n结束后用 save_asset 沉淀成方法。输出控制在 15 行以内。", version: 3, ...by("liyd", 8 * DAY),
  },
];

// ———————— 任务（conf/seeds/tasks.yaml；子任务是调用时点名自动建的） ————————

const trig = {
  api: (id = "api"): Trigger => ({ id, type: "api" }),
  chat: (id = "chat"): Trigger => ({ id, type: "chat" }),
};

const taskBase = { enabled: true, profile: {}, memory: {}, deliver: null, extends: null, auto_created: false, dedup: null, handler: null, output_schema: null, envs: [] as string[], retry: null, concurrency: null };

export const tasks: Task[] = [
  // 通用入口：任何服务、任何环境直接提问或交代一件事，不用先建任务；要定时、事件、投递、去重时再建正式任务
  {
    ...taskBase, name: "ask", title: "问一下", description: "通用入口：对这个服务这个环境直接提问或交代一件事",
    service: "*", role: "generalist", form: "agent",
    input: { question: { type: "text", required: true, description: "问题或要做的事" } },
    triggers: [trig.chat(), trig.api()], timeout_s: 900,
    version: 1, ...by("seed", 9 * DAY),
  },
  {
    ...taskBase, name: "failure-analysis", title: "Dagster 失败分析",
    description: "资产物化失败时分析根因，结论推到钉钉群。手动跑时 run_id、asset_key 给一个就行：只给资产就用 dagster 的工具查它最近一次失败的运行，只给 run_id 就从这次运行里看是哪个资产失败的。",
    service: "vision-dagster", role: "ops_analyst", form: "agent",
    // 都不必填（与 conf/seeds/tasks.yaml 一致）：Dagster 的回调总会带齐，手动跑时知道哪个填哪个
    input: {
      run_id: { type: "str", description: "Dagster run id（不填就查这个资产最近一次失败的运行）" },
      asset_key: { type: "str", description: "失败的资产" },
      error: { type: "text", description: "报错堆栈（不填就按 run_id 去 Dagster 查日志）" },
    },
    // 每个资产一个子任务：asset_key 就是对象名
    object_input: "asset_key",
    envs: ["prod", "test"],
    triggers: [
      {
        id: "on-failure", type: "event", source: "dagster", event: "run_failure", session: "dagster:{asset_key}:{error_class}:{date}",
        rules: [
          { pattern: "connection.*(refused|timeout|reset)", category: "infra", conclusion: "数据库/服务连接失败，检查目标服务存活与网络" },
          { pattern: "out of memory|oom|memoryerror", category: "infra", conclusion: "内存不足：检查资源配额或拆分分区" },
        ],
      },
      trig.api(),
    ],
    deliver: { channel: "default" }, dedup: { key: "run_id", window_s: 600 }, timeout_s: 900,
    // 模型 429、执行进程被杀这类临时性失败自动续跑；一下涌进几十条失败时每个环境最多同时分析 4 条
    retry: { max: 2, delay_s: 120 }, concurrency: 4,
    profile: { pitfalls: "资产失败先看上游资产是否完成，多数失败是上游延迟级联；先用 dagster 的 MCP 工具看线上这次运行的日志" },
    version: 4, ...by("gaodl", 1 * DAY),
  },
  // 事件里的资产（asset_key）还没有子任务时自动建（继承父任务）；值得写档案的资产后来补了档案（人改过就不再算自动创建）
  // _own：子任务自己写了哪些字段（后端 model_fields_set），其余跟随父任务
  {
    ...taskBase, name: "failure-analysis:dws_account_pnl_daily", title: "账户收益日表", description: "", service: "vision-dagster", role: "ops_analyst", form: "agent",
    input: {}, triggers: [], deliver: { channel: "default" }, timeout_s: 900, extends: "failure-analysis", auto_created: false,
    profile: {
      upstream: "dwd_position_daily、market_kline_1d（交易日 18:30 前到齐）",
      pitfalls: "新开的子账户在 dim_account 里晚一天才有，汇总时会丢行：先查 dim_account 再下结论",
    },
    _own: ["title", "profile"],
    version: 2, ...by("gaodl", 2 * DAY),
  } as Task,
  {
    ...taskBase, name: "failure-analysis:ods_trade_fills", title: "", description: "", service: "vision-dagster", role: "ops_analyst", form: "agent",
    input: {}, triggers: [], deliver: { channel: "default" }, timeout_s: 900, extends: "failure-analysis", auto_created: true, _own: [],
    version: 1, ...by("auto:event", 7 * HOUR),
  } as Task,
  {
    ...taskBase, name: "data-qa", title: "数据口径问答", description: "业务方提问指标口径与取数",
    service: "*", role: "data_searcher", form: "agent",
    input: { question: { type: "text", required: true, description: "问题" } },
    triggers: [trig.chat(), trig.api()], timeout_s: 600,
    version: 2, ...by("wangzh", 4 * DAY),
  },
  // 对话里点名了"账户收益"这个对象：自动建的子任务，口径后来写进了它的档案
  {
    ...taskBase, name: "data-qa:account_pnl", title: "账户收益", description: "", service: "*", role: "data_searcher", form: "agent",
    input: {}, triggers: [], timeout_s: 600, extends: "data-qa", auto_created: false,
    profile: { conventions: "账户收益 = 已实现盈亏 + 浮动盈亏，按交易日汇总，单位元；跨币种先按当日中间价折成人民币", code_refs: "vision-board 的 report/pnl.py（account_pnl()）" },
    _own: ["title", "profile"],
    version: 2, ...by("wangzh", 3 * DAY),
  } as Task,
  {
    ...taskBase, name: "frontend-smoke", title: "Board 冒烟测试", description: "GitLab 部署成功后检查报表页面与接口",
    service: "vision-board", role: "qa_engineer", form: "agent",
    input: { version: { type: "str", description: "部署版本（ref）；不填 = 测线上现在部署的那一版" }, project: { type: "str", description: "GitLab 项目" } },
    envs: ["test", "prod"],
    triggers: [{ id: "on-deploy", type: "event", source: "gitlab", event: "deployment", filter: { project: "^vision-board$" }, map: { version: "ref", project: "project" } }, trig.api()],
    deliver: { channel: "default" }, dedup: { key: "version", window_s: 1800 }, timeout_s: 900,
    version: 2, ...by("liyd", 7 * DAY),
  },
  {
    ...taskBase, name: "daily-inspection", title: "Board 日常巡检", description: "每天早上检查报表数据新鲜度与线上页面",
    service: "vision-board", role: "inspector", form: "agent", input: { scope: { type: "enum", options: ["full", "quick"], default: "full" } },
    envs: ["prod", "test"],
    triggers: [
      { id: "morning", type: "schedule", cron: "50 8 * * *", envs: ["prod", "test"], input: { scope: "full" } },
      // 演示上游联动：部署冒烟通过后在同一个环境补一次巡检（种子里没有，按需在控制台加）
      { id: "after-smoke", type: "after", tasks: ["frontend-smoke"], mode: "any", on: ["success"] },
      trig.api(),
    ],
    deliver: { channel: "default" }, timeout_s: 900, version: 3, ...by("liyd", 3 * DAY),
  },
  // 演示「全部上游结束」：冒烟和巡检都跑完（成功或失败）才写这次发版的小结，版本号取冒烟那次的输入
  {
    ...taskBase, name: "release-report", title: "发版小结", description: "冒烟和巡检都结束后，把这次部署的检查结果汇总成一条发版小结推到群里",
    service: "vision-board", role: "qa_engineer", form: "agent",
    input: { version: { type: "str", description: "部署版本（ref）" } },
    envs: ["test", "prod"],
    triggers: [
      { id: "after-checks", type: "after", tasks: ["frontend-smoke", "daily-inspection"], mode: "all", on: ["success", "failed"], window_s: 6 * 3600,
        map: { version: "frontend-smoke.input.version" } },
      trig.api(),
    ],
    deliver: { channel: "default" }, timeout_s: 600, version: 1, ...by("liyd", 2 * DAY),
  },
  // 每个服务×环境各跑一次，由部署它的那台主机上的 agent 服务执行（读的是那台主机上线上的代码目录）
  {
    ...taskBase, name: "memory-gardener", title: "记忆园丁", description: "夜间维护：记忆里引用的代码在线上代码目录里改过了，就标为过期",
    service: "*", role: null, form: "builtin", handler: "memory-gardener", input: {},
    triggers: [
      { id: "nightly-dagster", type: "schedule", cron: "0 3 * * *", service: "vision-dagster", envs: ["prod", "test"], input: {} },
      { id: "nightly-board", type: "schedule", cron: "10 3 * * *", service: "vision-board", envs: ["prod", "test"], input: {} },
      { id: "nightly-web", type: "schedule", cron: "20 3 * * *", service: "vision-web", envs: ["prod", "test"], input: {} },
      trig.api(),
    ],
    timeout_s: 1800, version: 2, ...by("seed", 9 * DAY),
  },
];

// ———————— 平台提示词（设置 → 提示词；内置默认文本见 domain/prompts.py，这里是 wangzh 改到的 v3） ————————

const PROMPTS: PromptsConfig = {
  base: `你是 agent-platform 上的一个业务 agent。平台约定：
- 每次运行都绑定一个服务和一个环境（见用户消息里的 [运行环境]），你的工具只作用于它们，不要尝试操作别的服务或环境。用户消息开头的 [时间] 是现在的时间。
- 档案（[档案——…]）是人写的一手事实，优先级最高；历史知识与方法是过去运行沉淀的，可能过时，与代码或数据矛盾时以实际为准并指出。
- 读代码用 read（带行号，按 offset 翻页），找代码用 grep；bash 用来跑命令（ls、git、curl、项目的命令行）。服务代码只读。
- 工作目录：bash 的当前目录是一块可写区（py 里是 $SCRATCH），写文件、放脚本都在这里。
- 互不依赖的工具调用（读几个文件、查几张表、看几份日志）放在同一次回复里一起发出，它们会并行执行；同一会话的 py 是排队执行的。
- 工具输出太长时，全文存在工作目录的 outputs/ 下、返回里有路径：用 read（offset）或 grep 看需要的部分，不要整份读。
- 3 步以上的任务先用 todo 列出要做的事，做完一项更新一项；同样的调用不要原样反复重试，没进展就换个查法。
- 要跑项目自己的代码（import 项目模块、调口径函数、用项目的数据访问层取数、复现某个函数的报错），用 py：它就在本环境的项目 Python 里，配置已就位，变量在会话内保留。不要在 bash 里自己拼环境去跑项目代码。
- py 里可以直接调用你的其他工具（同名函数，如 db_query("select …")、service_info(what="config")，返回文本）：要批量、循环地调工具时写进一段 py，中间结果不必进对话。
- 不论哪个环境，数据库都只读：只查不改，不要执行写入、删除、建表改表，也不要调用会写库的项目函数。生产环境格外谨慎：只读排查，不要起会改数据或跑调度的进程。
- 配置文件怎么读见 [运行环境]：生产环境给你的是只读版，真实配置在 bash 里读到的是空文件；测试环境是项目的真实配置。service_info(what=config) 读本环境的配置，密钥已打码。
- 脚本先写进工作目录、跑通，再用 save_asset 收编成方法；以后同类运行会自动召回。
- 结论要可核对：给出依据（命令输出、SQL、代码位置），不确定就明说。`,
  subagent: `你是 agent-platform 上被主 agent 委派来处理一个子问题的子代理。
- 你和主 agent 在同一次运行里：同一个服务、同一个环境，工具只作用于它们。
- 只做交给你的那件事，做完给出可核对的结论（依据：命令输出、SQL、代码位置），不确定就明说。主 agent 只看得到你最后一条回复。
- 读代码用 read / grep，跑项目代码用 py，配置用 service_info(what=config) 读；互不依赖的工具调用一次发出。`,
  compaction: `对话历史太长，要压缩成一份摘要替换掉下面这些消息，之后的工作只能看到摘要。
按四节输出，没有内容的节写"无"，不要输出别的：

## 目标
（这次要解决的问题）

## 已查明
（关键事实与依据：命令输出、SQL 结果、代码位置；排除过的方向及原因）

## 产物
（写过的文件、保存的方法、起过的进程）

## 下一步
（还没做完的事）

<messages>
{messages}
</messages>`,
  distill: `以下是 agent 刚在服务 {service} 的 {env} 环境完成的一次任务记录。判断是否产出了以后还用得上的结论。

任务：{task}
输入：{input}
结论：{output}

只提炼"以后还会用到的"内容：指标口径（key 形如 metric:xxx）、表与字段含义、服务拓扑、调用方式等事实；
有报错输入时，再给一条这类报错的教训（根因 + 怎么判断）。没有可沉淀的内容就返回空 JSON 数组。

env_specific：结论只在 {env} 环境成立（比如这个环境特有的配置、数据量、主机）写 true；
口径、代码逻辑、表结构这类各环境都一样的写 false。拿不准写 false。

严格输出 JSON：
[{{"kind": "fact", "key": "metric:account_pnl", "content": "...", "code_path": "/home/vision-service/deploy/vision-board/...", "env_specific": false}},
 {{"kind": "lesson", "category": "code|data|infra|upstream", "conclusion": "...", "env_specific": false}}]`,
  handoff_summary: `把以下这次任务记录整理成"交接摘要"，供下次同类问题的新会话直接续用。
严格按四节输出，没有内容的节写"无"，不要加其他内容：

## 结论
（本次判断的最终结论，一两句）

## 被否方案
（排查过但排除的方向及排除原因——新会话不要重复排查）

## 当前约束
（仍然成立的限制条件：环境、权限、上游依赖等）

## 未决问题
（没查完/待跟进的事项）

任务：{task}
输入：{input}
结论：{output}`,
  replay_judge: `你在做回归评审。同一个问题，旧答案被人点了 👎；现在用新版本的提示词 / 定义重答了一次。
判断新答案有没有解决人指出的问题。

任务：{task}（{where}）
输入：
{input}

旧答案（被 👎）：
{old}

人指出的问题：
{issues}

新答案：
{new}

只输出 JSON，不要别的内容：{{"verdict": "fixed|same|worse|unclear", "reason": "一两句：新答案在被指出的问题上怎么样"}}
- fixed：被指出的问题解决了，且没有引入明显的新错误
- same：被指出的问题还在
- worse：问题还在且更糟，或引入了明显的新错误
- unclear：信息不够判断（比如要看实际数据才能确认）`,
};
/** 设置里的提示词一节（server.ts 的 PUT / 恢复会原地改它的版本）；31 小时前 wangzh 改到 v3 */
const promptsEntry = { section: "prompts", ...PROMPTS, version: PROMPTS_VERSION, updated_by: "wangzh", updated_at: iso(VERSION_STEP) };
/** 平台内置的默认提示词（GET /v1/settings/prompts/defaults）：mock 里就是上面这份内置文本，PUT 改的是 promptsEntry，不动它 */
export const PROMPT_DEFAULTS: PromptsConfig = Object.freeze({ ...PROMPTS });

// ———————— 运行 ————————

export interface MockRun extends Run {
  _events?: RunEvent[];
  _answer?: string;            // 指定最终答案（回归重放的新答案）；不填按场景生成
  _output?: Run["output"];     // 内建任务（记忆园丁）的结果 JSON；不填按事件生成
  _error_code?: string;
  _scenario?: number;          // 选中的场景下标（问答、失败分析）
  _priority?: number;          // 认领顺序：0 对话 / 1 接口 / 2 定时、事件、联动（与 domain/runs.PRIORITY 一致）
  _queuedAt?: string;          // 这一次进队列的时刻（续跑、自动重试会重新进）；不写 = created_at
  _ckey?: string;              // 任务并发：<父任务>@<环境>
  _climit?: number;
}

/** 角色继承链：根在前、自己在后 */
function roleChain(name: string | null): Role[] {
  const out: Role[] = [];
  let r = name ? roles.find((x) => x.name === name) : undefined;
  while (r && !out.includes(r)) {
    out.unshift(r);
    const parent: string | null = r.extends;
    r = parent ? roles.find((x) => x.name === parent) : undefined;
  }
  return out;
}
/** 生效的子代理：沿继承链最后一个写了的（null = 跟随父角色） */
const subagentsOf = (chain: Role[]) => [...chain].reverse().find((r) => r.subagents !== null)?.subagents ?? [];

/**
 * 配方（与 pipeline._record_recipe 一致）：任务（与父任务）、角色继承链每一层、子代理、服务、平台提示词（只 agent 运行有）、模型、平台版本。
 * msAgo：运行开始于多久之前，按版本时间线推当时生效的版本；更早的运行没有配方。
 */
export function recipeOf(run: Run, msAgo = Math.max(0, NOW - new Date(run.created_at).getTime())): Recipe | null {
  if (msAgo > RECIPE_SINCE) return null;
  const [baseName, object] = run.task.split(":");
  const base = tasks.find((t) => t.name === baseName);
  const agent = base?.form === "agent" && run.resolution !== "rule";
  const recipe: Recipe = { task: { name: run.task, version: run.task_version ?? 1 }, model: MODEL, platform: PLATFORM };
  if (object && base) recipe.task.parent = { name: base.name, version: versionAt(base.version, msAgo) };
  const chain = roleChain(run.role);
  if (chain.length) {
    recipe.role = { name: run.role!, lineage: chain.map((r) => ({ name: r.name, version: r.name === run.role ? run.role_version ?? r.version : versionAt(r.version, msAgo) })) };
    const subs = agent ? subagentsOf(chain).filter((s) => s !== run.role) : [];
    if (subs.length) recipe.subagents = subs.map((s) => ({ name: s, lineage: roleChain(s).map((r) => ({ name: r.name, version: versionAt(r.version, msAgo) })) }));
  }
  const svc = services.find((s) => s.name === run.service);
  if (svc) recipe.service = { name: svc.name, version: versionAt(svc.version, msAgo) };
  if (agent) recipe.prompts = versionAt(promptsEntry.version, msAgo);
  return recipe;
}

// ———————— 场景：问题 → 每次模型调用的思考与工具调用 → 结论 ————————

interface Call { tool: string; args: Record<string, unknown>; output: string; ms?: number; sub?: Plan[] }
interface Plan { think?: string; calls: Call[] }
interface Scenario { q: string; plans: (r: Run) => Plan[]; answer: (r: Run) => string }

const mdTable = (cols: string[], rows: (string | number)[][]) =>
  ["| " + cols.join(" | ") + " |", "|" + "---|".repeat(cols.length), ...rows.map((row) => "| " + row.join(" | ") + " |")].join("\n");

/** db_query 的输出（与 agent/tools/db.py 的 render 一致）：超过 20 行时全部写进工作目录的文件 */
function ckOut(o: { rows: number; cols: string[]; preview: (string | number)[][]; ms: number; file?: string }): string {
  const lines = [`[ClickHouse · ck] ${o.rows} 行 × ${o.cols.length} 列，${o.ms} ms`];
  if (o.file) lines.push(`全部结果在 ${o.file}（UTF-8 CSV，首行是列名）：用 bash（head / grep / awk / wc）或 py（pandas.read_csv）按需读，不要整份打印。下面是前 ${o.preview.length} 行：`);
  lines.push(mdTable(o.cols, o.preview));
  return lines.join("\n");
}
const csvOf = (r: Run, n = 0) => `${SCRATCH}/queries/${r.run_id}/${r.created_at.slice(11, 19).replace(/:/g, "")}-ck-${r.run_id.slice(n, n + 6)}.csv`;
/** 线上的代码目录（三个服务的 root 都是 ~/deploy/<服务>，各环境在各自的主机上） */
const codeDir = (r: Run) => `${HOME}/deploy/${r.service}`;

/** 这次运行是不是代管执行（执行它的主机不是这个环境的部署主机） */
const remote = (r: Pick<Run, "env">) => REMOTE_ENVS.includes(r.env);
/** 与后端 catalog.remote_unavailable 一致 */
function remoteUnavailable(env: string, what: string): string {
  return `[不可用] 这次是代管执行：本机不是 ${env} 的部署主机，看不到 ${env} 主机上的${what}；本机上同名的是别的环境的，不能当成 ${env} 的。`
    + `${env} 的运行记录和日志用服务工具（MCP，如 dagster 的 get_run_logs）查，页面用浏览器工具（有的话）看，数据用 db_query / py 查；确实需要主机上的信息就在结论里写明缺这一项`;
}

/**
 * host_status 的输出（与 services/hostlocal.host_status 一致）：按运行所在的部署主机给一份像样的。
 * 生产都在 172.24.16.100；测试的 dagster 在 172.24.24.136，board / web 在 172.21.0.45。
 */
function hostStatusOut(r: Pick<Run, "env" | "service" | "created_at">): string {
  const prod = r.env === "prod";
  const dagster = !prod && r.service === "vision-dagster";
  const at = r.created_at;
  const lines = [
    prod ? "负载 3.41 / 2.87 / 2.52（32 核），已运行 41.3 天" : dagster ? "负载 1.08 / 0.94 / 0.90（16 核），已运行 12.6 天" : "负载 0.62 / 0.55 / 0.48（8 核），已运行 87.2 天",
    prod ? "内存 已用 88.4G / 125.6G（可用 37.2G），swap 已用 0.3G" : dagster ? "内存 已用 21.7G / 125.6G（可用 103.9G），swap 已用 0.0G" : "内存 已用 9.8G / 125.6G（可用 115.8G），swap 已用 0.0G",
    prod ? "磁盘 /：已用 81.4G / 100.0G（81%）" : "磁盘 /：已用 42.0G / 100.0G（42%）",
    `磁盘 ${HOME}：已用 ${prod ? "612.3G / 1024.0G（59%）" : "188.5G / 500.0G（37%）"}`,
    ["占内存最多的进程（RSS KB）：", "    PID USER         RSS %CPU     ELAPSED COMMAND",
      ...(prod || dagster ? [
        " 21877 vision-s 6182344 41.2  3-02:11:40 /usr/local/bin/python -m dagster code-server start -h 0.0.0.0 -p 4000 -m vision_dagster",
        " 21544 vision-s 2310688  6.3  3-02:11:52 /usr/local/bin/python -m dagster._daemon run",
        " 21503 vision-s 1288104  2.1  3-02:11:53 /usr/local/bin/python -m dagster_webserver -h 0.0.0.0 -p 3000",
      ] : []),
      ...(dagster ? [] : [
        `  3310 vision-s  912340  1.8 12-04:20:11 ${HOME}/miniconda3/envs/vision-board/bin/python manage.py runserver 0.0.0.0:8000 --noreload`,
        `  3402 vision-s  486120  0.4 12-04:20:02 ${HOME}/miniconda3/envs/vision-web/bin/python manage.py runserver 0.0.0.0:8100 --noreload`,
      ])].join("\n"),
    ...(prod || dagster ? ["docker 容器：\nvision-dagster-webserver\tUp 3 days\tvision-dagster:latest\nvision-dagster-daemon\tUp 3 days\tvision-dagster:latest\nvision-dagster-code\tUp 3 days (healthy)\tvision-dagster:latest\nvision-dagster-postgres\tUp 3 weeks\tpostgres:15"] : []),
    ...(dagster ? [] : ["nginx：active"]),
    `（采集于 ${at.slice(0, 19).replace("T", " ")}）`,
  ];
  return lines.join("\n");
}

const ACCOUNTS = ["A001", "A002", "A003", "A005", "A007", "A008", "A011", "A012", "A015", "A016", "A019", "A021"];
/** 某账户某交易日的收益（元）：确定性的假数据，预览、文件、汇总三处一致 */
const pnlOf = (d: number, a: number) => Math.round((((d * 37 + a * 53) % 29) - 11) * 1712.4 + (a - 6) * 230) / 1;
const DAYS7 = TD.slice(0, 7).reverse();
const pnlRows = DAYS7.flatMap((day, d) => ACCOUNTS.map((acc, a) => [day, acc, pnlOf(d, a).toFixed(2)]));
const pnlTotals = ACCOUNTS.map((acc, a) => [acc, DAYS7.reduce((n, _, d) => n + pnlOf(d, a), 0)] as [string, number]).sort((x, y) => y[1] - x[1]);
const yuan = (n: number) => (n < 0 ? "-" : "") + "¥" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const PNL_SQL = `SELECT trade_date, account_id, round(sum(realized_pnl + unrealized_pnl), 2) AS pnl
FROM dws_account_pnl_daily
WHERE trade_date >= '${DAYS7[0]}'
GROUP BY trade_date, account_id
ORDER BY trade_date, account_id`;

const QA: Record<string, Scenario[]> = {
  "vision-board": [
    {
      q: "近 7 个交易日各账户的收益是多少？",
      plans: (r) => [
        { think: "先确认口径：档案和记忆里账户收益 = 已实现 + 浮动盈亏，按交易日汇总。报表用的是 report/pnl.py 的 account_pnl()，先看它怎么取数，保证和报表一致。",
          calls: [{ tool: "bash", args: { command: `sed -n '18,44p' ${codeDir(r)}/report/pnl.py` }, ms: 40,
            output: `def account_pnl(start, end, accounts=None):\n    """账户收益：已实现 + 浮动，按交易日汇总（元）。"""\n    sql = """\n        SELECT trade_date, account_id, sum(realized_pnl + unrealized_pnl) AS pnl\n        FROM dws_account_pnl_daily\n        WHERE trade_date BETWEEN %(start)s AND %(end)s\n        GROUP BY trade_date, account_id\n    """\n    return ck.query_df(sql, {"start": start, "end": end})` }] },
        { think: "account_pnl() 就是对 dws_account_pnl_daily 按交易日、账户求和。直接用同样的 SQL 查最近 7 个交易日；12 个账户 × 7 天会超过 20 行，结果写进文件后用 pandas 汇总。",
          calls: [{ tool: "db_query", args: { query: PNL_SQL, db: "ck" }, ms: 412,
            output: ckOut({ rows: pnlRows.length, cols: ["trade_date", "account_id", "pnl"], preview: pnlRows.slice(0, 20), ms: 386, file: csvOf(r) }) }] },
        { think: "84 行在文件里。按账户汇总，再看哪几天波动大，不把明细贴出来。",
          calls: [{ tool: "py", args: { code: `import pandas as pd\ndf = pd.read_csv("${csvOf(r)}")\nprint(df.groupby("account_id").pnl.sum().sort_values(ascending=False).round(0).to_string())\nprint(df.groupby("trade_date").pnl.sum().round(0).to_string())` }, ms: 920,
            output: "account_id\n" + pnlTotals.map(([a, n]) => `${a}    ${n.toFixed(1)}`).join("\n") + "\ntrade_date\n" + DAYS7.map((d, i) => `${d}    ${ACCOUNTS.reduce((n, _, a) => n + pnlOf(i, a), 0).toFixed(1)}`).join("\n") }] },
      ],
      answer: () => `近 7 个交易日（${DAYS7[0]} ~ ${DAYS7[6]}）12 个账户收益合计 **${yuan(pnlTotals.reduce((n, [, v]) => n + v, 0))}**（已实现 + 浮动，按交易日汇总）。\n\n| 账户 | 收益 |\n|---|---|\n${pnlTotals.slice(0, 6).map(([a, n]) => `| ${a} | ${yuan(n)} |`).join("\n")}\n| 其余 6 个 | ${yuan(pnlTotals.slice(6).reduce((n, [, v]) => n + v, 0))} |\n\n口径与报表一致（report/pnl.py 的 \`account_pnl()\`）。明细 84 行在运行的工作目录里，需要的话可以导出。\n\n\`\`\`sql\n${PNL_SQL}\n\`\`\``,
    },
    {
      q: "账户收益日报里的收益口径是什么？",
      plans: (r) => [
        { think: "口径问题：档案里没写收益的定义，先读报表代码。",
          calls: [{ tool: "bash", args: { command: `grep -rn "def account_pnl\\|realized_pnl" ${codeDir(r)}/report/ | head -20` }, ms: 60,
            output: `${codeDir(r)}/report/pnl.py:18:def account_pnl(start, end, accounts=None):\n${codeDir(r)}/report/pnl.py:22:        SELECT trade_date, account_id, sum(realized_pnl + unrealized_pnl) AS pnl\n${codeDir(r)}/report/views.py:41:    df = account_pnl(start, end, accounts)` }] },
      ],
      answer: () => "**账户收益 = 已实现盈亏 + 浮动盈亏**，按**交易日**汇总，单位元。\n\n- 数据来自 ClickHouse 的 `dws_account_pnl_daily`（vision-dagster 每个交易日 18:40 物化）；\n- 非交易日没有行，周报 / 月报是交易日求和；\n- 跨币种账户先按当日中间价折成人民币。\n\n依据：`report/pnl.py` 第 18 行的 `account_pnl()`，日报视图 `report/views.py` 第 41 行调用它。",
    },
    {
      q: "策略周报的收益率和 CK 里算的对不上，差在哪？",
      plans: () => [
        { think: "周报的收益率在 report/strategy.py。用 py 直接调项目里的 strategy_return()，和自己用 SQL 算的对比。",
          calls: [{ tool: "py", args: { code: `from report.strategy import strategy_return\nprint(strategy_return("alpha_mm_03", "${TD[4]}", "${TD[0]}"))` }, ms: 1340, output: "{'strategy': 'alpha_mm_03', 'pnl': 182344.12, 'nav_start': 12500000.0, 'return': 0.014588}" }] },
        { think: "周报用的分母是期初净值 1250 万。看看 CK 里按平均净值算是多少。",
          calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT sum(pnl) AS pnl, avg(nav) AS nav_avg, sum(pnl) / avg(nav) AS ret\nFROM dws_strategy_nav_daily\nWHERE strategy = 'alpha_mm_03' AND trade_date BETWEEN '${TD[4]}' AND '${TD[0]}'` }, ms: 95,
            output: ckOut({ rows: 1, cols: ["pnl", "nav_avg", "ret"], preview: [[182344.12, 12930412.5, 0.014102]], ms: 81 }) }] },
      ],
      answer: () => "差在**分母**：\n\n| 算法 | 分母 | 收益率 |\n|---|---|---|\n| 策略周报（`strategy_return()`） | 期初净值 ¥12,500,000 | **1.46%** |\n| 你在 CK 里的算法 | 区间平均净值 ¥12,930,413 | 1.41% |\n\n分子一致（¥182,344）。周报口径是期初净值，期间有申购时两者会差几个基点；以周报口径为准的话，SQL 里改用期初那一天的 `nav`。",
    },
    {
      q: "上周换手率最高的 5 个账户",
      plans: () => [
        { think: "换手率按记忆里的口径：成交额 / 期初与期末持仓市值的均值。直接在 CK 里算，结果只有 5 行。",
          calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT account_id, sum(turnover) / ((argMin(mv, trade_date) + argMax(mv, trade_date)) / 2) AS turnover_rate\nFROM dws_account_pnl_daily\nWHERE trade_date BETWEEN '${TD[9]}' AND '${TD[5]}'\nGROUP BY account_id ORDER BY turnover_rate DESC LIMIT 5` }, ms: 140,
            output: ckOut({ rows: 5, cols: ["account_id", "turnover_rate"], preview: [["A011", 3.82], ["A003", 2.97], ["A016", 2.41], ["A001", 1.88], ["A021", 1.62]], ms: 133 }) }] },
      ],
      answer: () => `上周（${TD[9]} ~ ${TD[5]}）换手率最高的 5 个账户：\n\n| 账户 | 换手率 |\n|---|---|\n| A011 | 382% |\n| A003 | 297% |\n| A016 | 241% |\n| A001 | 188% |\n| A021 | 162% |\n\n口径：成交额 / 期初与期末持仓市值的均值（2026-08 之后的口径）。`,
    },
    {
      q: "dws_account_pnl_daily 上个交易日有多少行？",
      plans: () => [
        { think: "按交易日 count，顺便和前几个交易日比。",
          calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT trade_date, count() AS n FROM dws_account_pnl_daily WHERE trade_date >= '${TD[4]}' GROUP BY trade_date ORDER BY trade_date` }, ms: 70,
            output: ckOut({ rows: 5, cols: ["trade_date", "n"], preview: TD.slice(0, 5).reverse().map((d, i) => [d, i === 4 ? 1186 : 1190 + i]), ms: 58 }) }] },
      ],
      answer: () => `上个交易日（${TD[0]}）**1,186 行**，前 4 个交易日在 1,190~1,193 之间，少了 4~7 行。\n\n一行 = 一个账户一个交易日；少的几行通常是当天新开的子账户还没进 dim_account（晚一天才有），不是数据丢失。`,
    },
  ],
  "vision-dagster": [
    {
      q: "dwd_position_daily 最近 5 个交易日的行数正常吗？",
      plans: () => [
        { think: "直接在 CK 里按交易日 count，再和前一周的均值比。",
          calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT trade_date, count() AS n, uniqExact(account_id) AS accounts\nFROM dwd_position_daily WHERE trade_date >= '${TD[4]}'\nGROUP BY trade_date ORDER BY trade_date` }, ms: 210,
            output: ckOut({ rows: 5, cols: ["trade_date", "n", "accounts"], preview: TD.slice(0, 5).reverse().map((d, i) => [d, 48211 + i * 37, 1190 + (i % 3)]), ms: 196 }) }] },
      ],
      answer: () => `正常。最近 5 个交易日每天 **4.82 万~4.84 万行**，覆盖 1,190~1,192 个账户，和前一周均值（4.82 万）一致。\n\n\`\`\`sql\nSELECT trade_date, count() AS n, uniqExact(account_id) AS accounts\nFROM dwd_position_daily WHERE trade_date >= '${TD[4]}'\nGROUP BY trade_date ORDER BY trade_date\n\`\`\``,
    },
    {
      q: "ods_trade_fills 上个交易日的成交笔数按交易所分一下",
      plans: () => [
        { think: "成交表按 exchange 分组计数。",
          calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT exchange, count() AS fills, round(sum(price * qty) / 1e8, 2) AS amount_yi\nFROM ods_trade_fills WHERE trade_date = '${TD[0]}'\nGROUP BY exchange ORDER BY fills DESC` }, ms: 330,
            output: ckOut({ rows: 4, cols: ["exchange", "fills", "amount_yi"], preview: [["SSE", 412883, 38.21], ["SZSE", 377120, 31.07], ["CFFEX", 52310, 12.88], ["SHFE", 21944, 4.12]], ms: 318 }) }] },
      ],
      answer: () => `上个交易日（${TD[0]}）共 **86.4 万笔**成交：\n\n| 交易所 | 笔数 | 成交额（亿元） |\n|---|---|---|\n| SSE | 412,883 | 38.21 |\n| SZSE | 377,120 | 31.07 |\n| CFFEX | 52,310 | 12.88 |\n| SHFE | 21,944 | 4.12 |`,
    },
  ],
};

const ASK: Record<string, Scenario[]> = {
  "vision-board": [
    {
      q: "本环境 settings 里 STATIC_ROOT 和 CRONTAB_COMMAND_PREFIX 配的是什么？",
      plans: (r) => [
        { think: r.env === "prod"
            ? "生产的配置在 bash 里读不到，用 service_info(what=config) 读本环境给 agent 的只读版 settings（密钥打码）。"
            : "测试环境用的是项目的真实配置，bash 里也读得到；用 service_info(what=config) 读，密钥会打码。",
          calls: [{ tool: "service_info", args: { what: "config", path: `${HOME}/deploy/vision-board/vision_board/settings-${r.env}.py` }, ms: 30,
            output: `${r.env === "prod" ? "# 给 agent 的只读版：照抄线上的 vision_board/settings-prod.py，库口令换成只读账号" : "# 国内测试的 settings"}\nSTATIC_ROOT = "${HOME}/deploy/vision-board/static"\nCRONTAB_COMMAND_PREFIX = "DJANGO_SETTINGS_MODULE=vision_board.settings-${r.env}"\nCLICKHOUSE = {"host": "${r.env === "prod" ? "172.168.0.125" : "172.24.17.66"}", "port": 8123, "user": "${r.env === "prod" ? "board_ro" : "board"}", "password": ***}` }] },
      ],
      answer: (r) => `${r.env} 环境的 settings（\`vision_board/settings-${r.env}.py\`）：\n\n- \`STATIC_ROOT = "${HOME}/deploy/vision-board/static"\`：nginx 从这里出静态资源；\n- \`CRONTAB_COMMAND_PREFIX = "DJANGO_SETTINGS_MODULE=vision_board.settings-${r.env}"\`：定时任务按本环境的配置跑。\n\n${r.env === "prod" ? "读到的是控制台里填的给 agent 的只读版（照抄线上，库口令换成只读账号）" : "读到的是本环境项目的真实配置（密钥已打码）；里面的库账号能写，我只查不改"}。按档案，不要执行 \`manage.py crontab add\`，会改线上的定时任务。`,
    },
    {
      q: "报表页今天有没有 5xx？看一下线上日志",
      plans: (r) => remote(r) ? [
        { think: "先在 nginx 的访问日志里找 5xx。",
          calls: [{ tool: "logs", args: { name: "nginx_access", lines: 2000, grep: '" 5\\d\\d ' }, ms: 2, output: "" }] },
        { think: "代管执行看不到生产主机的日志。用浏览器打开报表页，看现在是不是正常。",
          calls: [
            { tool: "browser_navigate", args: { url: "https://vision-board.moon-prod.ipa.zs/report/strategy_weekly/" }, ms: 3100, output: "### Page state\n- Page URL: https://vision-board.moon-prod.ipa.zs/report/strategy_weekly/\n- Page Title: 策略周报 · Vision Board" },
            { tool: "browser_snapshot", args: {}, ms: 800, output: "- heading \"策略周报\" [level=1]\n- table [data-table=strategy] (14 rows)\n- button \"导出 HTML\"" },
          ] },
      ] : [
        { think: "先在 nginx 的访问日志里找 5xx，再到应用日志里看同一时刻的报错。",
          calls: [{ tool: "logs", args: { name: "nginx_access", lines: 2000, grep: '" 5\\d\\d ' }, ms: 180,
            output: `[/var/log/nginx/access.log] 最后 2000 行里匹配 '" 5\\\\d\\\\d ' 的 3 行\n172.24.8.31 - - [${TD[0]}:14:02:11 +0800] "GET /report/strategy_weekly/?week=${TD[4]} HTTP/1.1" 502 157 "-" "Mozilla/5.0"\n172.24.8.31 - - [${TD[0]}:14:02:19 +0800] "GET /report/strategy_weekly/?week=${TD[4]} HTTP/1.1" 502 157 "-" "Mozilla/5.0"\n172.24.9.77 - - [${TD[0]}:14:03:02 +0800] "GET /report/export/?fmt=html HTTP/1.1" 504 167 "-" "python-requests/2.32"` }] },
        { think: "14:02 前后集中出现 502/504。看应用日志同一时间段。",
          calls: [{ tool: "logs", args: { name: "app", lines: 1000, grep: "error|exception|traceback" }, ms: 120,
            output: `[${HOME}/deploy/vision-board/vision-board.log] 最后 1000 行里匹配 'error|exception|traceback' 的 2 行\n${TD[0]} 14:02:10,882 ERROR report.strategy clickhouse query timeout after 30s: SELECT … FROM dws_strategy_nav_daily\n${TD[0]} 14:03:01,417 ERROR report.export chrome headless exited with code 1` }] },
        { think: "查询超时和导出失败在同一时间，看看主机当时是不是资源吃紧。",
          calls: [{ tool: "host_status", args: {}, ms: 260, output: hostStatusOut({ env: "prod", service: "vision-board", created_at: iso(0) }) }] },
      ],
      answer: (r) => remote(r)
        ? "**看不了日志**：这次是测试机代管执行生产的运行，看不到生产主机上的 nginx 和应用日志（测试机上同名的日志是测试环境的）。\n\n用浏览器打开了线上策略周报页：现在能正常打开，表格 14 行、导出按钮都在。今天有没有出过 5xx 要到生产机上看 `/var/log/nginx/access.log`，或者等 agent 装到生产机之后再问。"
        : `今天有 **3 次 5xx**，都在 ${TD[0]} 14:02~14:03：\n\n| 时间 | 请求 | 状态 |\n|---|---|---|\n| 14:02:11 | /report/strategy_weekly/ | 502 |\n| 14:02:19 | /report/strategy_weekly/ | 502 |\n| 14:03:02 | /report/export/?fmt=html | 504 |\n\n应用日志里同一时刻是 **ClickHouse 查询超时**（dws_strategy_nav_daily，30 秒）和一次 Chrome 导出退出。主机内存还有 37G 可用、根盘 81%，不是资源问题；更可能是 CK 那会儿慢。之后没有再出现。`,
    },
  ],
  "vision-dagster": [
    {
      q: "昨天 dws_account_pnl_daily 是几点物化完的？",
      plans: () => [
        { think: "线上的物化记录用 dagster 的 MCP 工具查。",
          calls: [{ tool: "get_asset_materializations", args: { asset_key: "dws_account_pnl_daily", limit: 3 }, ms: 640,
            output: `partition=${TD[0]} status=SUCCESS start=18:41:07 end=18:52:33 run=7f3c21ab\npartition=${TD[1]} status=SUCCESS start=18:40:55 end=18:49:10 run=2b81e0c4\npartition=${TD[2]} status=SUCCESS start=18:41:02 end=18:50:47 run=c0a91d33` }] },
      ],
      answer: () => `上个交易日（${TD[0]}）的分区 **18:52** 物化完成（18:41 开始，用时 11 分钟），比前两天晚 2~3 分钟，属正常波动。\n\n依据：dagster MCP \`get_asset_materializations\`，运行 7f3c21ab。`,
    },
    {
      q: "在本环境跑一下 vision_dagster_tests 里 pnl 相关的测试",
      plans: () => [
        { think: "项目自带测试用 py 在项目内核里跑 pytest。",
          calls: [{ tool: "py", args: { code: `import pytest\npytest.main(["-q", "vision_dagster_tests/test_pnl.py"])` }, ms: 5400, output: ".......                                                                  [100%]\n7 passed in 3.42s\nExitCode.OK" }] },
      ],
      answer: (r) => `\`vision_dagster_tests/test_pnl.py\` 7 个用例**全部通过**（3.4 秒）。跑在线上的代码目录里，用的是本环境的解释器，${r.env === "prod" ? "配置是给 agent 的只读版" : "配置是本环境项目的真实配置"}。`,
    },
    {
      q: "这台机器内存还够吗？dagster 的容器都正常吗？",
      plans: (r) => [
        { think: "看部署主机的现状：负载、内存、磁盘、大进程、docker 容器。",
          calls: [{ tool: "host_status", args: {}, ms: 240, output: hostStatusOut(r) }] },
        ...(remote(r) ? [{ think: "代管执行看不到生产主机。换个角度：用 dagster 的工具看生产最近的运行，判断 daemon 和 code server 在不在工作。",
          calls: [{ tool: "recent_runs", args: { limit: 5 }, ms: 520,
            output: `run=7f3c21ab job=pnl_daily_job status=SUCCESS end=${TD[0]} 18:52\nrun=91ab3c0e job=position_daily_job status=SUCCESS end=${TD[0]} 18:52\nrun=2b81e0c4 job=pnl_daily_job status=SUCCESS end=${TD[1]} 18:49\nrun=5c07d2f1 job=position_daily_job status=SUCCESS end=${TD[1]} 18:31\nrun=c0a91d33 job=pnl_daily_job status=SUCCESS end=${TD[2]} 18:50` }] }] : []),
      ],
      answer: (r) => remote(r)
        ? "**看不了**：这次是测试机代管执行生产的运行，看不到生产主机的内存、进程和容器（测试机上同名的容器是测试环境的）。\n\n生产 Dagster 本身可以用 dagster 的工具看：最近的运行都正常结束，说明 daemon 和 code server 在工作；主机内存要到生产机上看。"
        : r.env === "prod"
        ? "够用：内存已用 88.4G / 125.6G，还有 37G 可用，没有用 swap；负载 3.4（32 核）。\n\n四个容器都在跑：webserver、daemon、code（healthy）、postgres。最占内存的是 dagster code-server（约 6G）。根盘 81%，接近 80% 的告警线，建议清理旧镜像（`docker image prune`，要运维确认）。"
        : "够用：内存已用 21.7G / 125.6G，负载 1.1（16 核），根盘 42%。\n\n四个容器都在跑：webserver、daemon、code（healthy）、postgres。最占内存的是 dagster code-server（约 6G）。",
    },
  ],
  "vision-web": [
    {
      q: "策略 alpha_mm_03 挂在哪些账户上？",
      plans: (r) => [
        { think: r.env === "test"
            ? "配置在 vision_cfg 的模型里，用 py 直接查 ORM。测试环境用的是项目的真实配置，库账号能写：只查，不调 save() / delete()。"
            : "配置在 vision_cfg 的模型里，用 py 直接查 ORM（只读）。",
          calls: [{ tool: "py", args: { code: `from vision_cfg.models import Strategy\ns = Strategy.objects.get(code="alpha_mm_03")\nprint(list(s.accounts.values_list("code", "name", "status")))` }, ms: 880,
            output: "[('A003', '做市三号', 'active'), ('A011', '做市主账户', 'active'), ('A016', '做市备用', 'paused')]" }] },
      ],
      answer: () => "策略 **alpha_mm_03** 挂在 3 个账户上：\n\n| 账户 | 名称 | 状态 |\n|---|---|---|\n| A003 | 做市三号 | 启用 |\n| A011 | 做市主账户 | 启用 |\n| A016 | 做市备用 | 暂停 |\n\n依据：`vision_cfg.models.Strategy.accounts`（只读查询，没有改任何配置）。",
    },
    {
      q: "vision_cfg 里组合（Portfolio）有哪些字段？",
      plans: (r) => [
        { think: "读模型定义。",
          calls: [{ tool: "bash", args: { command: `grep -n "class Portfolio" -A 16 ${codeDir(r)}/vision_cfg/models.py` }, ms: 30,
            output: "88:class Portfolio(models.Model):\n89:    code = models.CharField(max_length=32, unique=True)\n90:    name = models.CharField(max_length=64)\n91:    accounts = models.ManyToManyField(Account, related_name=\"portfolios\")\n92:    risk_limit = models.JSONField(default=dict)   # 风控参数：单票上限、行业上限、回撤线\n93:    benchmark = models.CharField(max_length=32, blank=True)\n94:    status = models.CharField(max_length=16, default=\"active\")\n95:    updated_at = models.DateTimeField(auto_now=True)" }] },
      ],
      answer: () => "`vision_cfg.models.Portfolio` 的字段：\n\n| 字段 | 类型 | 说明 |\n|---|---|---|\n| code | CharField(32)，唯一 | 组合代码 |\n| name | CharField(64) | 名称 |\n| accounts | 多对多 Account | 组合里的账户 |\n| risk_limit | JSONField | 风控参数：单票上限、行业上限、回撤线 |\n| benchmark | CharField(32) | 基准 |\n| status | CharField(16) | 默认 active |\n| updated_at | DateTimeField | 自动更新 |\n\n位置：`vision_cfg/models.py` 第 88 行。",
    },
  ],
};

// ———————— 失败分析：资产 × 报错 ————————

const ASSETS = ["dws_account_pnl_daily", "dwd_position_daily", "ads_strategy_report", "ods_trade_fills", "market_kline_1d"];
const ERRORS = [
  (asset: string) => `dagster._core.errors.DagsterExecutionStepExecutionError: Error occurred while executing op "${asset}":\n  upstream asset dwd_position_daily partition ${TD[0]} is missing`,
  () => `KeyError: 'account_id'\n  File "/opt/dagster/app/vision_dagster/assets/pnl.py", line 88, in account_pnl_daily`,
  () => `clickhouse_connect.driver.exceptions.OperationalError: Error HTTPConnectionPool(host='172.24.17.66', port=8123): Max retries exceeded (Caused by NewConnectionError: Connection refused)`,
  () => `clickhouse_connect.driver.exceptions.DatabaseError: Code: 241. DB::Exception: Memory limit (for query) exceeded: would use 9.31 GiB (attempt to allocate chunk of 4194304 bytes), maximum: 9.31 GiB. (MEMORY_LIMIT_EXCEEDED)`,
];

function failurePlans(r: Run): Plan[] {
  const asset = String(r.input.asset_key ?? "dws_account_pnl_daily");
  const err = String(r.input.error ?? "");
  const upstream = err.includes("upstream");
  return [
    { think: `按档案先用 dagster 的 MCP 工具看线上这次运行的日志，确认是上游缺分区还是 ${asset} 自己的问题。`,
      calls: [{ tool: "get_run_logs", args: { run_id: r.input.run_id, level: "ERROR" }, ms: 720,
        output: `18:41:12 ERROR ${asset} - STEP_FAILURE\n${err.split("\n")[0]}\n18:41:12 ERROR RUN_FAILURE Execution of run for "pnl_daily_job" failed.` }] },
    { think: remote(r) ? "再看 daemon 容器的日志有没有别的 Traceback（代管执行可能看不到，看不到就靠 dagster 的运行日志）。"
        : "再看线上 daemon 容器的日志：调度侧同一时刻有没有别的 Traceback（比如 code server 掉了）。",
      calls: [{ tool: "logs", args: { name: "daemon", lines: 1000, grep: "Traceback|Error" }, ms: 860,
        output: `[docker:vision-dagster-daemon] 最后 1000 行里匹配 'Traceback|Error' 的 3 行\n${TD[0]}T10:41:12.338Z ${TD[0]} 18:41:12 +0800 - dagster.daemon.QueuedRunCoordinatorDaemon - ERROR - Run for pnl_daily_job failed: STEP_FAILURE in ${asset}\n${TD[0]}T10:41:12.402Z Traceback (most recent call last):\n${TD[0]}T10:41:12.402Z   ${err.split("\n").pop()!.trim()}` }] },
    upstream
      ? { think: "日志里是读 dwd_position_daily 当天分区时报的。看上游最近几次物化：是不是晚于本资产的调度。",
        calls: [{ tool: "get_asset_materializations", args: { asset_key: "dwd_position_daily", limit: 3 }, ms: 610,
          output: `partition=${TD[0]} status=SUCCESS start=18:33:40 end=18:52:08 run=91ab3c0e\npartition=${TD[1]} status=SUCCESS start=18:20:11 end=18:31:46 run=5c07d2f1\npartition=${TD[2]} status=SUCCESS start=18:19:58 end=18:30:12 run=e4d8a6b0` }] }
      : { think: remote(r) ? "不是上游缺分区。读出错位置附近的代码（本机是测试机上部署的那份，只当参考），看最近的提交有没有动过。"
          : "不是上游缺分区。读出错位置附近的代码，看线上代码目录最近的提交有没有动过。",
        calls: [{ tool: "bash", args: { command: `cd ${codeDir(r)} && git log -3 --format='%h %cs %an %s' -- vision_dagster/assets/pnl.py` }, ms: 120,
          output: (r.env === "test" || remote(r) ? "c41e9a2 " + TD[2] + " gaodl fix: account_pnl_daily 先映射子账户\n" : "") + "8d02b7f " + TD[8] + " wangzh feat: 成交回报接入子账户\n52be0aa " + TD[11] + " gaodl chore: 分区键改 trade_date" }] },
    { think: "数据侧要验证上游这几天的行数是否正常，交给 data_searcher。",
      calls: [{ tool: "task", args: { subagent: "data_searcher", description: `查 ck 里 dwd_position_daily 最近 3 个交易日（${TD[2]} ~ ${TD[0]}）每天的行数与账户数，和前一周均值比，判断上游数据是否完整` }, ms: 7400,
        output: `dwd_position_daily 最近 3 个交易日行数 48,2xx 左右、账户 1,190 个，和前一周均值一致，数据完整；${TD[0]} 分区 18:52 才写完。`,
        sub: [{ think: "按交易日 count 一下。", calls: [{ tool: "db_query", args: { db: "ck", query: `SELECT trade_date, count() AS n, uniqExact(account_id) AS accounts FROM dwd_position_daily WHERE trade_date >= '${TD[2]}' GROUP BY trade_date ORDER BY trade_date` }, ms: 190,
          output: ckOut({ rows: 3, cols: ["trade_date", "n", "accounts"], preview: TD.slice(0, 3).reverse().map((d, i) => [d, 48238 + i * 21, 1190 + i % 2]), ms: 176 }) }] }] }] },
  ];
}

function failureAnswer(r: Run): string {
  const asset = String(r.input.asset_key ?? "dws_account_pnl_daily");
  const err = String(r.input.error ?? "");
  if (err.includes("KeyError") && remote(r)) return `## 根因\n成交回报里新开的子账户没有 \`account_id\`（只有 \`sub_account\`），\`account_pnl_daily()\` 第 88 行直接取 \`account_id\` 报 KeyError。\n\n## 证据\n- 运行日志（dagster 工具）：KeyError: 'account_id'，在 vision_dagster/assets/pnl.py:88\n- 测试机上的代码已经有修复提交 c41e9a2（先按 sub_account 映射）。这次是测试机代管执行，**看不到生产部署的是哪一版**：生产报了这个错，说明大概率还没部署到 c41e9a2\n\n## 影响范围\n\`${asset}\` 当日分区未产出，下游 \`ads_strategy_report\` 跟着缺数。\n\n## 建议\n确认生产的部署版本；部署到 c41e9a2 之后，用 dagster 的 reexecute_run 重跑当日分区；部署前可以先把新子账户补进 dim_account。`;
  if (err.includes("KeyError")) return `## 根因\n成交回报里新开的子账户没有 \`account_id\`（只有 \`sub_account\`），\`account_pnl_daily()\` 第 88 行直接取 \`account_id\` 报 KeyError。\n\n## 证据\n- 运行日志：KeyError: 'account_id'，在 vision_dagster/assets/pnl.py:88\n- 修复提交 c41e9a2（先按 sub_account 映射）只部署到了国内测试；国内生产的代码目录还停在 8d02b7f\n\n## 影响范围\n\`${asset}\` 当日分区未产出，下游 \`ads_strategy_report\` 跟着缺数。\n\n## 建议\n生产部署到 c41e9a2 之后，用 dagster 的 reexecute_run 重跑当日分区；部署前可以先把新子账户补进 dim_account。`;
  if (err.includes("Memory limit")) return `## 根因\nClickHouse 单查询内存超限：\`${asset}\` 的全量重算超过了 max_memory_usage（9.31 GiB）。\n\n## 证据\n- 运行日志：Code 241 MEMORY_LIMIT_EXCEEDED\n- 这次是 backfill 触发的全量重算，平时按交易日分区只用 1~2 GiB\n\n## 影响范围\n只影响这次 backfill，日常分区不受影响。\n\n## 建议\n按交易日分区逐个重算（scripts/backfill.py 的 --by-partition），不要一次全量。`;
  return `## 根因\n上游 \`dwd_position_daily\` 的 ${TD[0]} 分区 18:52 才物化完成，晚于 \`${asset}\` 18:40 的调度，读到空分区后失败。\n\n## 证据\n- dagster MCP：dwd_position_daily ${TD[0]} 分区 end=18:52:08，前两天 18:31 前就完成了\n- data_searcher：上游行数与账户数正常，数据完整，只是晚了\n- 本资产近 3 次提交与报错无关\n\n## 影响范围\n\`${asset}\` → \`ads_strategy_report\` 当日分区未产出，策略周报会缺这一天。\n\n## 建议\n1. 上游已就绪，现在重跑 \`${asset}\` 当日分区；\n2. 把 \`${asset}\` 的调度改成依赖上游分区完成（freshness / 资产依赖），替代固定时间。`;
}

// ———————— 巡检 / 冒烟 ————————

const INSPECT_ITEMS = ["报表数据新鲜度", "线上报表页可用与耗时", "应用日志报错", "主机资源"];
/** 巡检的待办：前 done 项完成，第 done 项进行中 */
const inspectTodo = (done: number) => {
  const items = INSPECT_ITEMS.map((content, i) => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" }));
  const marks: Record<string, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  return { tool: "todo", args: { items }, ms: 4,
    output: `待办已更新（完成 ${Math.min(done, items.length)}/${items.length}）：\n` + items.map((i) => `${marks[i.status]} ${i.content}`).join("\n") };
};

function inspectionPlans(r: Run): Plan[] {
  const site = r.env === "prod" ? "https://vision-board.moon-prod.ipa.zs/" : "https://vision-board.ipa.zs/";
  return [
    { think: "按方法「Board 巡检」逐项：报表数据新鲜度、线上页面、应用日志、主机资源。先列个待办，同时查报表依赖的几张表的最新交易日。",
      calls: [inspectTodo(0), { tool: "db_query", args: { db: "ck", query: "SELECT 'dws_account_pnl_daily' AS t, max(trade_date) AS latest FROM dws_account_pnl_daily\nUNION ALL SELECT 'dwd_position_daily', max(trade_date) FROM dwd_position_daily\nUNION ALL SELECT 'ads_strategy_report', max(trade_date) FROM ads_strategy_report\nUNION ALL SELECT 'market_kline_1d', max(trade_date) FROM market_kline_1d" }, ms: 160,
        output: ckOut({ rows: 4, cols: ["t", "latest"], preview: [["dws_account_pnl_daily", TD[0]], ["dwd_position_daily", TD[0]], ["ads_strategy_report", TD[0]], ["market_kline_1d", TD[0]]], ms: 144 }) }] },
    { think: "数据都到了上个交易日。看线上报表页能不能打开、耗时多少。",
      calls: [{ tool: "py", args: { code: `import requests\nfor p in ["report/pnl_daily/", "report/positions/", "report/strategy_weekly/"]:\n    r = requests.get("${site}" + p, timeout=15)\n    print(p, r.status_code, round(r.elapsed.total_seconds(), 2))` }, ms: 3100,
        output: "report/pnl_daily/ 200 0.84\nreport/positions/ 200 1.12\nreport/strategy_weekly/ 200 2.97" }] },
    { think: "策略周报 2.97 秒，比基线 1.5 秒慢一倍，记一项关注。看应用日志里有没有新的报错。",
      calls: [{ tool: "logs", args: { name: "app", lines: 2000, grep: "error|exception|traceback" }, ms: 140,
        output: `[${codeDir(r)}/vision-board.log] 最后 2000 行里匹配 'error|exception|traceback' 的 1 行\n${TD[0]} 07:12:44,019 ERROR report.strategy slow query 2.8s: SELECT … FROM dws_strategy_nav_daily` }] },
    { think: remote(r) ? "代管执行看不到生产主机的日志，这一项记成没法查。最后看主机资源（多半也看不到）。"
        : "只有一条慢查询，和周报页慢对得上。最后看主机资源。",
      calls: [inspectTodo(3), { tool: "host_status", args: {}, ms: 260, output: hostStatusOut(r) }] },
    { think: "四项都看完了，清单收尾。",
      calls: [inspectTodo(4)] },
  ];
}
const inspectionAnswer = (r?: Run) => r && remote(r)
  ? "巡检完成：**5 项正常，1 项关注，2 项没法查**。\n\n- ⚠️ 策略周报页 2.97 秒，基线 1.5 秒：慢了一倍，建议看 `report/strategy.py` 的查询\n- ➖ 应用日志、主机资源：这次是测试机代管执行，看不到生产主机，这两项跳过\n- 数据新鲜度：4 张表都到上个交易日 ✓\n- 账户收益日报、持仓明细页 200 ✓"
  : "巡检完成：**6 项正常，2 项关注**。\n\n- ⚠️ 策略周报页 2.97 秒，基线 1.5 秒：慢了一倍，应用日志里有对应的慢查询，建议看 `report/strategy.py`\n- ⚠️ 根盘 81%（阈值 80%），较上周 +5%，建议清理旧日志与 docker 镜像\n- 数据新鲜度：4 张表都到上个交易日 ✓\n- 账户收益日报、持仓明细页 200 ✓";

function smokePlans(r: Run): Plan[] {
  const site = r.env === "prod" ? "https://vision-board.moon-prod.ipa.zs/" : "https://vision-board.ipa.zs/";
  return [
    { think: `先确认线上代码目录的提交是不是待测版本 ${String(r.input.version ?? "")}。`,
      calls: [{ tool: "service_info", args: { what: "git" }, ms: 80, output: `## ${codeDir(r)}${remote(r) ? `（执行主机上的那份，不是 ${r.env} 部署的版本）` : ""}\n${String(r.input.version ?? "e5f6a7b").slice(0, 7)} ${TD[0]} wangzh feat: 离线 HTML 导出改用 Chrome headless\n5e6f7a8 ${TD[1]} liyd chore: 升级 Django 4.2.16` }] },
    { think: remote(r) ? "代管执行：本机的代码是测试机上部署的那份，对不了生产的版本，如实说明，只按页面的表现下结论。按方法 smoke-suite：打开线上报表页检查关键元素。"
        : "提交对得上。按方法 smoke-suite：打开线上报表页检查关键元素。",
      calls: [
        { tool: "browser_navigate", args: { url: site + "report/strategy_weekly/" }, ms: 3400, output: `### Page state\n- Page URL: ${site}report/strategy_weekly/\n- Page Title: 策略周报 · Vision Board` },
        { tool: "browser_snapshot", args: {}, ms: 900, output: "- heading \"策略周报\" [level=1]\n- table [data-table=strategy] (14 rows)\n- button \"导出 HTML\"\n- img \"收益率曲线\"" },
      ] },
  ];
}
const smokeAnswer = (r: Run) => remote(r)
  ? `页面冒烟通过：${r.env} 的报表页面正常。\n\n- 策略周报：表格 14 行、收益率曲线、导出按钮都在 ✓\n- ➖ 部署版本没法核对：这次是测试机代管执行，看不到生产机上的代码目录（测试机那份不算数）`
  : `冒烟通过：**${String(r.input.version ?? "").slice(0, 7)}** 在 ${r.env} 的报表页面正常。\n\n- 策略周报：表格 14 行、收益率曲线、导出按钮都在 ✓\n- 线上代码目录的提交与部署版本一致 ✓`;

// ———————— 发版小结（上游联动：冒烟 + 巡检都结束后） ————————

function releasePlans(r: Run): Plan[] {
  const ver = String(r.input.version ?? "e5f6a7b").slice(0, 7);
  return [
    { think: `冒烟和巡检都结束了。先确认线上代码目录现在是 ${ver}，再把两次运行的结论汇总。`,
      calls: [{ tool: "service_info", args: { what: "git" }, ms: 80, output: `## ${codeDir(r)}\n${ver} ${TD[0]} wangzh feat: 离线 HTML 导出改用 Chrome headless` }] },
  ];
}
const releaseAnswer = (r: Run) => `## 发版小结 · ${String(r.input.version ?? "").slice(0, 7) || "当前版本"} · ${r.env}\n\n- 冒烟：报表页面、导出按钮正常 ✓\n- 巡检：6 项正常，2 项关注（策略周报页 2.97 秒，根盘 81%）\n\n结论：可以放行；周报页慢的问题部署前就有，不是这次引入的。`;

// ———————— 生成运行 ————————

const PEOPLE = ["liyd", "gaodl", "wangzh", "zhaoq"];

function makeRun(): MockRun {
  const t = rand();
  const picked = t < 0.1 ? "ask" : t < 0.36 ? "data-qa" : t < 0.6 ? "failure-analysis" : t < 0.75 ? "daily-inspection" : t < 0.86 ? "frontend-smoke" : t < 0.91 ? "memory-gardener" : "failure-analysis:dws_account_pnl_daily";
  const taskName = picked === "data-qa" && rand() < 0.25 ? "data-qa:account_pnl" : picked;
  const task = tasks.find((x) => x.name === taskName)!;
  const base = task.extends ? tasks.find((x) => x.name === task.extends)! : task;
  const ago = Math.floor(Math.pow(rand(), 1.6) * 72 * HOUR) + between(1, 20) * MIN;
  const env = base.envs.length ? pick(base.envs) : base.service === null ? "prod" : pick(["prod", "test", "test"]);
  const service = base.service === "*"
    ? (base.name === "data-qa" ? pick(["vision-board", "vision-board", "vision-board", "vision-dagster"]) : pick(["vision-board", "vision-dagster", "vision-web"]))
    : base.service;
  const s = rand();
  let status: RunStatus = s < 0.82 ? "success" : s < 0.94 ? "failed" : "cancelled";
  if (ago < 25 * MIN && rand() < 0.5) status = "running";
  const duration = status === "running" ? null : between(6_000, Math.min(base.timeout_s, 600) * 400);
  const triggerType = base.triggers.find((x) => x.type !== "api")?.type ?? "api";
  const fromTrigger = rand() < 0.78;
  const caller = triggerType === "schedule" ? "schedule" : triggerType === "chat" ? pick(PEOPLE) : triggerType === "event" ? (base.name === "frontend-smoke" ? "gitlab" : "vision-dagster-sensor") : "sdk";
  // 通用任务的定时按服务各有一个触发器（记忆园丁：nightly-dagster / nightly-board / nightly-web）
  const scheduleOf = (type: string) => base.triggers.find((x) => x.type === type && (x.type !== "schedule" || !x.service || x.service === service));
  const trigger = fromTrigger && triggerType !== "api"
    ? { type: triggerType, id: scheduleOf(triggerType)?.id ?? null, source: triggerType === "event" ? (base.triggers.find((x) => x.type === "event") as { source: string }).source : null, caller }
    : { type: "api" as const, id: "api", source: null, caller: pick(["vision-board-backend", "notebook-zhaoq", "liyd"]) };
  const asset = taskName.includes(":") && base.name === "failure-analysis" ? taskName.split(":")[1] : pick(ASSETS);
  const err = pick(ERRORS)(asset);
  let scenario: number | undefined;
  let input: Record<string, unknown> = {};
  if (base.name === "data-qa") {
    const list = QA[service ?? ""] ?? QA["vision-board"];
    scenario = taskName === "data-qa:account_pnl" ? 0 : Math.floor(rand() * list.length);
    input = { question: list[scenario].q };
  } else if (base.name === "ask") {
    const list = ASK[service ?? ""] ?? ASK["vision-board"];
    scenario = Math.floor(rand() * list.length);
    input = { question: list[scenario].q };
  } else if (base.name === "failure-analysis") {
    input = { run_id: hex(8) + "-" + hex(4) + "-" + hex(4), asset_key: asset, error: err };
  } else if (base.name === "frontend-smoke") {
    input = { version: hex(40), project: "vision-board" };
  } else if (base.name === "daily-inspection") {
    input = { scope: "full" };
  }
  const ruleHit = base.name === "failure-analysis" && /connection.*(refused|timeout|reset)/i.test(err) && rand() < 0.8;
  const summary = String(input.question ?? (input.asset_key ? `${input.asset_key} 物化失败` : input.version ? `部署 ${String(input.version).slice(0, 8)}` : base.name === "daily-inspection" ? "定时巡检" : base.title));
  const run: MockRun = {
    run_id: hex(12), session_id: "", task: taskName, task_title: base.title, service, env, role: base.role,
    status: ruleHit ? "success" : status, resolution: ruleHit ? "rule" : status === "running" ? null : base.form === "builtin" ? "builtin" : "agent",
    trigger: trigger as Run["trigger"], summary, tokens: ruleHit || base.form === "builtin" ? 0 : between(6_000, 96_000),
    duration_ms: ruleHit ? between(40, 300) : duration, created_at: iso(ago),
    finished_at: status === "running" && !ruleHit ? null : new Date(NOW - ago + (duration ?? 0)).toISOString(),
    // 任务版本：两成停在上一版；角色版本按版本时间线（每 31 小时一版）
    task_version: Math.max(1, task.version - (rand() < 0.2 ? 1 : 0)),
    role_version: base.role ? versionAt(roles.find((r) => r.name === base.role)!.version, ago) : null,
    recipe: null,
    replay_of: null, input, output: null, error_code: null, attempt: 1, retry_at: null, depends_on: [],
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
    feedback: [],
    memory: {},
    _scenario: scenario,
    // 内建处理器的结果就是运行输出（JSON）
    _output: base.handler === "memory-gardener" && status === "success" ? { env, drift_expired: service === "vision-board" ? between(0, 2) : between(0, 1) } : undefined,
  };
  run.recipe = recipeOf(run, ago);
  return run;
}

export const runs: MockRun[] = Array.from({ length: 260 }, () => makeRun())
  .sort((a, b) => b.created_at.localeCompare(a.created_at));

// ———————— 调度：上游联动建的运行、等着自动重试的失败、点名等上游的排队运行 ————————

const emptyContext = () => ({ profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] });

/** 上游联动建的运行：上游结束后 1~3 秒建、同一个环境、调用身份沿用上游的；还没到结束时间的算执行中 */
function afterRun(up: MockRun, taskName: string, triggerId: string, input: Record<string, unknown>, summary: string, failed = false): MockRun | null {
  if (!up.finished_at) return null;
  const task = tasks.find((x) => x.name === taskName)!;
  const startMs = new Date(up.finished_at).getTime() + between(1, 3) * 1000;
  if (startMs > NOW) return null;
  const duration = between(80_000, 320_000);
  const done = startMs + duration < NOW;
  const run: MockRun = {
    run_id: hex(12), session_id: "", task: taskName, task_title: task.title, service: up.service, env: up.env, role: task.role,
    status: done ? (failed ? "failed" : "success") : "running", resolution: done ? "agent" : null,
    trigger: { type: "after", id: triggerId, source: up.run_id, caller: up.trigger.caller },
    summary, tokens: done ? between(18_000, 64_000) : null, duration_ms: done ? duration : null,
    created_at: new Date(startMs).toISOString(), finished_at: done ? new Date(startMs + duration).toISOString() : null,
    task_version: task.version, role_version: task.role ? versionAt(roles.find((r) => r.name === task.role)!.version, NOW - startMs) : null,
    recipe: null, replay_of: null, input, output: null, error_code: null, attempt: 1, retry_at: null, depends_on: [],
    context: emptyContext(), feedback: [], memory: {},
  };
  run.recipe = recipeOf(run, NOW - startMs);
  return run;
}

/** 演示的上游联动：冒烟通过 → 巡检（任一）；冒烟 + 巡检都结束 → 发版小结（全部） */
const chained: MockRun[] = [];
export const chainPairs: { up: MockRun; down: MockRun; at: string }[] = [];
for (const smoke of runs.filter((r) => r.task === "frontend-smoke" && r.status === "success").slice(0, 7)) {
  const insp = afterRun(smoke, "daily-inspection", "after-smoke", { scope: "full" }, "部署后巡检", rand() < 0.15);
  if (!insp) continue;
  chained.push(insp);
  chainPairs.push({ up: smoke, down: insp, at: insp.created_at });
  const report = insp.status === "running" ? null
    : afterRun(insp, "release-report", "after-checks", { version: smoke.input.version }, `发版小结 ${String(smoke.input.version ?? "").slice(0, 8)}`);
  if (report) { chained.push(report); chainPairs.push({ up: insp, down: report, at: report.created_at }); }
}
runs.push(...chained);

// 失败分析：最近一次 429 失败的正等着自动重试（任务配了 retry：2 次、间隔 120 秒），mock 里 50 秒后到点
const retrying = runs.find((r) => r.task.startsWith("failure-analysis") && r.status === "failed" && r.resolution === "agent");
if (retrying) {
  const finished = new Date(NOW - 70_000);
  Object.assign(retrying, { created_at: new Date(finished.getTime() - (retrying.duration_ms ?? 120_000)).toISOString(), finished_at: finished.toISOString(), retry_at: new Date(NOW + 50_000).toISOString() });
}

// 点名等上游：一条 API 提交的问答，等一次还在执行的运行出结论（RunRequest.after）；mock 里执行中的运行不会结束，它就一直等着
const waitedOn = runs.find((r) => r.status === "running" && r.task.startsWith("failure-analysis"))
  ?? runs.find((r) => r.status === "running" && r.trigger.type !== "replay" && r.task !== "memory-gardener");
if (waitedOn) {
  const at = new Date(new Date(waitedOn.created_at).getTime() + 40_000);
  const q = `等这次「${waitedOn.task_title}」出结论后，把结论和影响整理成给业务方的说明（不要技术细节）`;
  const run: MockRun = {
    run_id: hex(12), session_id: "", task: "ask", task_title: "问一下", service: waitedOn.service, env: waitedOn.env, role: "generalist",
    status: "queued", resolution: null, trigger: { type: "api", id: "api", source: null, caller: "notebook-zhaoq" },
    summary: q, tokens: null, duration_ms: null, created_at: (at.getTime() > NOW ? new Date(NOW - 5000) : at).toISOString(), finished_at: null,
    task_version: 1, role_version: versionAt(roles.find((r) => r.name === "generalist")!.version, 0), recipe: null, replay_of: null,
    input: { question: q }, output: null, error_code: null, attempt: 1, retry_at: null, depends_on: [waitedOn.run_id],
    context: emptyContext(), feedback: [], memory: {}, _scenario: 0,
  };
  run.recipe = recipeOf(run, 0);
  runs.push(run);
}
runs.sort((a, b) => b.created_at.localeCompare(a.created_at));

/** 执行主机：测试两台各管一部分、都代管生产（REMOTE_ENVS）；一台已下线的旧主机（7 天内报过到的都列出来） */
export const workers: Worker[] = [
  { worker_id: "172.24.24.136:test", host: "172.24.24.136", env: "test", services: ["vision-dagster"], remote_envs: REMOTE_ENVS, version: PLATFORM, max_concurrent: 4, running: 0, started_at: iso(12 * DAY), seen_at: iso(11000), stopped_at: null, online: true },
  { worker_id: "172.21.0.45:test", host: "172.21.0.45", env: "test", services: ["vision-board", "vision-web"], remote_envs: REMOTE_ENVS, version: PLATFORM, max_concurrent: 4, running: 0, started_at: iso(2 * DAY), seen_at: iso(3000), stopped_at: null, online: true },
  { worker_id: "172.21.0.46:test", host: "172.21.0.46", env: "test", services: ["vision-web"], remote_envs: [], version: "8.4.1", max_concurrent: 2, running: 0, started_at: iso(9 * DAY), seen_at: iso(2 * DAY + 3 * HOUR), stopped_at: iso(2 * DAY + 3 * HOUR), online: false },
];

/** 触发记录（新的在前）：定时 / 事件 / 联动建了运行的各记一条，外加几条没建运行的（跳过、过滤、没人接、被拒、在等） */
const tickOf = (at: string, t: Omit<Tick, "id" | "at" | "detail"> & { detail?: Tick["detail"] }): Tick => ({ id: 0, at, detail: null, ...t });
const seededTicks: Tick[] = [];
for (const r of runs) {
  const k = r.trigger.type;
  if (k !== "schedule" && k !== "event" && k !== "after") continue;
  const tr = tasks.find((t) => t.name === r.task.split(":")[0])?.triggers.find((x) => x.id === r.trigger.id);
  const reason = k === "schedule" ? `按 ${tr && tr.type === "schedule" ? tr.cron : "cron"} 到点`
    : k === "after" ? `上游 ${runs.find((x) => x.run_id === r.trigger.source)?.task ?? "—"} 成功`
      : r.resolution === "rule" ? "规则先行命中（infra）" : `${r.trigger.source}.${(tr as { event?: string } | undefined)?.event ?? "event"}`;
  seededTicks.push(tickOf(r.created_at, { kind: k, outcome: "fired", task: r.task, trigger_id: r.trigger.id, env: r.env,
    source: k === "after" ? r.trigger.source : k === "event" ? r.trigger.source : null, run_id: r.run_id, reason }));
}
// 冒烟先结束、巡检还没结束时，发版小结在等
for (const { up, down } of chainPairs.filter((p) => p.down.task === "daily-inspection")) {
  seededTicks.push(tickOf(down.created_at, { kind: "after", outcome: "waiting", task: "release-report", trigger_id: "after-checks", env: up.env, source: up.run_id, run_id: null,
    reason: "还在等 daily-inspection 结束（6 小时内）", detail: { have: ["frontend-smoke"] } }));
}
seededTicks.push(
  tickOf(iso(5 * HOUR + 12 * MIN), { kind: "event", outcome: "unmatched", task: null, trigger_id: null, env: "prod", source: "dagster", run_id: null,
    reason: "dagster.run_success 没有任务接（没有任务声明这个事件，或过滤条件都不满足）", detail: { event: "run_success", data: { run_id: "4c1e09d2", asset_keys: "ods_trade_fills,dwd_position_daily", env: "prod" } } }),
  tickOf(iso(9 * HOUR + 3 * MIN), { kind: "event", outcome: "filtered", task: "frontend-smoke", trigger_id: "on-deploy", env: "test", source: "gitlab", run_id: null,
    reason: "gitlab.deployment 不满足过滤条件", detail: { event: "deployment", data: { project: "vision-web", ref: "3b9d0f1", env: "test" }, filter: { project: "^vision-board$" } } }),
  tickOf(iso(9 * HOUR + 3 * MIN), { kind: "event", outcome: "unmatched", task: null, trigger_id: null, env: "test", source: "gitlab", run_id: null,
    reason: "gitlab.deployment 没有任务接（没有任务声明这个事件，或过滤条件都不满足）", detail: { event: "deployment", data: { project: "vision-web", ref: "3b9d0f1", env: "test" } } }),
  tickOf(iso(26 * HOUR), { kind: "event", outcome: "rejected", task: "frontend-smoke", trigger_id: "on-deploy", env: "prod", source: "gitlab", run_id: null,
    reason: "服务 vision-board 在 prod 暂停了自动触发（定时、事件、上游联动）", detail: { code: "triggers_paused" } }),
  tickOf(iso(31 * HOUR), { kind: "event", outcome: "deduped", task: "failure-analysis:dws_account_pnl_daily", trigger_id: "on-failure", env: "prod", source: "dagster",
    run_id: runs.find((r) => r.task === "failure-analysis:dws_account_pnl_daily")?.run_id ?? null, reason: "命中去重，复用已有的运行" }),
);
export const ticks: Tick[] = seededTicks.sort((a, b) => b.at.localeCompare(a.at)).map((t, i, all) => ({ ...t, id: all.length - i }));
export const nextTickId = () => ticks.length ? Math.max(...ticks.map((t) => t.id)) + 1 : 1;

// 反馈：约 15% 的已结束运行有人评价；负反馈带问题类型与说明，少数针对某一步
const NEGATIVE: { reasons: FeedbackReason[]; comment: string; step?: number }[] = [
  { reasons: ["wrong_definition"], comment: "收益要按交易日统计，这里按自然日算，周末多出两天。" },
  { reasons: ["wrong_data"], comment: "查的是国内测试的 CK，问的是生产数据。" },
  { reasons: ["incomplete"], comment: "只给了合计，没给分账户明细。" },
  { reasons: ["wrong_conclusion", "detour"], comment: "根因是上游 dwd_position_daily 晚到，不是代码问题；查了半天无关的提交。" },
  { reasons: ["wrong_tool"], comment: "这里用 dagster 的 MCP 工具看运行日志就行，不用再去 grep 容器日志。", step: 6 },
  { reasons: ["off_topic"], comment: "" },
  { reasons: ["unsafe"], comment: "不要在 prod 的项目内核里物化资产，先在 test 复现。", step: 5 },
];
for (const r of runs) {
  if (r.status === "running" || r.status === "queued" || r.resolution !== "agent" || rand() > 0.15) continue;
  const who = pick(PEOPLE);
  const negative = rand() < 0.45;
  // 评价时间不能晚于现在（刚结束的运行加几分钟会跑到未来，页面显示成"3 小时内"）
  const at = new Date(Math.min(Date.now(), new Date(r.created_at).getTime() + between(5, 300) * 60_000)).toISOString();
  const base = { id: r.feedback.length + Math.floor(rand() * 1e6), run_id: r.run_id, created_by: who, created_at: at, updated_at: at };
  if (!negative) { r.feedback.push({ ...base, step_seq: 0, score: 1, reasons: [], comment: rand() < 0.3 ? "结论准确，省了半小时。" : "" }); continue; }
  const n = pick(NEGATIVE);
  r.feedback.push({ ...base, step_seq: n.step ?? 0, score: -1, reasons: n.reasons, comment: n.comment });
}

// 会话：对话触发的问答串成会话；失败分析按会话模板 dagster:{asset_key}:{error_class}:{date}；其余运行自会话
const sessionPool = Array.from({ length: 9 }, () => hex(12));
for (const r of runs) {
  if (r.task.startsWith("data-qa") && r.trigger.type === "chat") r.session_id = (r.task === "data-qa" ? "" : r.task.split(":")[1] + "-") + pick(sessionPool);
  else if (r.task === "ask" && r.trigger.type === "chat") r.session_id = "ask-" + pick(sessionPool.slice(0, 4));
  else if (r.task.startsWith("failure-analysis") && r.trigger.type === "event" && r.input.asset_key) {
    const cls = String(r.input.error).match(/^(?:\w+\.)*(\w+(?:Error|Exception))/)?.[1] ?? "Error";
    r.session_id = `dagster:${r.input.asset_key}:${cls}:${r.created_at.slice(0, 10)}`;
  } else r.session_id = r.run_id;
}

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
    const at = new Date(Math.min(Date.now(), new Date(r.created_at).getTime() + 40 * MIN)).toISOString();
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
  const own = tasks.find((t) => t.name === source.task);
  const run_id = hex(12);
  const done = status !== "running" && status !== "queued";
  const run: MockRun = {
    ...source, run_id, session_id: run_id, status, resolution: done ? "agent" : null,
    trigger: { type: "replay", id: source.run_id, source: null, caller },
    tokens: done ? between(8_000, 60_000) : null, duration_ms: done ? between(20_000, 120_000) : null,
    created_at: createdAt, finished_at: done ? new Date(new Date(createdAt).getTime() + 40_000).toISOString() : null,
    task_version: own?.version ?? source.task_version, role_version: roles.find((r) => r.name === source.role)?.version ?? null,
    recipe: null,
    replay_of: source.run_id, input: source.input, output: null, error_code: null, attempt: 1, retry_at: null, depends_on: [], feedback: [], memory: {},
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
    _events: undefined, _answer: answer,
  };
  run.recipe = recipeOf(run, 0);       // 用当前定义重跑：配方是现在生效的各版本
  return run;
}

const total7 = pnlTotals.reduce((n, [, v]) => n + v, 0);
const ANSWERS: Record<string, string> = {
  qaFixed: `按交易日统计（非交易日没有行）：近 7 个交易日 12 个账户收益合计 **${yuan(total7)}**，已实现 + 浮动，口径与报表的 \`account_pnl()\` 一致。\n\n最高的是 ${pnlTotals[0][0]}（${yuan(pnlTotals[0][1])}），最低的是 ${pnlTotals[11][0]}（${yuan(pnlTotals[11][1])}）。分账户明细见下表。\n\n| 账户 | 收益 |\n|---|---|\n${pnlTotals.map(([a, n]) => `| ${a} | ${yuan(n)} |`).join("\n")}`,
  qaSame: `近 7 天（自然日，含周末）12 个账户收益合计 **${yuan(Math.round(total7 * 1.08))}**。`,
  qaWorse: `近 7 天（自然日）收益合计 **${yuan(Math.round(total7 * 1.15))}**：把测试账户 T001 也算进去了。`,
  qaUnclear: `改用 ads_strategy_report 的预聚合结果：近 7 个交易日收益合计 **${yuan(Math.round(total7 * 0.99))}**。与 dws 明细表差 1%，要核对 ads 分区是否到齐。`,
  faFixed: `## 根因\n上游 \`dwd_position_daily\` 的 ${TD[0]} 分区 18:52 才物化完成，晚于本资产 18:40 的调度，读到空分区。\n\n## 证据\n- dagster MCP 的运行日志：读 dwd_position_daily 当天分区时报 missing\n- 上游物化记录 end=18:52:08；本资产近 3 次提交与报错无关\n\n## 建议\n上游已就绪，重跑当日分区；调度改成依赖上游分区完成。`,
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
function makeReplay(id: number, title: string, filter: ReplayFilter, note: string, who: string, msAgo: number,
  plans: [MockRun, ReplayVerdict | null, string, string?][]): MockReplay {
  const createdAt = iso(msAgo);
  const judgedAt = new Date(NOW - msAgo + 90_000).toISOString();
  const items = plans.map(([src, verdict, reason, answer]): MockReplayItem => {
    const own = tasks.find((t) => t.name === src.task);
    if (own) src.task_version = Math.max(1, own.version - 1);     // 原运行停在上一版定义
    if (src.recipe) src.recipe.task.version = src.task_version!;
    if (verdict === "error") return { id: nextReplayItemId(), source_run: src.run_id, new_run: null, verdict, reason, judged_at: createdAt };
    const run = replayRunOf(src, createdAt, verdict === null ? "running" : "success", who, answer);
    runs.push(run);
    return { id: nextReplayItemId(), source_run: src.run_id, new_run: run.run_id, verdict, reason, judged_at: verdict ? judgedAt : null };
  });
  return { id, title, filter, note, created_by: who, created_at: createdAt, items };
}

const qaNeg = sample(negatives.filter((r) => r.task.startsWith("data-qa")), 5);
const faNeg = sample(negatives.filter((r) => r.task.startsWith("failure-analysis")), 3);
const oneNeg = sample(negatives, 1);
const QA_PLAN: [ReplayVerdict, string, string][] = [
  ["fixed", "新答案改为按交易日统计、口径与报表一致，被指出的问题已解决，也没有引入新的错误。", ANSWERS.qaFixed],
  ["fixed", "新答案给出了分账户明细，并按交易日统计，与人指出的要求一致。", ANSWERS.qaFixed],
  ["same", "新答案仍按自然日统计（含周末），人指出的问题还在。", ANSWERS.qaSame],
  ["worse", "新答案仍按自然日统计，还把测试账户算了进来，比原答案更偏。", ANSWERS.qaWorse],
  ["unclear", "新答案换了取数表，结果是否正确要核对 ads 分区才能判断。", ANSWERS.qaUnclear],
];
const FA_PLAN: [ReplayVerdict | null, string, string?][] = [
  ["fixed", "新答案先看了 dagster 的运行日志，把根因落到上游 dwd_position_daily 晚到，并给出重跑建议，没有再归因到代码。", ANSWERS.faFixed],
  ["error", "提交被拒绝：服务 vision-dagster 在 test 环境已停用（重放时 test 临时停用过，之后已恢复）"],
  [null, ""],
];

export const replays: MockReplay[] = [
  makeReplay(3, "failure-analysis · vision-dagster · 3 条 👎", { task: "failure-analysis", service: "vision-dagster", limit: 20 },
    "failure-analysis 的档案补了：资产失败先看上游；先用 dagster 的 MCP 工具看线上这次运行的日志", "gaodl", 2 * MIN,
    faNeg.map((r, i) => [r, ...FA_PLAN[i % FA_PLAN.length]] as [MockRun, ReplayVerdict | null, string, string?])),
  makeReplay(2, "全部 · 1 条 👎", { run_ids: oneNeg.map((r) => r.run_id) }, "单独验证一条：改了任务档案之后", "wangzh", 26 * HOUR,
    oneNeg.map((r) => [r, "fixed", "新答案针对人指出的问题做了修正，没有引入新的错误。"] as [MockRun, ReplayVerdict, string])),
  makeReplay(1, "data_searcher 提示词 v4 回归", { task: "data-qa", hours: 168, limit: 20 },
    "data_searcher 的提示词补了「收益按交易日统计；db_query 的大结果用 pandas 读文件汇总，别把明细整份贴出来」", "wangzh", 2 * DAY,
    qaNeg.map((r, i) => [r, ...QA_PLAN[i % QA_PLAN.length]] as [MockRun, ReplayVerdict, string, string])),
];
runs.sort((a, b) => b.created_at.localeCompare(a.created_at));

// ———————— 运行事件（详情页按需生成，确定性） ————————

/** 系统提示：平台基础约定 + 角色提示词（沿继承链）+ 可委派的子代理 */
function systemPrompt(roleName: string | null): string {
  const chain = roleChain(roleName);
  const [root, ...children] = chain;
  const parts = [promptsEntry.base];
  if (root?.prompt) parts.push(`[角色：${(children[children.length - 1] ?? root).title}]\n${root.prompt}`);
  for (const c of children) if (c.prompt_append) parts.push(c.prompt_append);
  const subs = subagentsOf(chain).filter((s) => s !== roleName);
  if (subs.length) parts.push("[可委派的子代理] 子问题明显属于下面某个角色的专长时，用 task 工具交给它（subagent 填名字），它用自己的工具独立完成并交回结论。它看不到你的对话，说明里要写全背景和要交回什么：\n"
    + subs.map((s) => `- ${s}（${roles.find((r) => r.name === s)?.title ?? s}）：${roles.find((r) => r.name === s)?.description ?? "—"}`).join("\n"));
  return parts.join("\n\n");
}

/** 旧运行（9.0 之前）的查库结果：只有表格和行数 */
function legacyDbOutput(output: string): string {
  const lines = output.split("\n");
  const rows = Number(/(\d+) 行/.exec(lines[0])?.[1] ?? 0);
  const body = lines.slice(1).filter((l) => !l.startsWith("全部结果在"));
  return [...body, `(${rows} 行${rows > 20 ? "，只显示前 20 行" : ""})`].join("\n");
}

function plansOf(run: MockRun): Plan[] {
  const base = run.task.split(":")[0];
  if (base === "data-qa") return (QA[run.service ?? ""] ?? QA["vision-board"])[run._scenario ?? 0]?.plans(run) ?? [];
  if (base === "ask") return (ASK[run.service ?? ""] ?? ASK["vision-board"])[run._scenario ?? 0]?.plans(run) ?? [];
  if (base === "failure-analysis") return failurePlans(run);
  if (base === "daily-inspection") return inspectionPlans(run);
  if (base === "frontend-smoke") return smokePlans(run);
  if (base === "release-report") return releasePlans(run);
  return [];
}

function answerOf(run: MockRun): string {
  const base = run.task.split(":")[0];
  if (base === "data-qa") return (QA[run.service ?? ""] ?? QA["vision-board"])[run._scenario ?? 0]?.answer(run) ?? "";
  if (base === "ask") return (ASK[run.service ?? ""] ?? ASK["vision-board"])[run._scenario ?? 0]?.answer(run) ?? "";
  if (base === "failure-analysis") return failureAnswer(run);
  if (base === "daily-inspection") return inspectionAnswer(run);
  if (base === "frontend-smoke") return smokeAnswer(run);
  if (base === "release-report") return releaseAnswer(run);
  return "完成。";
}

export function eventsOf(run: MockRun): RunEvent[] {
  if (run._events) return run._events;
  if (run.status === "queued") return [];            // 还没被认领：时间线是空的（不缓存，开始后再生成）
  const r = mulberry32(parseInt(run.run_id.slice(0, 8), 16));
  const start = new Date(run.created_at).getTime();
  /** 9.0 之前的运行：没有配方；查库工具叫 sql_query，思考是 thought 事件，没有逐次的模型调用记录 */
  const legacy = NOW - start > RECIPE_SINCE && run.trigger.type !== "replay";
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
    push("stage", { stage: "deliver", title: "投递", content: "钉钉 default ✓" }, 300);
    return (run._events = out);
  }
  if (run.task === "memory-gardener") {
    push("stage", { stage: "execute", title: "内建处理器 memory-gardener", content: `校验 ${run.service} 在 ${run.env} 的记忆引用的代码（${codeDir(run)}）` }, 800);
    if (run.status === "running") return (run._events = out);
    if (run.status === "failed") {
      push("error", { title: "error", content: `TimeoutExpired: git -C ${codeDir(run)} 超时（5 秒）` }, 6000);
      return (run._events = out);
    }
    if (run.status === "cancelled") return (run._events = out);
    push("final", { content: JSON.stringify(run._output ?? { env: run.env, drift_expired: 0 }, null, 2) }, 12000);
    return (run._events = out);
  }
  const svc = services.find((s) => s.name === run.service);
  const task = tasks.find((x) => x.name === run.task);
  push("stage", { stage: "profile", title: "注入档案", content: `服务档案 ${Object.keys(svc?.profile ?? {}).length} 项 · 任务档案 ${Object.keys(task?.profile ?? {}).length} 项` }, 120);
  push("stage", { stage: "recall", title: "召回记忆", content: run.task.startsWith("failure-analysis") ? "事实 2 条 · 教训 1 条 · 方法 1 条" : "事实 3 条 · 方法 1 条" }, 600);
  push("stage", { stage: "system", title: legacy ? `系统提示 · 角色 ${run.role ?? "—"}` : `系统提示 · 平台提示词 v${run.recipe?.prompts ?? promptsEntry.version} + 角色 ${run.role ?? "—"}`, content: systemPrompt(run.role) }, 80);

  /** 一次模型调用：输入 token 随对话增长；content 是模型的思考过程 */
  let context = 3200 + Math.round(r() * 2400);
  const model = (calls: string[], content?: string, agent?: string) => {
    if (legacy) { if (content) push("thought", { ...(agent ? { agent } : {}), content }, 1500); return; }
    const input = context;
    const output = 80 + Math.round(r() * 520);
    context += output + 600 + Math.round(r() * 1400);
    // 账号的并发名额（3 个，生产和测试共用）占满时要排队：大约一成调用要等 1~8 秒
    const queued = r() < 0.1 ? 1000 + Math.round(r() * 7000) : 0;
    const ms = 1600 + Math.round(r() * 6800) + queued;
    push("model_call", { ...(agent ? { agent } : {}), model: MODEL, ms, ...(queued ? { queued_ms: queued } : {}), input_tokens: input, output_tokens: output, tokens: input + output, tool_calls: calls, ...(content ? { content } : {}) }, ms);
  };
  const emit = (plans: Plan[], agent?: string) => {
    for (const p of plans) {
      model(p.calls.map((c) => (legacy && c.tool === "db_query" ? "sql_query" : c.tool)), p.think, agent);
      for (const c of p.calls) {
        const old = legacy && c.tool === "db_query";
        const tool = old ? "sql_query" : c.tool;
        // call：同一次调用的 tool_call / tool_result 配对用（9.0 之前的旧运行没有）
        const call = legacy ? {} : { call: `c${seq + 1}` };
        push("tool_call", { ...(agent ? { agent } : {}), tool, ...call, args: old ? { sql: c.args.query } : c.args }, 300);
        if (c.sub) {
          const sub = String(c.args.subagent);
          emit(c.sub, sub);
          model([], "查完了，按要求交回结论。", sub);
        }
        // 代管执行（过渡期测试机代管生产）：看不到那个环境的主机，logs / host_status 和后端一样返回不可用
        const unavailable = remote(run) && (c.tool === "logs" || c.tool === "host_status");
        const output = unavailable ? remoteUnavailable(run.env, c.tool === "logs" ? "日志" : "主机状况（负载、内存、磁盘、进程、端口、crontab、容器、nginx）")
          : old ? legacyDbOutput(c.output) : c.output;
        push("tool_result", { ...(agent ? { agent } : {}), tool, ...call, output, duration_ms: unavailable ? 2 : c.ms ?? 300 }, unavailable ? 2 : c.ms ?? 300);
      }
    }
  };
  emit(plansOf(run));
  if (run.status === "running") return (run._events = out);
  if (run.status === "failed") {
    push("error", run.task === "frontend-smoke"
      ? { title: "timeout", content: "执行超时（任务的 timeout_s = 900s）" }
      : { title: "error", content: "RateLimitError: Error code: 429 - Too Many Requests（重试 6 次后放弃）" }, 800);
    // 任务配了自动重试（与 pipeline._retry_title 一致）
    const retry = tasks.find((x) => x.name === run.task.split(":")[0])?.retry;
    if (run.retry_at && retry) {
      const left = retry.max - run.attempt;
      push("stage", { stage: "retry", title: `第 ${run.attempt} 次执行失败，${retry.delay_s} 秒后自动重试` + (left ? `（之后还能再重试 ${left} 次）` : "（最后一次）") }, 50);
    }
    return (run._events = out);
  }
  if (run.status === "cancelled") {
    // 与后端 submitter.cancel 一致：记一条 error 事件（title=cancelled），运行的 error_code 也是 cancelled
    push("error", { title: "cancelled", content: "被 liyd 取消" }, 500);
    return (run._events = out);
  }
  const answer = run._answer ?? answerOf(run);
  model([], "依据齐了，整理成结论给用户。");      // 不调工具的这次就是最终回答，正文在 final 里
  push("final", { content: answer }, 2000);
  // 回归重放：新会话、不沉淀记忆、不投递
  if (run.trigger.type === "replay") return (run._events = out);
  // 平台的辅助调用（记忆沉淀）也记一条 model_call，标着用途
  if (!legacy) {
    const input = 2400 + Math.round(r() * 1600), output = 140 + Math.round(r() * 320);
    push("model_call", { purpose: "记忆沉淀", model: MODEL, ms: 2200 + Math.round(r() * 3400), input_tokens: input, output_tokens: output, tokens: input + output }, 1200);
  }
  push("stage", { stage: "finalize", title: "沉淀记忆", content: run.task.startsWith("data-qa") ? "事实 1 条（table:dws_account_pnl_daily）" : run.task.startsWith("failure-analysis") ? "教训 1 条 · 交接摘要" : "交接摘要" }, 1500);
  if (tasks.find((x) => x.name === run.task.split(":")[0])?.deliver) push("stage", { stage: "deliver", title: "投递", content: "钉钉 default ✓" }, 400);
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
  const svcProfile = { ...(service?.profile ?? {}), ...(service?.envs[run.env]?.profile ?? {}) };
  // 内建处理器不过模型，不注入档案
  const profile = run.resolution === "builtin" ? "" : [
    service && Object.keys(svcProfile).length ? `[档案——服务 ${service.name}：一手事实，逐字保留，优先级最高]\n` + Object.entries(svcProfile).map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
    ctxLines.length ? `[档案——任务 ${run.task}：一手事实，逐字保留，优先级最高]\n` + ctxLines.map(([k, v]) => `${label(k)}：${v}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  // 召回：该环境的 + 所有环境通用的；教训优先给失败分析
  const recallable = knowledge.filter((k) => k.service === run.service && k.status === "active" && k.kind !== "handoff" && (!k.env || k.env === run.env))
    .sort((a, b) => (run.task.startsWith("failure-analysis") ? Number(b.kind === "lesson") - Number(a.kind === "lesson") : Number(a.kind === "lesson") - Number(b.kind === "lesson")));
  const replay = run.trigger.type === "replay";
  const savedLesson = knowledge.find((k) => k.kind === "lesson" && k.service === run.service && k.task.startsWith("failure-analysis"));
  const savedFact = knowledge.find((k) => k.key === "table:dws_account_pnl_daily");
  // 待办 = 主 agent 最后一次 todo 调用的清单（子代理的不算）
  const lastTodo = [...ev].reverse().find((e) => e.kind === "tool_call" && e.payload.tool === "todo" && !e.payload.agent);
  const todo = lastTodo ? ((lastTodo.payload.args as { items?: TodoItem[] } | undefined)?.items ?? null) : null;
  return {
    ...run,
    progress: progressOf(run),
    output: run._output !== undefined ? run._output
      : final ? { answer: String(final.payload.content) }
        : err ? { error: String(err.payload.content) } : null,
    // 与后端 pipeline.fail 一致：模型 / 工具 / 框架抛的异常都记成 error，取消是 cancelled
    // 续跑成功的运行时间线上还留着上次的出错：只有失败的才有原因码
    error_code: run._error_code ?? (run.status === "cancelled" ? "cancelled" : run.status === "failed" && err ? String(err.payload.title ?? "error") : null),
    context: {
      profile,
      recalled_knowledge: run.resolution === "agent" ? recallable.slice(0, 3).map((k, i) => ({ id: k.id, key: k.key, kind: k.kind, rank: i + 1 })) : [],
      recalled_assets: assetList.filter((a) => a.status === "active" && a.service === run.service && a.task === run.task.split(":")[0]).slice(0, 1).map((a) => ({ id: a.id, kind: a.kind, name: a.name })),
      saved_knowledge: replay || run.status !== "success" || run.resolution !== "agent" ? []
        : run.task.startsWith("data-qa") && savedFact ? [{ id: savedFact.id, key: savedFact.key, kind: "fact" }]
          : run.task.startsWith("failure-analysis") && savedLesson ? [{ id: savedLesson.id, key: savedLesson.key, kind: "lesson" }] : [],
      saved_assets: [],
      session_runs: runs.filter((x) => x.session_id === run.session_id && x.run_id !== run.run_id).slice(0, 6)
        .map((x) => ({ run_id: x.run_id, task: x.task, status: x.status, created_at: x.created_at })),
      todo,
    },
  };
}

/** 执行中的运行：一个跑得久的工具的输出尾部（后端每 3 秒刷一次 runs.progress） */
function progressOf(run: MockRun): Run["progress"] {
  if (run.status !== "running" || tasks.find((t) => t.name === run.task.split(":")[0])?.form === "builtin") return null;
  const ms = Math.max(3000, Math.min(NOW - new Date(run.created_at).getTime() - 20_000, 95_000));
  const at = new Date(NOW - 1500).toISOString();
  if (run.task.startsWith("failure-analysis"))
    return { "bash-1": { tool: "bash", title: `cd ${codeDir(run)} && python -m pytest tests/assets/test_pnl.py -x -q`, ms, at,
      output: "============================= test session starts ==============================\ncollected 42 items\n\ntests/assets/test_pnl.py ........................................" } };
  return { "py-1": { tool: "py", title: "df = pd.read_parquet(path)", ms, at,
    output: "读取 queries/q-1021-0915-a3f2.parquet：482,381 行 × 9 列\n按交易日、账户汇总中…\n已处理 300,000 / 482,381 行" } };
}

function label(k: string): string {
  return ({ conventions: "口径与术语", no_go: "禁区", env_notes: "环境差异", pitfalls: "常见坑", code_refs: "代码位置", upstream: "上游依赖", downstream: "下游影响", runbook: "运维备注" } as Record<string, string>)[k] ?? k;
}

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
  kn(1, "vision-board", "", "data-qa", "metric:account_pnl", "账户收益 = 已实现盈亏 + 浮动盈亏，按交易日汇总，单位元；来自 ClickHouse 的 dws_account_pnl_daily（vision-dagster 产出），报表里是 report/pnl.py 的 account_pnl()。", 46, { code_ref: { path: "report/pnl.py", commit: "e5f6a7b" } }),
  kn(2, "vision-board", "prod", "data-qa", "fact:prod-ck", "国内生产的报表读 CK 172.168.0.125；国内测试读 172.24.17.66。", 12),
  kn(3, "vision-board", "", "data-qa", "table:dws_account_pnl_daily", "dws_account_pnl_daily 一行 = 一个账户一个交易日；trade_date 是交易日（非交易日没有行），pnl 字段单位元。", 48),
  kn(4, "vision-board", "test", "data-qa", "fact:test-data-lag", "国内测试的 CK 数据每天 06:00 从生产同步上一个交易日，盘中查不到当天数据。", 9),
  kn(5, "vision-dagster", "", "failure-analysis", "pattern:upstream-delay", "dws 层资产失败先查上游 dwd_position_daily 当天分区是否物化完成；上游晚于 18:40 完成会级联失败。", 31),
  kn(6, "vision-dagster", "prod", "failure-analysis:dws_account_pnl_daily", "fact:sub-account-mapping", "新开的子账户在 dim_account 里晚一天才有：account_pnl_daily() 汇总前要先 join dim_account，缺的记 warning。", 4, { code_ref: { path: "vision_dagster/assets/pnl.py", commit: "8d02b7f" }, status: "expired" }),
  kn(7, "vision-dagster", "test", "failure-analysis", "fact:test-ck-restart", "国内测试 CK（172.24.17.66）每周一 05:30 重启，周一早上的连接失败大概率是重启窗口。", 14),
  kn(8, "vision-board", "prod", "daily-inspection", "topology:board", "线上 vision-board：nginx → 源码服务，生产 172.24.16.100；报表页缓存 10 分钟，刚更新的数据不会立刻出现。", 0),
  kn(9, "vision-web", "", "ask", "fact:auth-code", "本地应用授权码要手动生成，写进该环境 settings 的 AUTH_APP_CODE；登录走 FreeIPA。", 22),
  kn(10, "vision-board", "prod", "data-qa", "metric:strategy_return", "策略收益率 = 策略下各账户收益之和 / 期初净值；口径在 report/strategy.py 的 strategy_return()。", 24, { feedback_score: -2 }),
  kn(11, "vision-dagster", "prod", "failure-analysis:dws_account_pnl_daily", `session:dagster:dws_account_pnl_daily:DagsterExecutionStepExecutionError:${TD[1]}:summary`, "## 结论\n上游 dwd_position_daily 晚到\n\n## 被否方案\n- 代码回归（近 3 次提交与报错无关）\n\n## 当前约束\n- 不在 py 里手工物化生产资产；要重跑用 dagster 的 reexecute_run\n\n## 未决问题\n- 是否把调度改成依赖上游分区", 3, { kind: "handoff" }),
  kn(12, "vision-board", "", "data-qa", "metric:turnover_v1", "换手率 = 成交额 / 期末持仓市值（2026-08 之前的旧口径）。", 0, { status: "superseded", superseded_by: "metric:turnover" }),
  kn(13, "vision-board", "", "data-qa:account_pnl", "metric:pnl_currency", "跨币种账户的收益先按当日中间价折成人民币再汇总。", 7),
  kn(14, "vision-board", "test", "data-qa", "fact:test-board-host", "国内测试的 vision-board 部署在 172.21.0.45，和 vision-web 的国内测试在同一台。", 3),
  kn(15, "vision-board", "", "data-qa", "metric:turnover", "换手率 = 成交额 / 期初与期末持仓市值的均值；2026-08 之前的报表仍按期末市值算。", 16),
  kn(16, "vision-board", "", "data-qa:account_pnl", "metric:pnl_fee", "账户收益已扣手续费与印花税。", 0, { status: "superseded", superseded_by: "profile:service:vision-board:conventions", source_run: null }),
  // 教训：同类报错再出现时按指纹精确命中
  lesson(17, "vision-dagster", "prod", "failure-analysis", "a3f19c2e5b7d8810", "upstream", "上游 dwd_position_daily 当天分区没物化完导致级联失败：等上游跑完后重跑本资产当日分区",
    "dagster._core.errors.DagsterExecutionStepExecutionError: upstream asset dwd_position_daily partition ? is missing", 11),
  lesson(18, "vision-dagster", "", "failure-analysis", "77be0d41c9a2f063", "code", "成交回报里新加的子账户没有 account_id：先按 sub_account 映射到主账户再汇总",
    "KeyError: '?'", 6, { feedback_score: -1 }),
  lesson(19, "vision-dagster", "test", "failure-analysis", "c0d2e9aa71f4b3e5", "infra", "国内测试 CK 周一 05:30 重启窗口内连接被拒，窗口过后重跑即可",
    "clickhouse_connect.driver.exceptions.OperationalError: Error HTTPConnectionPool(host='?', port=?): Max retries exceeded (Caused by NewConnectionError: Connection refused)", 4),
  lesson(20, "vision-board", "test", "frontend-smoke", "19aa03fe8c6d2b47", "code", "策略周报页的表格改成了 [data-table=strategy]，冒烟脚本里的选择器没同步",
    "Playwright: Timeout ?ms exceeded waiting for selector \"?\"", 3),
  lesson(21, "vision-dagster", "prod", "failure-analysis", "5e8b11c0d4e6a9f2", "infra", "CK 单查询内存超限：全量重算超过 max_memory_usage，改成按交易日分区逐个重算",
    "clickhouse_connect.driver.exceptions.DatabaseError: Code: ?. DB::Exception: Memory limit (for query) exceeded", 0, { status: "expired" }),
];

/** mock 用 30 天命中次数近似"近 30 天被 ≥5 次运行召回" */
export const PROMOTE_MIN_HITS = 20;
export const isPromotable = (k: Knowledge) => k.kind === "fact" && k.status === "active" && k.feedback_score >= 0 && k.hits_30d >= PROMOTE_MIN_HITS;

export const assetList: Asset[] = [
  { id: 1, service: "vision-board", env: "prod", task: "daily-inspection", kind: "procedure", name: "Board 巡检", summary: "8 项检查：报表数据新鲜度、线上报表页、离线导出、主机资源",
    content: "1. db_query：dws_account_pnl_daily / dwd_position_daily / ads_strategy_report / market_kline_1d 的 max(trade_date) 都应是上一个交易日\n2. py requests：report/pnl_daily/、report/positions/、report/strategy_weekly/ 返回 200，耗时 < 基线 2 倍\n3. 离线导出：/report/export/?fmt=html 返回 200\n4. logs app：最近 2000 行没有新的 ERROR（慢查询记一项关注）\n5. host_status：内存 < 85%，根盘 < 80%\n…",
    files: [], source_run: runs[5].run_id, use_count: 38, last_used_at: iso(6 * HOUR), feedback_score: 0, status: "active", updated_at: iso(4 * DAY) },
  { id: 2, service: "vision-board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite", summary: "Playwright 冒烟：登录、账户收益日报、持仓明细、策略周报、离线导出",
    content: "运行：cd <path> && npx playwright test smoke.spec.ts；BASE_URL 取运行环境里的 site 地址",
    files: [{ name: "smoke.spec.ts", size: 5321 }, { name: "playwright.config.ts", size: 612 }, { name: "fixtures/login.json", size: 188 }], source_run: runs[8].run_id, use_count: 22, last_used_at: iso(1 * DAY), feedback_score: 0, status: "active", updated_at: iso(2 * DAY) },
  { id: 3, service: "vision-dagster", env: "prod", task: "failure-analysis", kind: "query", name: "上游分区行数", summary: "查某张表最近 5 个交易日的行数与账户数，判断上游是否完整",
    content: "SELECT trade_date, count() AS n, uniqExact(account_id) AS accounts\nFROM {table}\nWHERE trade_date >= today() - 10\nGROUP BY trade_date ORDER BY trade_date DESC LIMIT 5",
    files: [], source_run: runs[12].run_id, use_count: 17, last_used_at: iso(5 * HOUR), feedback_score: -1, status: "active", updated_at: iso(6 * DAY) },
  { id: 4, service: "vision-board", env: "prod", task: "", kind: "baseline", name: "报表页耗时基线", summary: "近 30 个交易日各报表页的耗时中位数与 P95",
    content: "report/pnl_daily/: 0.8s（P95 1.4s）\nreport/positions/: 1.1s（P95 1.9s）\nreport/strategy_weekly/: 1.5s（P95 2.6s）",
    files: [], source_run: null, use_count: 9, last_used_at: iso(2 * DAY), feedback_score: 0, status: "active", updated_at: iso(10 * DAY) },
  { id: 5, service: "vision-web", env: "prod", task: "ask", kind: "procedure", name: "查策略挂在哪些账户", summary: "用 vision_cfg 的 ORM 只读查询策略、账户、组合之间的关系",
    content: "from vision_cfg.models import Strategy\ns = Strategy.objects.get(code=\"<策略代码>\")\nprint(list(s.accounts.values_list(\"code\", \"name\", \"status\")))\n# 只读：不要 save()，不要调管理命令",
    files: [], source_run: runs[18].run_id, use_count: 11, last_used_at: iso(1 * DAY), feedback_score: 0, status: "active", updated_at: iso(12 * DAY) },
  { id: 6, service: "vision-board", env: "test", task: "frontend-smoke", kind: "script", name: "smoke-suite-v1", summary: "旧版冒烟脚本（已被 smoke-suite 取代）", content: "",
    files: [{ name: "smoke.js", size: 2210 }], source_run: null, use_count: 41, last_used_at: iso(20 * DAY), feedback_score: -1, status: "superseded", updated_at: iso(20 * DAY) },
];

// ———————— 对话 ————————

export function sessionsList(): SessionDetail[] {
  const map = new Map<string, MockRun[]>();
  // 与后端 store/runs.sessions 一致：对话与纠正触发的运行按会话聚合（纠正是同会话的新一轮）；
  // 至少有一轮是对话发起的才算（纠正一次定时运行不会让它出现在对话列表里）
  for (const r of runs) if (r.trigger.type === "chat" || r.trigger.type === "correction") map.set(r.session_id, [...(map.get(r.session_id) ?? []), r]);
  return [...map.entries()].filter(([, rs]) => rs.some((r) => r.trigger.type === "chat")).map(([sid, rs]) => sessionOf(sid, rs))
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
}

/** 与后端 GET /v1/sessions/{id}（runs.of_session）一致：会话里的全部运行，不管是怎么触发的；没有就是 null */
export function sessionDetail(sid: string): SessionDetail | null {
  const rs = runs.filter((r) => r.session_id === sid);
  return rs.length ? sessionOf(sid, rs) : null;
}

function sessionOf(sid: string, rs: MockRun[]): SessionDetail {
  const asc = [...rs].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const turns: ChatTurn[] = asc.map((r) => {
    const d = detailOf(r);
    return { run_id: r.run_id, question: String(r.input.question ?? r.summary), answer: d.output?.answer ?? d.output?.error ?? null, status: r.status, events: eventsOf(r).filter((e) => e.kind !== "final" && e.kind !== "error"), feedback: r.feedback.find((f) => f.step_seq === 0 && f.created_by === "liyd") ?? null, created_at: r.created_at };
  });
  return { session_id: sid, title: asc[0].summary.slice(0, 60), service: asc[asc.length - 1].service, env: asc[asc.length - 1].env, task: asc[asc.length - 1].task, runs: rs.length, last_at: asc[asc.length - 1].created_at, turns };
}

// ———————— 设置（conf/seeds/settings.yaml） ————————

const entry = <T extends object>(section: string, v: T, version: number, by_: string, at: number) =>
  ({ section, ...v, version, updated_by: by_, updated_at: iso(at) });

const rule = (name: string, events: string[], o: { envs?: string[]; triggers?: string[] } = {}) =>
  ({ name, enabled: true, events, services: [], envs: o.envs ?? [], tasks: [], triggers: o.triggers ?? [], channel: "default" });

export const settings = {
  envs: entry("envs", { items: envs, default: "test" }, 2, "liyd", 9 * DAY),
  notifications: entry("notifications", {
    channels: { default: { type: "dingtalk", url: "https://alert-notification.ipa.zs/robot/send", token: "***" } },
    rules: [
      rule("自动运行失败", ["run_failed"], { triggers: ["schedule", "event"] }),
      rule("负反馈", ["feedback_negative"]),
    ],
  }, 1, "seed", 9 * DAY),
  memory: entry("memory", { recall: true, save: true, handoff_summary: true, knowledge_limit: 5, asset_limit: 8 }, 1, "seed", 9 * DAY),
  prompts: promptsEntry,
} as unknown as Settings;

export const apiKeys: ApiKey[] = [
  { id: 1, name: "vision-dagster-sensor", prefix: "ap_N3pZ0c", note: "Dagster run_failure_sensor 回调 POST /v1/events/dagster", created_by: "gaodl", created_at: iso(9 * DAY), expires_at: null, last_used_at: iso(26 * MIN), revoked_at: null },
  { id: 2, name: "gitlab", prefix: "ap_7Hh1Wd", note: "GitLab 部署 Webhook（X-Gitlab-Token）", created_by: "liyd", created_at: iso(9 * DAY), expires_at: null, last_used_at: iso(5 * HOUR), revoked_at: null },
  { id: 3, name: "vision-board-backend", prefix: "ap_x8Kq2m", note: "报表页面里的「问一下」", created_by: "liyd", created_at: iso(8 * DAY), expires_at: null, last_used_at: iso(4 * MIN), revoked_at: null },
  { id: 4, name: "notebook-zhaoq", prefix: "ap_q0LmE4", note: "数据分析 notebook 里用 SDK 调 data-qa", created_by: "zhaoq", created_at: iso(6 * DAY), expires_at: new Date(NOW + 45 * DAY).toISOString(), last_used_at: iso(2 * HOUR), revoked_at: null },
  { id: 5, name: "liyd-console", prefix: "ap_Bx9tYv", note: "控制台登录", created_by: "root", created_at: iso(9 * DAY), expires_at: null, last_used_at: iso(1 * MIN), revoked_at: null },
  { id: 6, name: "old-cli", prefix: "ap_Ze2Rr8", note: "旧 CLI，已停用", created_by: "liyd", created_at: iso(9 * DAY), expires_at: null, last_used_at: iso(8 * DAY), revoked_at: iso(7 * DAY) },
];

export { NOW, MIN, HOUR, DAY, MODEL, TD, SCRATCH, ckOut, iso, hex, pick, between };
