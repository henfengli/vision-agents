/**
 * /v1 接口契约（前端侧）。与后端 api/schemas.py（请求体）、api/views.py（响应）一一对应：
 * 改一边必须改另一边。字段命名与后端 JSON 完全一致（snake_case）。
 */

// ———————————————————— 通用 ————————————————————

export type ISODate = string;

export interface Page<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
  prev_cursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

/** 定义的一个历史版本 */
export interface Version {
  version: number;
  updated_by: string;
  created_at: ISODate;
  deleted?: boolean;
  definition: Record<string, unknown>;
}

/** 有版本台账的对象都带这三个字段 */
export interface Ledger {
  version: number;
  updated_by: string;
  updated_at: ISODate;
}

/** GET …/version-stats：每个版本跑出来的效果（新版本在前；回归重放的运行不算） */
export interface VersionStat {
  version: number;
  runs: number;
  success: number;
  failed: number;
  negative: number;            // 被 👎 过的运行数
  avg_tokens: number | null;
  avg_ms: number | null;
  first_at: ISODate;
  last_at: ISODate;
}

// ———————————————————— 身份 / 元信息 ————————————————————

/** 当前调用方：只有身份，不分权限（有效凭据都能做全部操作） */
export interface Me {
  name: string;
  kind: "key" | "user" | "root" | "system";
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  group: "core" | "service" | "memory" | "notify" | "mcp";
  dangerous: boolean;
  server?: string | null;      // group=mcp：所属的平台 MCP server（角色里可整组写成 "mcp:<server>"）
}

export interface EventSourceInfo {
  name: string;          // dagster / gitlab / webhook
  title: string;
  notes: string;
  events: { name: string; title: string; fields: string[] }[];
}

export interface Meta {
  version: string;
  envs: Env[];
  default_env: string;
  tools: ToolInfo[];
  event_sources: EventSourceInfo[];
  channels: string[];    // 通知渠道名（任务投递、notify 工具可选）
  feedback_reasons: { value: FeedbackReason; label: string }[];
  builtin_handlers: string[];   // 内建任务可选的处理器
  features: { vector_search: boolean };
  me: Me;
}

// ———————————————————— 平台配置（设置 → 平台） ————————————————————

export type EnvColor = "red" | "amber" | "blue" | "green" | "violet" | "gray";

export interface Env {
  name: string;          // prod / test
  title: string;
  description: string;
  /**
   * 受保护（生产）：agent 看不到项目的真实配置，用控制台填的只读版（只读账号），bash 里遮蔽。
   * 不受保护（测试）：直接用项目的真实配置，文件只读，提示词要求库只读。两种都不拦任何操作（没有审批）
   */
  protected: boolean;
  color: EnvColor;
}

export interface EnvsConfig {
  items: Env[];
  default: string;
}

export type NotifyEvent = "run_failed" | "run_succeeded" | "feedback_negative" | "run_queued_long";

export interface Channel {
  type: "dingtalk" | "webhook";
  url: string;
  token: string;         // 回显为 "***"；保存时原样传回表示不改
}

export interface NotifyRule {
  name: string;
  enabled: boolean;
  events: NotifyEvent[];
  services: string[];
  envs: string[];
  tasks: string[];
  triggers: string[];
  channel: string;
}

export interface NotificationsConfig {
  channels: Record<string, Channel>;
  rules: NotifyRule[];
}

export interface MemoryConfig {
  recall: boolean;
  save: boolean;
  handoff_summary: boolean;
  knowledge_limit: number;
  asset_limit: number;
}

/**
 * 平台提示词：所有角色共用的系统提示开头 + 平台自己发起的辅助模型调用。
 * 带占位的几段是 Python str.format 模板：字面花括号写成 {{ }}，保存时服务端校验（422）。
 */
export interface PromptsConfig {
  base: string;              // 每个主 agent 的系统提示开头，后接角色提示词
  subagent: string;          // 每个子代理的系统提示开头
  compaction: string;        // 上下文压缩：{messages}
  distill: string;           // 记忆沉淀：{service} {env} {task} {input} {output}
  handoff_summary: string;   // 交接摘要：{task} {input} {output}
  replay_judge: string;      // 回归判定：{task} {where} {input} {old} {issues} {new}
}

export interface ConfigSections {
  envs: EnvsConfig;
  notifications: NotificationsConfig;
  memory: MemoryConfig;
  prompts: PromptsConfig;
}

export type ConfigSection = keyof ConfigSections;
export type ConfigEntry<S extends ConfigSection> = ConfigSections[S] & { section: S; version: number; updated_by: string; updated_at: ISODate | null };
export type Settings = { [S in ConfigSection]: ConfigEntry<S> };

