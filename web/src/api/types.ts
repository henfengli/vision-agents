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

// ———————————————————— 身份 / 元信息 ————————————————————

export interface Me {
  name: string;
  kind: "key" | "user" | "root" | "system";
  admin: boolean;
  services: string[];
  envs: string[];
}

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  group: "core" | "service" | "memory" | "notify" | "mcp";
  dangerous: boolean;
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
  protected: boolean;    // 受保护：危险命令、进程启停、命中审批策略的提交都要人放行
  color: EnvColor;
}

export interface EnvsConfig {
  items: Env[];
  default: string;
}

export interface ApprovalsConfig {
  danger_patterns: string[];
  required_in: "protected" | "all";
  timeout_minutes: number;
}

export type NotifyEvent = "run_failed" | "run_succeeded" | "approval_requested" | "process_stopped" | "feedback_negative";

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

export interface ConfigSections {
  envs: EnvsConfig;
  approvals: ApprovalsConfig;
  notifications: NotificationsConfig;
  memory: MemoryConfig;
  processes: ProcessesConfig;
}

export type ConfigSection = keyof ConfigSections;
export type ConfigEntry<S extends ConfigSection> = ConfigSections[S] & { section: S; version: number; updated_by: string; updated_at: ISODate | null };
export type Settings = { [S in ConfigSection]: ConfigEntry<S> };

export interface ApiKey {
  id: number;
  name: string;          // 调用方身份：运行记录里的 caller
  prefix: string;
  scope: "run" | "admin";
  services: string[];    // 空 = 不限
  envs: string[];
  note: string;
  created_by: string;
  created_at: ISODate;
  expires_at: ISODate | null;
  last_used_at: ISODate | null;
  revoked_at: ISODate | null;
}

// ———————————————————— 服务 ————————————————————

export interface ConfigFile {
  canonical: string;     // 服务读的固定路径
  template: string;      // 每环境一份的真实文件（含 {env}）
}

export interface ProcessDef {
  cmd: string[];
  workdir?: string | null;
  ports?: Record<string, number>;   // 环境 → 端口
  env_vars?: Record<string, string>;
  lease_hours?: number | null;      // 空 = 平台默认
}

export interface ServiceEnvOverride {
  enabled?: boolean;     // false = 该服务在这个环境不接收运行、不起进程
  hosts?: string[] | null;
  readonly_dsn?: string | null;
  code_paths?: string[] | null;
  profile?: Record<string, string>;
}

export interface Service extends Ledger {
  name: string;
  title: string;
  description: string;
  root: string;
  code_paths: string[];
  hosts: string[];
  readonly_dsn: string | null;
  configs: ConfigFile[];
  processes: Record<string, ProcessDef>;
  envs: Record<string, ServiceEnvOverride>;
  profile: Record<string, string>;
  enabled: boolean;
}

/** 服务×环境视图：基座 + 环境覆盖 + 渲染后的配置文件路径 */
export interface ServiceView {
  service: string;
  env: string;
  root: string;
  code_paths: string[];
  hosts: string[];
  readonly_dsn: string | null;
  config_files: { canonical: string; path: string; exists: boolean; size: number | null }[];
  profile: Record<string, string>;
  git: { branch: string; commit: string; dirty: boolean; committed_at: ISODate } | null;
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
}

export interface ServiceEnvHealth {
  enabled: boolean;
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

export interface Role extends Ledger {
  name: string;
  title: string;
  description: string;
  prompt: string;
  tools: string[];
  extends: string | null;
  prompt_append: string;
}

export interface ResolvedRole {
  name: string;
  title: string;
  description: string;
  prompt: string;
  tools: string[];
  lineage: string[];
}

// ———————————————————— 任务 ————————————————————

export type TaskForm = "agent" | "graph" | "builtin";

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
  service: string | null;       // "board" / "*"（通用）/ null（平台任务）
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
  graph?: Record<string, GraphNodeDef> | null;
  handler?: string | null;
}

