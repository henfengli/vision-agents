/**
 * 类型化的接口函数 + 查询 hook。页面只从这里取数据，不直接拼 URL。
 * 查询 key 以资源名开头：invalidate("runs") 刷新所有运行相关缓存。
 */
import { del, get, patch, post, put } from "./client";
import type {
  ApiKey, FeedbackEntry, FeedbackFilters, FeedbackInboxItem, FeedbackInput, Asset, ConfigRaw, ConfigSaved, ConfigSection, ConfigSections,
  ConfigVersion, Instance, Knowledge, KnowledgeCreate, KnowledgeFilters, KnowledgePromote, KnowledgePromoted, KnowledgeRevision, MemoryFilters, MemoryHealth, Meta,
  Page, ReplayDetail, ReplayRequest, ReplaySummary, ResolvedRole, Role, Run, RunAccepted, RunEvent, RunFilters, RunListItem, RunRequest, SearchHit, ServiceSummary,
  ServiceTools, ServiceView, SessionDetail, SessionSummary, Settings, Stats, SubtaskCreate, SyncAccepted, SyncRequest, SyncStatus, TaskSummary, UpcomingFire, Version,
  VersionStat,
} from "./types";
import { useQuery, type QueryOptions } from "../lib/query";

const enc = encodeURIComponent;

/** 定义的复数资源名（路径用） */
export type DefinitionPath = "services" | "roles" | "tasks";

/** 有每版运行效果统计的：任务、角色（按名字）与平台提示词 */
export type StatsPath = "tasks" | "roles" | "settings/prompts";