/** API 密钥只标识身份，不分权限 */
export interface ApiKey {
  id: number;
  name: string;          // 调用方身份：运行记录里的 caller
  prefix: string;
  note: string;
  created_by: string;
  created_at: ISODate;
  expires_at: ISODate | null;
  last_used_at: ISODate | null;
  revoked_at: ISODate | null;
}

// ———————————————————— 服务 ————————————————————
// 同机部署：项目部署在哪台主机上，那台主机上就装着管这个环境的 agent 服务（它的部署配置写 env / services）。
// 运行由它执行，读的是线上那份代码、用的是线上那套解释器；平台不改代码、不装依赖、不启停业务进程。

/**
 * 只读库：{库名: 连接串}。scheme 决定类型（postgresql / postgres、mysql / mariadb、doris、clickhouse / clickhouses、
 * mongodb / mongodb+srv）。口令写 ${VAR} 原样回显；直接写的明文口令回显为 ***，原样传回 *** 表示不改。
 */
export type Databases = Record<string, string>;

/** 按环境覆盖：只写和基座不同的部分 */
export interface ServiceEnvOverride {
  enabled?: boolean;            // false = 该服务在这个环境不接收运行、不起项目内核
  root?: string | null;         // 这个环境的代码目录；不写跟随服务的 root
  databases?: Databases;        // 按库名覆盖服务的 databases；值写空串 = 本环境没有这个库
  code_paths?: string[] | null;
  python?: string | null;       // 该环境的解释器；空 = 跟随服务的 python
  urls?: Record<string, string>;  // 按键覆盖服务的 urls
  logs?: Record<string, string>;  // 按名字覆盖服务的 logs；值写空串 = 本环境没有这个日志
  profile?: Record<string, string>;
  /** 暂停自动触发：定时、事件、上游联动都不建运行（记成 rejected）；API、对话、人点的照常 */
  triggers_paused?: boolean;
}

/** 服务自己的 MCP server 连接配置（langchain-mcp-adapters 形状）；另可写 envs: {环境: 深合并的覆盖} */
export type McpConnection = Record<string, unknown>;

export interface Service extends Ledger {
  name: string;
  title: string;
  description: string;
  root: string;          // 线上的代码目录（可写 {env}、~；~ 是部署用户的 home，平台和项目是同一个用户）
  code_paths: string[];
  python: string;        // 项目解释器（线上用的那个），可写 {env}、~；空 = python3
  env_vars: Record<string, string>;   // 服务级环境变量（可写 {env}）：项目内核带上；不支持 ${VAR}
  /** 有名字的地址（可写 {env}）：线上部署的页面 / API；mcp 配置里用 {url:名字} 引用 */
  urls: Record<string, string>;
  databases: Databases;  // 只读库（db_query 查询）；各环境在 envs[env].databases 里按库名覆盖
  /**
   * 项目读的配置文件路径（绝对路径，可写 ~、{env}）。受保护的环境（生产）：真实内容平台不读不显示，
   * 项目内核里盖上控制台填的只读版；不受保护的环境（测试）：agent 直接用真实配置
   */
  configs: string[];
  /** 代码目录里其他含口令的文件或目录：生产只遮蔽、不替换；测试不遮 */
  hidden: string[];
  /** 日志：{名字: 文件路径（可带 * 通配，取最新的那个）| docker:<容器名> | journal:<systemd 单元>}，可写 {env}、~ */
  logs: Record<string, string>;
  /** 服务自己的 MCP server：{名字: 连接配置}。字符串里可写 {env}、{url:名字}、${VAR}、{platform}、{platform_python} */
  mcp: Record<string, McpConnection>;
  envs: Record<string, ServiceEnvOverride>;
  profile: Record<string, string>;
  enabled: boolean;
}

/** 服务×环境视图里的一个配置文件：给 agent 的只读版填到第几版（只在受保护的环境有版本） */
export interface ConfigFileStatus {
  key: string;                 // 定义里的写法（含 {env}）；内容按它存库
  path: string;                // 渲染后的路径
  version: number | null;      // 受保护的环境：null = 还没填（py 起不来）；不受保护的环境总是 null（用真实配置，不用填）
  updated_by: string | null;
  updated_at: ISODate | null;
}

/**
 * GET /v1/services/{s}/envs/{env}：服务×环境的解析结果 + 给 agent 的配置各是第几版。
 * 代码目录、git 这些只有部署主机上看得到的不在这里（控制台可能由另一台主机回答），agent 运行时用 service_info 看。
 */
