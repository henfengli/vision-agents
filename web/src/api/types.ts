/**
 * /v1 接口契约（前端侧）。与后端 src/agent_platform/api/schemas.py 一一对应：
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

export interface Version {
  version: number;
  updated_by: string;
  created_at: ISODate;
  definition: Record<string, unknown>;
}

export type DefinitionKind = "env" | "service" | "role" | "task" | "policy";

// ———————————————————— 元信息 ————————————————————

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
  events: { name: string; title: string; fields: string[] }[];
}

export interface Meta {
  version: string;
  default_env: string;
  tools: ToolInfo[];
  event_sources: EventSourceInfo[];
  langfuse_url: string | null;
  features: { process_control: "systemd" | "local" | "off"; vector_search: boolean };
}

// ———————————————————— 环境 ————————————————————

export interface Env {
  name: string;          // prod / test / dev
  title: string;
  description: string;
  enabled: boolean;
  protected: boolean;    // 受保护：写操作/进程启停需审批
  color: "red" | "amber" | "blue" | "green" | "violet" | "gray";
  order: number;
  version: number;
}

// ———————————————————— 服务 ————————————————————

export interface ConfigFile {
  canonical: string;     // 服务读的固定路径
  template: string;      // 每环境一份的真实文件（含 {env}）
}

export interface ProcessDef {
  cmd: string[];
  workdir?: string | null;
  ports?: Record<string, number>;
  env_vars?: Record<string, string>;
  lease_hours?: number;  // 默认租约
}

export interface ServiceEnvOverride {
  hosts?: string[];
  readonly_dsn?: string | null;
  code_paths?: string[];
  profile?: Record<string, string>;
}

export interface Service {
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
  version: number;
  updated_by: string;
  updated_at: ISODate;
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
  started_by: string | null;    // 人 / run:<id>
  last_exit: { code: number; at: ISODate } | null;
}

/** 服务列表项：带每个环境的健康汇总 */
export interface ServiceSummary extends Service {
  task_count: number;
  health: Record<string, {
    runs_24h: number;
    failed_24h: number;
    last_run: { run_id: string; status: RunStatus; created_at: ISODate } | null;
    running_processes: number;
    total_processes: number;
  }>;
}

// ———————————————————— 角色 ————————————————————

export interface Role {
  name: string;
  title: string;
  description: string;
  prompt: string;
  tools: string[];
  extends: string | null;
  prompt_append: string;
  version: number;
  updated_by: string;
  updated_at: ISODate;
}

export interface ResolvedRole {
  name: string;
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
    }
  | {
      id: string; type: "event"; enabled?: boolean;
      source: string; event: string;
      filter?: Record<string, string>;      // 字段 → 正则
      map?: Record<string, string>;         // 任务输入字段 → 事件字段
      rules?: TriggerRule[];
      session?: string | null;              // 会话命名模板
    };

export type TriggerType = Trigger["type"];

export interface TaskOutput {
  channel: "caller" | "dingtalk" | "http";
  callback?: string | null;
}

export interface Task {
  name: string;                 // 子任务：父任务:对象名
  title: string;
  description: string;
  service: string | null;       // "board" / "*"（通用）/ null（平台任务）
  role: string | null;
  form: TaskForm;
  input: Record<string, InputField>;
  envs: string[];               // 空 = 全部
  triggers: Trigger[];
  output: TaskOutput;
  dedup: { key: string; window_s: number } | null;
  timeout_s: number;
  enabled: boolean;
  context: Record<string, string>;
  extends: string | null;
  auto_created: boolean;
  graph?: Record<string, GraphNodeDef> | null;
  handler?: string | null;
  version: number;
  updated_by: string;
  updated_at: ISODate;
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
  stats_24h: { runs: number; success: number; failed: number; p50_ms: number | null };
  last_run: { run_id: string; status: RunStatus; created_at: ISODate } | null;
  next_fire: { env: string; at: ISODate } | null;
  subtask_count: number;
}

// ———————————————————— 策略 ————————————————————

export interface Policy {
  name: string;
  description: string;
  order: number;
  applies_to: { tasks: string[]; services: string[]; envs: string[] };
  match_regex: string;
  action: "deny" | "require_approval";
  message: string;
  enabled: boolean;
  version: number;
  updated_by: string;
  updated_at: ISODate;
}

// ———————————————————— 运行 ————————————————————

export type RunStatus =
  | "queued" | "awaiting_approval" | "running" | "success" | "failed" | "cancelled";

export type Resolution = "agent" | "graph" | "builtin" | "rule" | null;

export interface RunTrigger {
  type: TriggerType | "rerun" | "resume" | "correction" | "web";
  id: string | null;           // 触发器 id（schedule/event）
  source: string | null;       // 事件来源
  caller: string;              // 调用身份
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
  pending_approval: Approval | null;
  context: RunContext;
  feedback: { score: number; comment: string; at: ISODate } | null;
  langfuse_url: string | null;
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
    stage?: string;            // prepare/recall/profile/assets/execute/finalize/deliver…
    title?: string;
    content?: string;
    tool?: string;
    args?: unknown;
    output?: string;
    duration_ms?: number;
    tokens?: number;
    model?: string;
    approval_id?: number;
    decision?: "approved" | "rejected";
    node?: string;
    status?: string;
    [k: string]: unknown;
  };
  feedback?: number | null;    // 步骤 👍👎
}

export interface RunRequest {
  task: string;
  service?: string | null;
  env?: string | null;
  subtask?: string | null;
  input: Record<string, unknown>;
  session_id?: string | null;
  caller?: string | null;
}

export interface RunAccepted {
  run_id: string;
  session_id: string;
  status: RunStatus;
  dedup_hit: boolean;
  subtask_created: string | null;
  approval_id: number | null;
}

export interface RunFilters {
  status?: RunStatus | "";
  env?: string;
  service?: string;
  task?: string;
  trigger?: string;
  q?: string;
  hours?: number;
  session?: string;
  cursor?: string;
  limit?: number;
}

// ———————————————————— 对话 ————————————————————

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
  feedback: number | null;
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
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_by: string | null;
  comment: string | null;
  created_at: ISODate;
  decided_at: ISODate | null;
  expires_at: ISODate | null;
}

// ———————————————————— 记忆 ————————————————————

export interface Knowledge {
  id: number;
  service: string;
  env: string;
  task: string;
  key: string;
  content: string;
  source_run: string | null;
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

export interface Asset {
  id: number;
  service: string;
  env: string;
  task: string;
  kind: "procedure" | "script" | "query" | "baseline";
  name: string;
  summary: string;
  content: string;
  files: { name: string; size: number }[];
  source_run: string | null;
  use_count: number;
  last_used_at: ISODate | null;
  feedback_score: number;
  status: "active" | "expired" | "superseded";
  updated_at: ISODate;
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
  upcoming: { task: string; service: string | null; env: string; at: ISODate }[];
  tokens: number;
}

export interface SearchHit {
  type: "service" | "task" | "run" | "role" | "knowledge" | "session";
  id: string;
  title: string;
  subtitle: string;
  href: string;
}