export const api = {
  meta: () => get<Meta>("/v1/meta"),

  // —— 定义（服务 / 角色 / 任务）——
  create: <T>(kind: DefinitionPath, body: object) => post<T>(`/v1/${kind}`, body),
  update: <T>(kind: DefinitionPath, name: string, body: object) => patch<T>(`/v1/${kind}/${enc(name)}`, body),
  remove: (kind: DefinitionPath, name: string) => del<{ deleted: string[] }>(`/v1/${kind}/${enc(name)}`),
  versions: (kind: DefinitionPath | `settings/${ConfigSection}`, name?: string) =>
    get<Version[]>(name ? `/v1/${kind}/${enc(name)}/versions` : `/v1/${kind}/versions`),
  restore: (kind: DefinitionPath | `settings/${ConfigSection}`, name: string | undefined, v: number) =>
    post<unknown>(name ? `/v1/${kind}/${enc(name)}/versions/${v}/restore` : `/v1/${kind}/versions/${v}/restore`),
  /** 每个版本跑出来的效果：/v1/tasks/{name}、/v1/roles/{name}、/v1/settings/prompts 下的 version-stats */
  versionStats: (kind: StatsPath, name?: string) =>
    get<VersionStat[]>(name ? `/v1/${kind}/${enc(name)}/version-stats` : `/v1/${kind}/version-stats`),

  services: () => get<ServiceSummary[]>("/v1/services"),
  service: (name: string) => get<ServiceSummary>(`/v1/services/${enc(name)}`),
  serviceEnv: (name: string, env: string) => get<ServiceView>(`/v1/services/${enc(name)}/envs/${enc(env)}`),
  serviceConfig: (name: string, env: string, path: string) =>
    get<{ path: string; content: string }>(`/v1/services/${enc(name)}/envs/${enc(env)}/config`, { path }),
  // —— 配置文件编辑（原文不打码）：保存带回打开时的 sha，期间被改过返回 409 conflict ——
  configRaw: (name: string, env: string, path: string) =>
    get<ConfigRaw>(`/v1/services/${enc(name)}/envs/${enc(env)}/config`, { path, raw: true }),
  saveConfig: (name: string, env: string, body: { path: string; content: string; sha: string }) =>
    put<ConfigSaved>(`/v1/services/${enc(name)}/envs/${enc(env)}/config`, body),
  /** 已按上游核对过，不用改 */
  ackConfig: (name: string, env: string, path: string) =>
    post<{ ok: true }>(`/v1/services/${enc(name)}/envs/${enc(env)}/config/ack`, { path }),
  configHistory: (name: string, env: string, path: string) =>
    get<ConfigVersion[]>(`/v1/services/${enc(name)}/envs/${enc(env)}/config/history`, { path }),
  configVersion: (name: string, env: string, path: string, id: string) =>
    get<{ id: string; content: string }>(`/v1/services/${enc(name)}/envs/${enc(env)}/config/history/${enc(id)}`, { path }),
  // —— 代码同步 ——
  syncStatus: (name: string, env: string) => get<SyncStatus>(`/v1/services/${enc(name)}/envs/${enc(env)}/sync`),
  /** 立即同步：每个环境提交一次 code-sync；envs 不给 = 服务启用的全部环境；force = 所有同步步骤都重跑 */
  syncNow: (name: string, body: SyncRequest = {}) => post<SyncAccepted[]>(`/v1/services/${enc(name)}/sync`, {
    ...(body.envs?.length ? { envs: body.envs } : {}), ...(body.force ? { force: true } : {}),
  }),
  processes: (name: string) => get<Instance[]>(`/v1/services/${enc(name)}/processes`),
  /** 服务自己声明的 MCP 工具；reload=true 强制重连（改了 MCP 服务端之后） */
  serviceTools: (name: string, reload = false) => get<ServiceTools>(`/v1/services/${enc(name)}/tools`, { reload: reload || undefined }),
  /** 返回动作执行后的实例状态 */
  processAction: (name: string, env: string, proc: string, action: "start" | "stop" | "renew", hours?: number) =>
    post<{ instance: Instance }>(`/v1/services/${enc(name)}/envs/${enc(env)}/processes/${enc(proc)}/${action}`, hours ? { hours } : {}),
  processLogs: (name: string, env: string, proc: string) =>
    get<{ lines: string[] }>(`/v1/services/${enc(name)}/envs/${enc(env)}/processes/${enc(proc)}/logs`),

  roles: () => get<Role[]>("/v1/roles"),
  role: (name: string) => get<Role>(`/v1/roles/${enc(name)}`),
  resolvedRole: (name: string) => get<ResolvedRole>(`/v1/roles/${enc(name)}/resolved`),

  tasks: (service?: string) => get<TaskSummary[]>("/v1/tasks", { service }),
  task: (name: string) => get<TaskSummary>(`/v1/tasks/${enc(name)}`),
  subtasks: (name: string) => get<TaskSummary[]>(`/v1/tasks/${enc(name)}/subtasks`),
  createSubtask: (name: string, body: SubtaskCreate) => post<TaskSummary>(`/v1/tasks/${enc(name)}/subtasks`, body),
  taskSchedule: (name: string) => get<UpcomingFire[]>(`/v1/tasks/${enc(name)}/schedule`),

  // —— 运行 ——
  runs: (f: RunFilters) => get<Page<RunListItem>>("/v1/runs", { ...f }),
  run: (id: string) => get<Run>(`/v1/runs/${enc(id)}`),
  runEvents: (id: string) => get<RunEvent[]>(`/v1/runs/${enc(id)}/events`),
  submitRun: (req: RunRequest) => post<RunAccepted>("/v1/runs", req),
  cancelRun: (id: string) => post<Run>(`/v1/runs/${enc(id)}/cancel`),
  rerun: (id: string) => post<RunAccepted>(`/v1/runs/${enc(id)}/rerun`),
  resume: (id: string) => post<RunAccepted>(`/v1/runs/${enc(id)}/resume`),
  correct: (id: string, text: string) => post<RunAccepted>(`/v1/runs/${enc(id)}/correct`, { text }),

  // —— 反馈：step 为 0 表示整次运行；同一人再提交即覆盖 ——
  rate: (id: string, step: number, body: FeedbackInput) =>
    put<FeedbackEntry>(step ? `/v1/runs/${enc(id)}/events/${step}/feedback` : `/v1/runs/${enc(id)}/feedback`, body),
  unrate: (id: string, step: number) =>
    del(step ? `/v1/runs/${enc(id)}/events/${step}/feedback` : `/v1/runs/${enc(id)}/feedback`),
  feedbackInbox: (f: FeedbackFilters) => get<FeedbackInboxItem[]>("/v1/feedback", { ...f }),

  // —— 回归重放：拿被 👎 的运行用当前定义重跑，模型判定改好没有 ——
  replays: () => get<ReplaySummary[]>("/v1/replays"),
  replay: (id: number) => get<ReplayDetail>(`/v1/replays/${id}`),
  startReplay: (body: ReplayRequest) => post<ReplayDetail>("/v1/replays", body),
  rejudgeReplay: (id: number) => post<ReplayDetail>(`/v1/replays/${id}/judge`),

  // —— 对话 ——
  sessions: (f: { service?: string; env?: string; task?: string; q?: string } = {}) => get<SessionSummary[]>("/v1/sessions", f),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${enc(id)}`),

  // —— 记忆（agent 记下的：事实 / 教训）与方法；档案在服务 / 任务定义里 ——
  knowledge: (f: KnowledgeFilters) => get<Knowledge[]>("/v1/knowledge", { ...f }),
  knowledgeHealth: (f: { service?: string; env?: string }) => get<MemoryHealth>("/v1/knowledge/health", f),
  /** 近 30 天被 ≥5 次运行召回、没挨过 👎 的事实：值得升格进档案 */
  knowledgePromotable: (f: { service?: string; env?: string }) => get<Knowledge[]>("/v1/knowledge/promotable", f),
  knowledgeEntry: (id: number) => get<Knowledge>(`/v1/knowledge/${id}`),
  knowledgeHistory: (id: number) => get<KnowledgeRevision[]>(`/v1/knowledge/${id}/history`),
  createKnowledge: (body: KnowledgeCreate) => post<Knowledge>("/v1/knowledge", body),
  patchKnowledge: (id: number, body: { content?: string; status?: "active" | "expired" }) => patch<Knowledge>(`/v1/knowledge/${id}`, body),
  promoteKnowledge: (id: number, body: KnowledgePromote) => post<KnowledgePromoted>(`/v1/knowledge/${id}/promote`, body),
  searchKnowledge: (body: { query: string; service: string; env: string; task?: string }) =>
    post<{ hits: (Knowledge & { rank: number })[]; block: string }>("/v1/knowledge/search", body),
  assets: (f: MemoryFilters & { kind?: string }) => get<Asset[]>("/v1/assets", { ...f }),
  createAsset: (body: Pick<Asset, "service" | "env" | "task" | "kind" | "name" | "summary" | "content">) => post<Asset>("/v1/assets", body),
  patchAsset: (id: number, body: { summary?: string; content?: string; status?: "active" | "superseded" }) => patch<Asset>(`/v1/assets/${id}`, body),

  // —— 设置 ——
  settings: () => get<Settings>("/v1/settings"),
  putSettings: <S extends ConfigSection>(section: S, body: ConfigSections[S]) => put<Settings[S]>(`/v1/settings/${section}`, body),
  testChannel: (channel: string) => post<{ ok: boolean }>("/v1/settings/notifications/test", { channel }),
  apiKeys: () => get<ApiKey[]>("/v1/api-keys"),
  /** 返回里的 token 只出现这一次 */
  createApiKey: (body: { name: string; note?: string; expires_at?: string | null }) => post<ApiKey & { token: string }>("/v1/api-keys", body),
  patchApiKey: (id: number, body: { note?: string; expires_at?: string | null }) => patch<ApiKey>(`/v1/api-keys/${id}`, body),
  revokeApiKey: (id: number) => del<ApiKey>(`/v1/api-keys/${id}`),

  stats: (q: { hours?: number; env?: string; service?: string }) => get<Stats>("/v1/stats", q),
  search: (q: string) => get<SearchHit[]>("/v1/search", { q }),
  logout: () => del("/auth/session"),
};

// ———————— hooks ————————

export const useMeta = () => useQuery(["meta"], api.meta, { staleTime: 60_000 });
export const useServices = (o?: QueryOptions) => useQuery(["services"], api.services, o);
export const useService = (name: string) => useQuery(["services", name], () => api.service(name));
export const useServiceEnv = (name: string, env: string) => useQuery(["services", name, "env", env], () => api.serviceEnv(name, env), { enabled: !!env });
export const useProcesses = (name: string) => useQuery(["services", name, "processes"], () => api.processes(name), { refetchInterval: 10_000 });
export const useSyncStatus = (name: string, env: string) =>
  useQuery(["services", name, "sync", env], () => api.syncStatus(name, env), { enabled: !!env, refetchInterval: 15_000 });
export const useConfigRaw = (name: string, env: string, path: string) =>
  useQuery(["services", name, "config", env, path], () => api.configRaw(name, env, path), { enabled: !!env && !!path });
export const useConfigHistory = (name: string, env: string, path: string, enabled = true) =>
  useQuery(["services", name, "config-history", env, path], () => api.configHistory(name, env, path), { enabled: enabled && !!env && !!path });
export const useRoles = () => useQuery(["roles"], api.roles);
export const useRole = (name: string) => useQuery(["roles", name], () => api.role(name));
export const useTasks = (service?: string) => useQuery(["tasks", service ?? ""], () => api.tasks(service));
export const useTask = (name: string) => useQuery(["tasks", "one", name], () => api.task(name));
export const useSubtasks = (name: string) => useQuery(["tasks", "subtasks", name], () => api.subtasks(name), { enabled: !!name });
export const useVersions = (kind: DefinitionPath | `settings/${ConfigSection}`, name?: string) =>
  useQuery(["versions", kind, name ?? ""], () => api.versions(kind, name));
export const useVersionStats = (kind: StatsPath, name?: string, enabled = true) =>
  useQuery(["versions", "stats", kind, name ?? ""], () => api.versionStats(kind, name), { enabled, staleTime: 30_000 });
export const useRuns = (f: RunFilters, o?: QueryOptions) => useQuery(["runs", "list", f], () => api.runs(f), { refetchInterval: 8000, ...o });
export const useRun = (id: string, live = false) => useQuery(["runs", "one", id], () => api.run(id), { refetchInterval: live ? 2000 : undefined, live });
export const useRunEvents = (id: string, live = false) => useQuery(["runs", "events", id], () => api.runEvents(id), { refetchInterval: live ? 1500 : undefined, live });
export const useSessions = (f: { service?: string; env?: string; task?: string; q?: string } = {}) => useQuery(["sessions", f], () => api.sessions(f));
export const useSession = (id: string) => useQuery(["sessions", "one", id], () => api.session(id), { enabled: !!id });
export const useServiceTools = (name: string) => useQuery(["services", name, "tools"], () => api.serviceTools(name), { staleTime: 30_000 });
export const useKnowledge = (f: KnowledgeFilters) => useQuery(["memory", "knowledge", f], () => api.knowledge(f));
export const usePromotable = (f: { service?: string; env?: string }) => useQuery(["memory", "promotable", f], () => api.knowledgePromotable(f));
export const useAssets = (f: MemoryFilters & { kind?: string }) => useQuery(["memory", "assets", f], () => api.assets(f));
export const useFeedbackInbox = (f: FeedbackFilters) => useQuery(["feedback", f], () => api.feedbackInbox(f));
export const useReplays = (o?: QueryOptions) => useQuery(["replays", "list"], api.replays, o);
/** 还有没判完的条目时每 5 秒刷新（判定在重放运行结束后异步进行） */
export const useReplay = (id: number, live = false) =>
  useQuery(["replays", "one", id], () => api.replay(id), { enabled: Number.isFinite(id), refetchInterval: live ? 5000 : undefined, live });
export const useSettings = () => useQuery(["settings"], api.settings);
export const useApiKeys = () => useQuery(["settings", "api-keys"], api.apiKeys);
export const useStats = (q: { hours?: number; env?: string; service?: string }) => useQuery(["stats", q], () => api.stats(q), { refetchInterval: 30_000 });

/** 环境列表（来自 meta，到处都要用） */
export function useEnvs() {
  const { data, ...rest } = useMeta();
  return { ...rest, data: data?.envs };
}