export interface ServiceView {
  service: string;
  env: string;
  enabled: boolean;
  protected: boolean;    // 环境受保护（生产）= 要填给 agent 的只读版；否则（测试）直接用项目的真实配置
  triggers_paused: boolean;   // 暂停了自动触发（定时 / 事件 / 上游联动）
  python: string;        // 该环境的解释器（已渲染）
  root: string;
  code_paths: string[];
  urls: Record<string, string>;   // 该环境的地址（已渲染）
  mcp_servers: string[];          // 服务自己声明的 MCP server（运行在本服务上时工具自动出现）
  databases: Databases;           // 本环境的只读库（基座 + 覆盖，去掉空值；口令已打码）
  logs: Record<string, string>;   // 本环境的日志：{名字: 渲染后的路径 | docker:<容器> | journal:<单元>}
  profile: Record<string, string>;
  config_files: ConfigFileStatus[];
}

/** GET …/config?path=&raw=true：给 agent 的只读版原文 + 版本，编辑用。读、存都只在受保护的环境；不受保护的环境返回 409 config_not_used */
export interface ConfigRaw {
  path: string;
  key: string;
  exists: boolean;             // false = 还没填
  content: string;
  version: number | null;
  updated_by: string | null;
  updated_at: ISODate | null;
}

/** GET …/config?path=：密钥打码后的内容（没填时 404） */
export interface ConfigMasked {
  path: string;
  key: string;
  content: string;
}

/** PUT …/config：changed=false 表示内容没变，没有加版本 */
export interface ConfigSaved {
  path: string;
  key: string;
  version: number;
  changed: boolean;
}

/** GET …/config/history：新的在前 */
export interface ConfigVersion {
  version: number;
  updated_by: string;
  updated_at: ISODate;
  size: number;
}

/** GET …/config/history/{version} */
export interface ConfigVersionContent {
  version: number;
  content: string;
  updated_by: string;
  updated_at: ISODate;
}

/** GET /v1/services/{s}/tools：服务自己声明的 MCP 工具（按环境连接） */
export interface ServiceTools {
  servers: string[];
  loaded: boolean;               // 还没连过（没有运行用到）时为 false
  tools: { name: string; description: string; server: string | null; envs: string[] }[];
  failed: string[];              // 连不上的连接名，形如 "vision-dagster.dagster@prod"
}

export interface ServiceEnvHealth {
  enabled: boolean;             // 实际是否接收运行：服务整体启用 且 该环境启用
  env_enabled: boolean;         // 只看该环境自己的开关（envs[env].enabled，默认 true）；服务整体停用时页面据此只说一次"服务已停用"
  triggers_paused: boolean;     // 暂停了自动触发（定时 / 事件 / 上游联动）
  python: string;               // 该环境的解释器
  runs_24h: number;
  failed_24h: number;
  last_run: { run_id: string; status: RunStatus; created_at: ISODate } | null;
}

/** 服务列表项：带每个环境的健康汇总 */
export interface ServiceSummary extends Service {
  task_count: number;           // 本服务专属的任务（不含子任务）
  generic_task_count: number;   // 通用任务（service="*"，调用时指定服务）：每个服务都能用
  health: Record<string, ServiceEnvHealth>;
}

// ———————————————————— 角色 ————————————————————

/**
 * tools 写法：内置工具名 / 平台 MCP 工具名 / "*"（全部内置 + 全部平台 MCP）/ "mcp:<server>"（某个平台 MCP server 的全部工具）。
 * 继承：子角色写了 tools / subagents / service_tools 就整体替换父角色的，没写就跟随；提示词追加 prompt_append。
 */
export interface Role extends Ledger {
  name: string;
  title: string;
  description: string;          // 也是委派时给主角色看的"这个子代理擅长什么"
  prompt: string;
  tools: string[];              // 空 = 跟随父角色
  subagents: string[] | null;   // 可委派的子代理角色名（只委派一层）；null = 跟随父角色，[] = 明确不要
  service_tools: boolean | null;   // 自动带上运行所在服务声明的 MCP 工具；null = 跟随父角色（没有父角色就是 true）
  extends: string | null;
  prompt_append: string;
}

export interface ResolvedRole {
  name: string;
  title: string;
  description: string;
  prompt: string;
  tools: string[];
  subagents: string[];
  service_tools: boolean;
  lineage: string[];
}

// ———————————————————— 任务 ————————————————————

export type TaskForm = "agent" | "builtin";

export interface InputField {
  type: "str" | "text" | "int" | "bool" | "json" | "enum";
  required?: boolean;
  description?: string;
  default?: unknown;
  options?: string[];   // type=enum
}

export interface TriggerRule {
  pattern: string;
  category: string;
  conclusion: string;
  enabled?: boolean;
}