export interface GraphNodeDef {
  deps?: string[];
  code?: string;
  agent?: { role: string; contract?: string };
  route?: { by?: string; choices: string[] };
  map?: string;
  gate?: { when: string };
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

// ———————————————————— 策略 ————————————————————

export interface Policy extends Ledger {
  name: string;
  description: string;
  order: number;
  applies_to: { tasks: string[]; services: string[]; envs: string[] };
  match_regex: string;
  action: "deny" | "require_approval";
  message: string;
  enabled: boolean;
}

// ———————————————————— 运行 ————————————————————

export type RunStatus =
  | "queued" | "awaiting_approval" | "running" | "success" | "failed" | "cancelled";

export type Resolution = "agent" | "graph" | "builtin" | "rule" | null;

export interface RunTrigger {
  type: TriggerType | "web" | "rerun" | "resume" | "correction";
  id: string | null;           // 触发器 id（schedule/event）
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

export interface Run extends RunListItem {
  task_version: number | null;
  role_version: number | null;
  input: Record<string, unknown>;
  output: { answer?: string; error?: string; [k: string]: unknown } | null;
  error_code: string | null;
  memory: MemoryOverride;
  pending_approval: Approval | null;
  context: RunContext;
  feedback: FeedbackEntry[];   // 所有人对整次（step_seq=0）与各步的评价
}

export interface RunContext {
  profile: string;                                   // 注入的档案原文
  recalled_knowledge: { id: number; key: string; rank: number }[];
  recalled_assets: { id: number; kind: string; name: string }[];
  saved_knowledge: { id: number; key: string }[];
  saved_assets: { id: number; kind: string; name: string }[];
  session_runs: { run_id: string; task: string; status: RunStatus; created_at: ISODate }[];
  graph: { nodes: GraphNodeState[]; edges: { from: string; to: string }[] } | null;
}

export interface GraphNodeState {
  id: string;
  kind: "code" | "agent" | "route" | "map";
  status: "pending" | "running" | "materialized" | "reused" | "skipped" | "rejected" | "failed";
  summary?: string;
}

export type RunEventKind =
  | "stage" | "thought" | "tool_call" | "tool_result" | "approval" | "artifact" | "final" | "error";

export interface RunEvent {
  seq: number;
  kind: RunEventKind;
  at: ISODate;
  payload: {
    stage?: string;            // profile/recall/assets/graph/rule/resume/deliver…
    title?: string;
    content?: string;
    tool?: string;
    args?: unknown;
    output?: string;
    duration_ms?: number;
    tokens?: number;
    approval_id?: number;
    decision?: "approved" | "rejected";
    node?: string;
    status?: string;
    [k: string]: unknown;
  };
}

/** POST /v1/runs */
export interface RunRequest {
  task: string;
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
  approval_id: number | null;
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

// ———————————————————— 审批 ————————————————————

export type ApprovalKind = "submit" | "command" | "artifact" | "process";

export interface Approval {
  id: number;
  kind: ApprovalKind;
  run_id: string | null;
  title: string;
  detail: string;               // 命令 / 摘要
  service: string | null;
  env: string | null;
  task: string | null;
  payload: Record<string, unknown>;
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_by: string | null;
  comment: string | null;
  created_at: ISODate;
  decided_at: ISODate | null;
  expires_at: ISODate | null;
}

export interface ApprovalFilters {
  status?: "pending" | "decided" | "";
  kind?: ApprovalKind | "";
  service?: string;
  env?: string;
}

// ———————————————————— 记忆 ————————————————————

export interface Knowledge {
  id: number;
  service: string;
  env: string;
  task: string;
  key: string;
  content: string;
  source_run: string | null;    // 空 = 人工录入
  code_ref: { path: string; commit: string } | null;
  status: "active" | "expired" | "superseded";
  feedback_score: number;
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

export interface Case {
  id: number;
  service: string | null;
  env: string;
  fingerprint: string;
  category: string;
  conclusion: string;
  source_run: string | null;
  thumbs_up: number;
  thumbs_down: number;
  status: "active" | "superseded";
  updated_at: ISODate;
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

export interface MemoryFilters {
  service?: string;
  env?: string;
  task?: string;
  status?: string;
  q?: string;
}

export interface MemoryHealth {
  active: number;
  zero_recall: number;
  negative: number;
  drifted: number;
  conflicts: number;
}

// ———————————————————— 统计 / 搜索 ————————————————————

export interface Stats {
  hours: number;
  totals: { runs: number; success: number; failed: number; running: number; awaiting: number };
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
