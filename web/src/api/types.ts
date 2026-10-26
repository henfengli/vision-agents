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
  features: { process_control: "systemd" | "local" | "off"; vector_search: boolean };
  me: Me;
}

// ———————————————————— 平台配置（设置 → 平台） ————————————————————

export type EnvColor = "red" | "amber" | "blue" | "green" | "violet" | "gray";

export interface Env {
  name: string;          // prod / test / dev
  title: string;
  description: string;
  protected: boolean;    // 受保护：只是标记（控制台上醒目显示），不拦任何操作
  color: EnvColor;
}

export interface EnvsConfig {
  items: Env[];
  default: string;
}

export type NotifyEvent = "run_failed" | "run_succeeded" | "process_stopped" | "feedback_negative" | "config_outdated";

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

export interface ProcessesConfig {
  default_lease_hours: number;
  max_lease_hours: number;
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
  processes: ProcessesConfig;
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

export interface ConfigFile {
  canonical: string;     // 服务读的固定路径（每环境一份代码时也写 {env}）
  template: string;      // 每环境一份的真实文件（含 {env}）
  /** 仓库里和它对应的文件（相对代码目录，如 .env.template）：代码同步发现它变了就标"配置待更新"。空 = 固定路径在代码目录里时就是它自己 */
  upstream?: string | null;
}

/** 同步后的一步：when 里的文件自这一步上次成功以来变了才跑 */
export interface SyncStep {
  title: string;
  when: string[];        // 仓库内路径，支持 ** 通配
  run: string[];         // argv，可写 {python}（该环境的解释器）与 {env}
  shared: boolean;       // 用同一个解释器的环境共享效果（装依赖）：别的环境对同样的文件内容做过就跳过
  timeout_s: number;
}

/** 代码同步：跟踪的分支是服务的 ref（各环境可覆盖） */
export interface SyncDef {
  auto: boolean;         // 代码跟踪：定时看远端，有新提交就同步
  steps: SyncStep[];     // 不写 = 装依赖两步（requirements.txt / pyproject.toml）
}

export interface ProcessDef {
  cmd: string[];
  workdir?: string | null;
  ports?: Record<string, number>;   // 环境 → 端口
  env_vars?: Record<string, string>;
  lease_hours?: number | null;      // 空 = 平台默认
}

/**
 * 只读库：{库名: 连接串}。scheme 决定类型（postgresql / postgres、mysql / mariadb、doris、clickhouse / clickhouses、
 * mongodb / mongodb+srv）。口令写 ${VAR} 原样回显；直接写的明文口令回显为 ***，原样传回 *** 表示不改。
 */
export type Databases = Record<string, string>;

export interface ServiceEnvOverride {
  enabled?: boolean;     // false = 该服务在这个环境不接收运行、不起进程和内核
  ref?: string | null;          // 该环境跟踪的分支 / tag（代码同步的默认目标）
  python?: string | null;       // 该环境的解释器；空 = 跟随服务的 python
  hosts?: string[] | null;
  databases?: Databases;        // 按库名覆盖服务的 databases；值写空串 = 本环境没有这个库
  code_paths?: string[] | null;
  urls?: Record<string, string>;  // 按键覆盖服务的 urls
  profile?: Record<string, string>;
}

/** 服务自己的 MCP server 连接配置（langchain-mcp-adapters 形状）；另可写 envs: {环境: 深合并的覆盖} */
export type McpConnection = Record<string, unknown>;

export interface Service extends Ledger {
  name: string;
  title: string;
  description: string;
  root: string;          // 可含 {env}：每个环境一份代码
  code_paths: string[];
  repo: string;          // git 远端：代码同步从这里拉
  ref: string;           // 默认跟踪的分支
  python: string;        // 项目解释器，可含 {env}，~ 开头 = 平台用户的 home（如 ~/miniforge3/envs/vision-board/bin/python）；空 = python3
  env_vars: Record<string, string>;   // 服务级环境变量（可写 {env}）：项目内核与进程都带上；不支持 ${VAR}
  /** 有名字的地址：可写 {env} 与 {port:进程名}（如 local: "http://127.0.0.1:{port:server}"）；mcp 配置里用 {url:名字} 引用 */
  urls: Record<string, string>;
  hosts: string[];
  databases: Databases;  // 只读库（db_query 查询）；各环境在 envs[env].databases 里按库名覆盖
  configs: ConfigFile[];
  processes: Record<string, ProcessDef>;
  sync: SyncDef;
  /** 服务自己的 MCP server：{名字: 连接配置}。字符串里可写 {env}、{url:名字}、${VAR}、{platform}、{platform_python} */
  mcp: Record<string, McpConnection>;
  envs: Record<string, ServiceEnvOverride>;
  profile: Record<string, string>;
  enabled: boolean;
}

/** 服务×环境视图：基座 + 环境覆盖 + 渲染后的配置文件路径 */
export interface ServiceView {
  service: string;
  env: string;
  enabled: boolean;
  python: string;        // 该环境的解释器（已渲染 {env}，空则 python3）
  root: string;
  code_paths: string[];
  repo: string;
  ref: string;           // 该环境跟踪的分支（已合并基座）
  urls: Record<string, string>;   // 该环境的地址（已渲染 {env} / {port:进程名}）
  mcp_servers: string[];          // 服务自己声明的 MCP server（运行在本服务上时工具自动出现）
  hosts: string[];
  databases: Databases;           // 本环境的只读库（基座 + 覆盖，去掉空值；口令已打码）
  config_files: { canonical: string; path: string; upstream: string; exists: boolean; size: number | null }[];   // upstream 可能为空
  profile: Record<string, string>;
  git: { branch: string; commit: string; dirty: boolean; committed_at: ISODate } | null;
}

/** 配置文件的上游状态：仓库里的 upstream 自上次核对以来变了 = pending */
export interface ConfigUpstream {
  path: string;
  canonical: string;
  upstream: string;
  pending: boolean;
  diff?: string;               // 上游自上次核对以来的 unified diff
  since?: ISODate | null;      // 上次核对的时间
}

/** GET /v1/services/{s}/envs/{env}/sync */
export interface SyncStatus {
  service: string;
  env: string;
  enabled: boolean;
  auto: boolean;
  repo: string;
  dir: string;
  branch: string;
  head: { commit: string; short: string; subject: string; author: string; committed_at: ISODate } | null;   // 还没克隆时为空
  remote: { commit: string; checked_at: ISODate } | null;    // 代码跟踪最近一次看远端
  behind: boolean;
  steps: {
    title: string;
    when: string[];
    shared: boolean;
    pending: boolean;          // when 里的文件自上次成功以来变了：下次同步会跑
    last: { ok: boolean; at: ISODate; run_id: string | null; env: string; code: number; message: string } | null;
  }[];
  configs: ConfigUpstream[];
}

/** POST /v1/services/{s}/sync 的请求体 */
export interface SyncRequest {
  envs?: string[];       // 不填 = 服务启用的全部环境
  force?: boolean;       // 所有同步步骤都重跑（不管依赖文件变没变；重建了 conda 环境之后用）
}

/** POST /v1/services/{s}/sync 的每一项：一个环境提交一次 code-sync */
export interface SyncAccepted {
  env: string;
  run_id: string | null;
  status: string;
  error: { code: string; message: string } | null;
}

/** GET …/config?path=&raw=true：原文（不打码）+ sha，编辑用 */
export interface ConfigRaw {
  path: string;
  canonical: string;
  upstream: string | null;
  exists: boolean;
  content: string;
  sha: string;                 // 保存时带回；文件不存在为空串
  upstream_state: ConfigUpstream | null;
}

/** PUT …/config */
export interface ConfigSaved {
  path: string;
  sha: string;
  backup: string | null;       // 旧内容的备份 id；新建文件为空
  running: string[];           // 本环境在跑的进程：重启后才读到新配置
}

/** 配置文件的一份备份：replaced_by 在 at 保存之前的内容 */
export interface ConfigVersion {
  id: string;
  at: ISODate;
  replaced_by: string;
  size: number;
}

/** GET /v1/services/{s}/tools：服务自己声明的 MCP 工具（按环境连接） */
export interface ServiceTools {
  servers: string[];
  loaded: boolean;               // 还没连过（没有运行用到）时为 false
  tools: { name: string; description: string; server: string | null; envs: string[] }[];
  failed: string[];              // 连不上的连接名，形如 "vision-dagster.dagster@prod"
}

export type InstanceState = "stopped" | "starting" | "running" | "stopping" | "failed";

export interface Instance {
  service: string;
  env: string;
  process: string;
  state: InstanceState;
  port: number | null;
  pid: number | null;
  started_at: ISODate | null;
  lease_until: ISODate | null;
  started_by: string | null;    // 人 / run:<id> / lease
  last_exit: { code: number | null; at: ISODate } | null;
  enabled: boolean;             // 服务在该环境是否启用（停用的环境不能起进程）
}

export interface ServiceEnvHealth {
  enabled: boolean;
  python: string;               // 该环境的解释器
  runs_24h: number;
  failed_24h: number;
  last_run: { run_id: string; status: RunStatus; created_at: ISODate } | null;
  running_processes: number;
  total_processes: number;
}

/** 服务列表项：带每个环境的健康汇总 */
export interface ServiceSummary extends Service {
  task_count: number;
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
    };

export type TriggerType = Trigger["type"];

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

// ———————————————————— 运行 ————————————————————

export type RunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

export type Resolution = "agent" | "builtin" | "rule" | null;

export interface RunTrigger {
  type: TriggerType | "web" | "rerun" | "resume" | "correction" | "replay" | "watch";   // replay = 回归重放产生的运行；watch = 代码跟踪发现远端有新提交
  id: string | null;           // 触发器 id（schedule/event）；replay 时是被重放的原运行
  source: string | null;       // 事件来源
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
  /** 声明了 output_schema 的任务：data 是通过校验的结构化结果 */
  output: { answer?: string; error?: string; data?: Record<string, unknown>; [k: string]: unknown } | null;
  error_code: string | null;
  memory: MemoryOverride;
  context: RunContext;
  feedback: FeedbackEntry[];   // 所有人对整次（step_seq=0）与各步的评价
}

export interface RunContext {
  profile: string;                                   // 注入的档案原文
  recalled_knowledge: { id: number; key: string; kind: KnowledgeKind; rank: number }[];
  recalled_assets: { id: number; kind: string; name: string }[];
  saved_knowledge: { id: number; key: string; kind: KnowledgeKind }[];   // 不含交接摘要
  saved_assets: { id: number; kind: string; name: string }[];
  session_runs: { run_id: string; task: string; status: RunStatus; created_at: ISODate }[];
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
  before: ReplaySide & { status: RunStatus };
  after: ReplaySide & { status: RunStatus | null };
}

export interface ReplayDetail extends ReplaySummary {
  items: ReplayItem[];
}

/** POST /v1/replays：不给 run_ids 就按条件选被 👎 的 agent 运行；没有符合条件的返回 400 nothing_to_replay */
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

export interface MemoryHealth {
  active: number;
  zero_recall: number;
  negative: number;
  drifted: number;
  conflicts: number;
  lessons: number;              // 生效中的教训数
  promotable: number;           // 可升格进档案的事实数
}

// ———————————————————— 统计 / 搜索 ————————————————————

export interface Stats {
  hours: number;
  totals: { runs: number; success: number; failed: number; running: number };
  by_env: Record<string, { runs: number; success: number; failed: number }>;
  series: { t: ISODate; success: number; failed: number; other: number }[];
  top_failures: { task: string; service: string | null; failed: number; last_error: string }[];
  upcoming: UpcomingFire[];
  tokens: number;
}

export interface SearchHit {
  type: "service" | "task" | "run" | "role" | "knowledge" | "session";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}