export type Trigger =
  | { id: string; type: "api"; enabled?: boolean }
  | { id: string; type: "chat"; enabled?: boolean }
  | {
      id: string; type: "schedule"; enabled?: boolean;
      cron: string; envs: string[]; input: Record<string, unknown>; timezone?: string;
      service?: string | null;              // 通用任务的定时必须指定服务
    }
  | {
      id: string; type: "event"; enabled?: boolean;
      source: string; event: string;
      filter?: Record<string, string>;      // 字段 → 正则
      map?: Record<string, string>;         // 任务输入字段 → 事件字段
      rules?: TriggerRule[];
      session?: string | null;              // 会话命名模板
      service?: string | null;
    }
  | AfterTrigger;

/**
 * 上游任务结束后：上游（任务或它的子任务）的一次运行落到 on 里的状态时，在同一个环境里跑这个任务。
 * mode=any 任一上游结束就触发；all 每个上游都在 window_s 内（且在这个触发器上一次触发之后）结束过才触发。
 * filter / map 引用上游运行的字段：run_id、task、env、service、status、caller、error、error_code、output.answer、
 * input.<字段>、output.data.<路径>；all 模式可写成「上游任务名.字段」取某一个上游的。不写 map = 上游输入里同名的字段带过来
 */
export interface AfterTrigger {
  id: string; type: "after"; enabled?: boolean;
  tasks: string[];                        // 上游任务名（父任务 = 它和它的子任务；也可以写子任务全名）
  mode: "any" | "all";
  on: ("success" | "failed")[];
  filter?: Record<string, string>;        // 上游字段 → 正则
  map?: Record<string, string>;           // 下游输入字段 → 上游字段
  window_s?: number;                      // all 模式的等待窗口（60 ~ 7 天，默认 1 天）
  service?: string | null;                // 下游是通用任务时固定服务；不写 = 沿用上游运行的服务
}

export type TriggerType = Trigger["type"];

/** 失败自动重试：走续跑，最多 max 次（1~5），每次等 delay_s 秒（10~3600）。只对 agent 任务；只重试临时性失败 */
export interface RetryPolicy {
  max: number;
  delay_s: number;
}

/** 结果投递：二选一；不填 = 只等调用方来取 */
export interface Deliver {
  channel?: string | null;
  url?: string | null;
}

export interface MemoryOverride {
  recall?: boolean | null;   // 空 = 跟随上一级（请求 > 任务 > 平台默认）
  save?: boolean | null;
}

export interface Task extends Ledger {
  name: string;                 // 子任务：父任务:对象名
  title: string;
  description: string;
  service: string | null;       // "vision-board" / "*"（通用）/ null（平台任务）
  role: string | null;
  form: TaskForm;
  input: Record<string, InputField>;
  envs: string[];               // 空 = 全部
  triggers: Trigger[];
  deliver: Deliver | null;
  dedup: { key: string; window_s: number } | null;
  memory: MemoryOverride;
  timeout_s: number;
  enabled: boolean;
  profile: Record<string, string>;
  extends: string | null;
  auto_created: boolean;
  handler?: string | null;      // form=builtin 的处理器名
  /** 结构化输出（JSON Schema，顶层须是 {"type": "object", …}）：声明了就要求 agent 按它交回，放在 output.data */
  output_schema?: Record<string, unknown> | null;
  /** 对象字段：子任务的对象名就是这个输入的值（失败分析的 asset_key）；选了对象自动填上，只给了它就落到对应子任务 */
  object_input?: string | null;
  retry?: RetryPolicy | null;   // 空 = 不自动重试（人去点续跑）
  /** 同一个环境里最多同时执行几个（连同子任务，1~50）；空 = 只受主机的总并发约束 */
  concurrency?: number | null;
}

export interface TaskSummary extends Task {
  overrides: string[];          // 子任务自己写了哪些字段（其余跟随父任务）
  stats_24h: { runs: number; success: number; failed: number; p50_ms: number | null };
  last_run: { run_id: string; status: RunStatus; created_at: ISODate } | null;
  next_fire: { env: string; at: ISODate } | null;
  subtask_count: number;
}

export interface SubtaskCreate {
  object: string;
  title?: string;
  description?: string;
  profile?: Record<string, string>;
  input?: Record<string, InputField>;
  envs?: string[];
  enabled?: boolean;
}

export interface UpcomingFire {
  task: string;
  trigger_id: string;
  service: string | null;
  env: string;
  at: ISODate;
}

/** GET /v1/tasks/_graph：节点是父任务（子任务归在父任务上），边是上游联动（上游结束 → 下游） */
export interface TaskGraphNode {
  name: string;
  title: string;
  service: string | null;
  form: TaskForm;
  enabled: boolean;
  subtask_count: number;
  stats_24h: TaskSummary["stats_24h"];
  last_run: TaskSummary["last_run"];
  next_fire: TaskSummary["next_fire"];
  /** 入口触发（不含联动、不含停用的） */
  entry: { type: "api" | "chat" | "schedule" | "event"; id: string; cron?: string; source?: string; event?: string }[];
}

export interface TaskGraphEdge {
  from: string;
  to: string;
  trigger_id: string;
  mode: "any" | "all";
  on: ("success" | "failed")[];
  enabled: boolean;              // 触发器和下游任务都启用
  from_object: string | null;    // 上游写的是子任务全名时的对象名
  to_object: string | null;      // 触发器写在子任务上时
  upstreams: number;             // 这个触发器一共几个上游（all 模式要攒齐）
}

export interface TaskGraph {
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
}

// ———————————————————— 调度：触发记录 / 执行主机 ————————————————————

export type TickKind = "schedule" | "event" | "after" | "retry";
/** fired 建了运行 / deduped 命中去重（返回已有运行）/ skipped 上一次还没跑完等 / filtered 过滤条件不满足 /
 *  waiting 联动在等其它上游 / rejected 被闸门或校验拒了 / unmatched 事件没有任务接 */
export type TickOutcome = "fired" | "deduped" | "skipped" | "filtered" | "waiting" | "rejected" | "unmatched";

export interface Tick {
  id: number;
  at: ISODate;
  kind: TickKind;
  task: string | null;
  trigger_id: string | null;
  env: string | null;
  source: string | null;         // 事件来源 / 联动的上游运行 / 重试的原运行
  outcome: TickOutcome;
  run_id: string | null;
  reason: string;
  detail: Record<string, unknown> | null;
}

export interface TickFilters {
  task?: string;
  kind?: TickKind | "";
  outcome?: TickOutcome | "";
  env?: string;
  hours?: number;
  before?: number;
  limit?: number;
}

export interface TickPage {
  items: Tick[];
  next_before: number | null;
}

/** 一台执行主机（agent 服务的 worker，每 20 秒报到一次；90 秒没动静算离线） */
export interface Worker {
  worker_id: string;
  host: string;
  env: string;                   // 空 = 开发机，什么都认领
  services: string[];            // 空 = 全部服务
  /** 代管的环境（部署配置 remote_envs）：这台不是它们的部署主机，也执行它们的运行（看不到那边主机上的日志和主机状况） */
  remote_envs: string[];
  version: string;
  max_concurrent: number;
  running: number;
  started_at: ISODate;
  seen_at: ISODate;
  stopped_at: ISODate | null;
  online: boolean;
}

export interface QueueGroup {
  env: string;
  service: string | null;
  queued: number;
  oldest_at: ISODate;
  waiting_upstream: number;      // 其中在等点名的上游
  stuck: number;                 // 其中排队太久告警过的
  served: boolean;               // 有没有在线的主机负责（没有 = 会一直排着）
}

export interface WorkersResponse {
  workers: Worker[];
  queue: { groups: QueueGroup[]; total: number };
  queued_alert_s: number;
}

// ———————————————————— 运行 ————————————————————

export type RunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type Resolution = "agent" | "builtin" | "rule" | null;

export interface RunTrigger {
  type: TriggerType | "web" | "rerun" | "resume" | "correction" | "replay";   // replay = 回归重放产生的运行
  id: string | null;           // 触发器 id（schedule/event/after）；replay 时是被重放的原运行
  source: string | null;       // 事件来源；after = 触发它的上游运行
  caller: string;              // 调用身份：API 密钥名 / 控制台用户 / schedule
}

export interface RunListItem {
  run_id: string;
  session_id: string;
  task: string;
  task_title: string;
  service: string | null;
  env: string;
  role: string | null;
  status: RunStatus;
  resolution: Resolution;
  trigger: RunTrigger;
  summary: string;             // 输入摘要（问题 / 关键字段）
  tokens: number | null;
  duration_ms: number | null;
  created_at: ISODate;
  finished_at: ISODate | null;
  error_code: string | null;
  attempt: number;             // 第几次执行（续跑 / 自动重试 +1）
  retry_at: ISODate | null;    // 失败了、等着自动重试的时刻
  depends_on: string[];        // 点名等的上游运行（都成功了才开始）
}

/** 前后关系里的一条运行（没查到的只有 run_id） */
export interface RunBrief {
  run_id: string;
  status?: RunStatus;
  task?: string;
  task_title?: string;
  env?: string;
  summary?: string;
  retry_at?: ISODate | null;
}

export interface RunLineage {
  triggered_by: RunBrief | null;   // 上游联动：触发它的那次上游运行
  depends_on: RunBrief[];          // 它点名等的运行
  downstream: RunListItem[];       // 它引出的运行（联动触发的 + 点名等它的）
}

/** 排着队的运行在等什么 */
export interface RunQueueState {
  waiting_for: { run_id: string; status: RunStatus; task: string }[];   // 还没成功的点名上游
  concurrency: { limit: number; running: number } | null;               // 任务的并发上限
  hosts: { host: string; running: number; max_concurrent: number }[];   // 在线、负责它的主机
  priority: number;                                                      // 0 对话 / 1 接口 / 2 定时、事件、联动
  since: ISODate;                                                        // 这一次进队列的时刻（续跑、自动重试会重新进）
}

/** 定义的某一版 */
export interface RecipeRef {
  name: string;
  version: number;
}

/** 配方：这次运行用到的每样定义各是第几版，加上模型与平台版本。旧运行没有（null） */
export interface Recipe {
  task: RecipeRef & { parent?: RecipeRef };
  role?: { name: string; lineage: RecipeRef[] };          // 继承链，根在前、自己在后
  subagents?: { name: string; lineage: RecipeRef[] }[];
  service?: RecipeRef;
  prompts?: number;                                       // 平台提示词的版本（设置 → 提示词）
  model: string;
  platform: string;                                       // 平台版本，如 "9.0.0"
}

export interface Run extends RunListItem {
  task_version: number | null;
  role_version: number | null;
  recipe: Recipe | null;
  replay_of: string | null;    // 回归重放出来的运行：指向被重放的原运行
  input: Record<string, unknown>;
  /** 声明了 output_schema 的任务：data 是通过校验的结构化结果；step_limit：模型调用次数到上限、停用工具后给的收尾结论 */
  output: { answer?: string; error?: string; data?: Record<string, unknown>; step_limit?: boolean; [k: string]: unknown } | null;
  memory: MemoryOverride;
  context: RunContext;
  feedback: FeedbackEntry[];   // 所有人对整次（step_seq=0）与各步的评价
  /** 执行中的工具（bash / py 跑得久时每几秒一条输出尾部），工具结束就没了 */
  progress?: Record<string, ToolProgress> | null;
  lineage: RunLineage;
  queue: RunQueueState | null;   // 只有排队中的有
}

export interface ToolProgress {
  tool: string;                // bash / py
  title: string;               // 命令 / 代码第一行
  output: string;              // 输出尾部（最多 2000 字）
  ms: number;                  // 已跑多久
  at: ISODate;
}

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }

export interface RunContext {
  profile: string;                                   // 注入的档案原文
  recalled_knowledge: { id: number; key: string; kind: KnowledgeKind; rank: number }[];
  recalled_assets: { id: number; kind: string; name: string }[];
  saved_knowledge: { id: number; key: string; kind: KnowledgeKind }[];   // 不含交接摘要
  saved_assets: { id: number; kind: string; name: string }[];
  session_runs: { run_id: string; task: string; status: RunStatus; created_at: ISODate }[];
  todo?: TodoItem[] | null;    // 主 agent 最后一次 todo 调用的清单
}

/** model_call 取代了 thought（旧运行里还有 thought，照样显示） */
export type RunEventKind =
  | "stage" | "model_call" | "thought" | "tool_call" | "tool_result" | "final" | "error";

export interface RunEvent {
  seq: number;
  kind: RunEventKind;
  at: ISODate;
  payload: {
    stage?: string;            // profile/recall/system/output/rule/resume/deliver…
    title?: string;
    content?: string;          // model_call：模型的思考过程（Kimi 的 reasoning；没有时为空）
    agent?: string;            // 子代理里发生的（model_call / tool_call / tool_result）
    purpose?: string;          // 平台辅助调用的用途：记忆沉淀 / 交接摘要 / 回归判定
    model?: string | null;
    ms?: number | null;
    queued_ms?: number;        // model_call：ms 里在平台侧等账号并发名额的部分，不到 0.5 秒不记
    input_tokens?: number | null;
    output_tokens?: number | null;
    tool_calls?: string[];
    tool?: string;
    call?: string;             // tool_call / tool_result 配对用（同一次调用相同）；旧事件没有
    args?: unknown;
    output?: string;
    duration_ms?: number;
    tokens?: number | null;
    data?: Record<string, unknown>;   // final：结构化结果
    status?: string;
    [k: string]: unknown;
  };
}

/** POST /v1/runs */
export interface RunRequest {
  task?: string;               // 不填 = 通用入口 ask

  subtask?: string | null;     // 不存在则按父任务自动创建
  service?: string | null;
  env?: string | null;
  input: Record<string, unknown>;
  session_id?: string | null;
  memory?: MemoryOverride;
  wait?: number;               // 同步等待秒数（0–300）
  /** 点名等的上游运行（最多 20 个）：都成功了才开始；有一个失败 / 取消，这次就判失败（upstream_failed） */
  after?: string[];
}

export interface RunAccepted {
  run_id: string;
  session_id: string;
  status: RunStatus;
  output: Run["output"];
  dedup: boolean;              // 命中幂等键或任务去重，返回的是已有运行
  subtask_created: string | null;
}

export interface RunFilters {
  status?: RunStatus | "";
  env?: string;
  service?: string;
  task?: string;
  trigger?: string;
  caller?: string;
  q?: string;
  hours?: number;
  /** 发起时间落在 [since, until) 里（ISO）；概览趋势图点柱子带过来的 */
  since?: string;
  until?: string;
  session_id?: string;
  cursor?: string;
  limit?: number;
}

// ———————————————————— 反馈 ————————————————————

export type FeedbackReason =
  | "wrong_conclusion" | "wrong_definition" | "wrong_data" | "incomplete" | "off_topic"
  | "wrong_tool" | "detour" | "unsafe" | "other";

/** PUT /v1/runs/{id}/feedback 与 /v1/runs/{id}/events/{seq}/feedback 的请求体 */
export interface FeedbackInput {
  score: 1 | -1;
  reasons: FeedbackReason[];
  comment: string;
}

/** 一人一步一条：再提交即覆盖 */
export interface FeedbackEntry extends FeedbackInput {
  id: number;
  run_id: string;
  step_seq: number;            // 0 = 整次运行
  created_by: string;
  created_at: ISODate;
  updated_at: ISODate;
}

/** GET /v1/feedback 的列表项：带上运行的归属 */
export interface FeedbackInboxItem extends FeedbackEntry {
  task: string;
  service: string | null;
  env: string;
  summary: string;
  run_status: RunStatus;
}

export interface FeedbackFilters {
  score?: 1 | -1;
  service?: string;
  env?: string;
  task?: string;
  reason?: string;
  hours?: number;
}

// ———————————————————— 回归重放 ————————————————————
// 改完提示词 / 任务定义 / 档案后，拿被 👎 的运行用当前定义重跑；
// 模型对照"原答案 + 人指出的问题 + 新答案"判定改好没有。

/** fixed 改好了 / same 没改好 / worse 更差 / unclear 判断不了 / error 重放没跑成；null = 还没判 */
export type ReplayVerdict = "fixed" | "same" | "worse" | "unclear" | "error";

/** 发起时的选样条件（原样回显） */
export interface ReplayFilter {
  run_ids?: string[];
  task?: string;
  service?: string;
  env?: string;
  hours?: number;
  /** false = 选最近的 agent 运行（不限 👎），看改动有没有带来退步；不写 = 只选被 👎 的 */
  negative_only?: boolean;
  limit?: number;
}

export interface ReplayCounts {
  total: number;
  fixed: number;
  same: number;
  worse: number;
  unclear: number;             // 含 error
  pending: number;             // 还没判
}

export interface ReplaySummary {
  id: number;
  title: string;
  filter: ReplayFilter;
  note: string;                // 这次改了什么
  created_by: string;
  created_at: ISODate;
  counts: ReplayCounts;
  /** 有没被 👎 的条目：判定读作"有没有退步"（fixed 更好 / same 持平 / worse 退步） */
  regression: boolean;
}

export interface ReplaySide {
  task_version: number | null;
  role_version: number | null;
  recipe: Recipe | null;
  answer: string | null;
}

export interface ReplayItem {
  id: number;
  source_run: string;
  new_run: string | null;      // 没建成（verdict=error）时为空
  verdict: ReplayVerdict | null;
  reason: string;
  judged_at: ISODate | null;
  task: string;
  service: string | null;
  env: string;
  summary: string;
  /** 原运行被 👎 过：判定看"问题改好没有"；否则把原答案当参照看"有没有退步" */
  negative: boolean;
  before: ReplaySide & { status: RunStatus };
  after: ReplaySide & { status: RunStatus | null };
}

export interface ReplayDetail extends ReplaySummary {
  items: ReplayItem[];
}

/** POST /v1/replays：不给 run_ids 就按条件选（默认被 👎 的，negative_only=false 选最近的）agent 运行；
 *  run_ids 可以点名任何结束了的 agent 运行。没有符合条件的返回 400 nothing_to_replay */
export interface ReplayRequest extends ReplayFilter {
  title?: string;
  note?: string;
}

// ———————————————————— 对话 ————————————————————

/** POST /v1/chat */
export interface ChatRequest {
  message: string;
  session_id?: string | null;
  service?: string | null;
  env?: string | null;
  task?: string | null;
  subtask?: string | null;
  input?: Record<string, unknown>;
  memory?: MemoryOverride;
}

export interface SessionSummary {
  session_id: string;
  title: string;
  service: string | null;
  env: string;
  task: string;
  runs: number;
  last_at: ISODate;
}

export interface ChatTurn {
  run_id: string;
  question: string;
  answer: string | null;
  status: RunStatus;
  events: RunEvent[];
  feedback: FeedbackEntry | null;   // 当前用户对这一轮的评价
  created_at: ISODate;
}

export interface SessionDetail extends SessionSummary {
  turns: ChatTurn[];
}

// ———————————————————— 记忆 ————————————————————
// 档案 = 人写的（服务 / 任务定义的 profile，逐字置顶注入）；记忆 = agent 记下的（这一节）；方法 = 可执行的做法与脚本（assets）。

/** fact 事实 / lesson 报错教训 / handoff 交接摘要（会话内部用，列表默认不含） */
export type KnowledgeKind = "fact" | "lesson" | "handoff";

/** 教训的类别 */
export type LessonCategory = "code" | "data" | "infra" | "upstream";

export interface Knowledge {
  id: number;
  service: string;
  env: string;                  // "" = 对该服务所有环境成立
  task: string;
  kind: KnowledgeKind;
  key: string;                  // 教训的键是 lesson:<指纹>
  content: string;
  fingerprint: string | null;   // 教训：报错指纹（同类报错精确命中）
  category: string | null;      // 教训：code / data / infra / upstream
  source_run: string | null;    // 空 = 人工录入
  code_ref: { path: string; commit: string } | null;
  status: "active" | "expired" | "superseded";
  superseded_by: string | null; // 升格进档案后形如 "profile:service:vision-board:conventions"
  feedback_score: number;       // 只罚不奖：≤ 0（被 👎 的运行沉淀或召回过它）
  hits_30d: number;
  last_hit_at: ISODate | null;
  updated_at: ISODate;
}

export interface KnowledgeRevision {
  version: number;
  content: string;
  source: string;
  created_at: ISODate;
}

/** POST /v1/knowledge：人工记一条。lesson 不填 key，按报错原文 error 算指纹 */
export interface KnowledgeCreate {
  service: string;
  env?: string;                 // "" = 所有环境（默认）
  kind: "fact" | "lesson";
  key?: string;                 // fact 必填
  content: string;
  task?: string;
  error?: string;               // lesson 必填：报错原文
  category?: LessonCategory | "";
}

/** POST /v1/knowledge/{id}/promote：升格进档案 */
export interface KnowledgePromote {
  target: "service" | "task";
  key: string;                  // 档案的键：conventions / pitfalls / 自定义
  task?: string;                // target=task 时写进哪个任务；不填用条目的来源任务
  content?: string;             // 写进档案的文字；不填用条目原文
}

export interface KnowledgePromoted {
  entry: Knowledge;             // 原条目，已变成 superseded
  profile: { target: string; key: string };   // target 形如 service:vision-board、service:vision-board@prod、task:data-qa
}

export type AssetKind = "procedure" | "script" | "query" | "baseline";

export interface Asset {
  id: number;
  service: string;
  env: string;
  task: string;                 // 空 = 服务通用
  kind: AssetKind;
  name: string;
  summary: string;
  content: string;
  files: { name: string; size: number }[];
  source_run: string | null;
  use_count: number;
  last_used_at: ISODate | null;
  feedback_score: number;
  status: "active" | "superseded";
  updated_at: ISODate;
}

/** env=X：该环境的 + 所有环境通用的；env="*"：只看通用的 */
export interface MemoryFilters {
  service?: string;
  env?: string;
  task?: string;
  status?: string;
  q?: string;
}

/** 记忆列表的筛选：kind 不给 = 事实与教训（不含交接摘要） */
export interface KnowledgeFilters extends MemoryFilters {
  kind?: KnowledgeKind;
}

// ———————————————————— 统计 / 搜索 ————————————————————

export interface StatsPoint {
  t: ISODate;                   // 这根柱子从什么时候起（第一根是窗口起点）
  end: ISODate;                 // 到什么时候为止（最后一根是「现在」）
  success: number;
  failed: number;
  retrying: number;             // failed 里还等着自动重试的
  active: number;               // 排队中 + 运行中
  cancelled: number;
}

export interface Stats {
  hours: number;
  totals: { runs: number; success: number; failed: number; running: number };
  by_env: Record<string, { runs: number; success: number; failed: number }>;
  /** 趋势图的柱子：按本地钟点对齐（整点 / 偶数点 / 0 点），按发起时间落柱；首尾两根可能不满一格 */
  series: StatsPoint[];
  series_step_s: number;        // 一根柱子跨多少秒（24 小时 3600，3 天 7200）
  top_failures: { task: string; service: string | null; failed: number; last_error: string }[];
  /** 接下来的定时触发（最多 8 条，不含记忆园丁这类内建任务）；task_title 是任务的显示名 */
  upcoming: (UpcomingFire & { task_title: string })[];
  upcoming_total: number;       // 去掉内建任务后的总次数
  tokens: number;
}

export interface SearchHit {
  type: "service" | "task" | "run" | "role" | "knowledge" | "asset" | "session";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}
