/**
 * 类型化的接口函数 + 查询 hook。页面只从这里取数据，不直接拼 URL。
 * 查询 key 以资源名开头：invalidate("runs") 刷新所有运行相关缓存。
 */
import { del, get, patch, post, put } from "./client";
import type {
  ApiKey, Approval, ApprovalFilters, FeedbackEntry, FeedbackFilters, FeedbackInboxItem, FeedbackInput, Asset, Case, ConfigSection, ConfigSections, Instance, Knowledge,
  KnowledgeRevision, MemoryFilters, MemoryHealth, Meta, Page, Policy, ResolvedRole, Role, Run, RunAccepted, RunEvent,
  RunFilters, RunListItem, RunRequest, SearchHit, ServiceSummary, ServiceView, SessionDetail, SessionSummary, Settings,
  Stats, SubtaskCreate, TaskSummary, UpcomingFire, Version,
} from "./types";
import { useQuery, type QueryOptions } from "../lib/query";

const enc = encodeURIComponent;

/** 定义的复数资源名（路径用） */
export type DefinitionPath = "services" | "roles" | "tasks" | "policies";

export const api = {
  meta: () => get<Meta>("/v1/meta"),

  // —— 定义（服务 / 角色 / 任务 / 策略）——
  create: <T>(kind: DefinitionPath, body: object) => post<T>(`/v1/${kind}`, body),
  update: <T>(kind: DefinitionPath, name: string, body: object) => patch<T>(`/v1/${kind}/${enc(name)}`, body),
  remove: (kind: DefinitionPath, name: string) => del<{ deleted: string[] }>(`/v1/${kind}/${enc(name)}`),
  versions: (kind: DefinitionPath | `settings/${ConfigSection}`, name?: string) =>
    get<Version[]>(name ? `/v1/${kind}/${enc(name)}/versions` : `/v1/${kind}/versions`),
  restore: (kind: DefinitionPath | `settings/${ConfigSection}`, name: string | undefined, v: number) =>
    post<unknown>(name ? `/v1/${kind}/${enc(name)}/versions/${v}/restore` : `/v1/${kind}/versions/${v}/restore`),

  services: () => get<ServiceSummary[]>("/v1/services"),
  service: (name: string) => get<ServiceSummary>(`/v1/services/${enc(name)}`),
  serviceEnv: (name: string, env: string) => get<ServiceView>(`/v1/services/${enc(name)}/envs/${enc(env)}`),
  serviceConfig: (name: string, env: string, path: string) =>
    get<{ path: string; content: string }>(`/v1/services/${enc(name)}/envs/${enc(env)}/config`, { path }),
  processes: (name: string) => get<Instance[]>(`/v1/services/${enc(name)}/processes`),
  processAction: (name: string, env: string, proc: string, action: "start" | "stop" | "renew", hours?: number) =>
    post<{ instance: Instance; approval: Approval | null }>(
      `/v1/services/${enc(name)}/envs/${enc(env)}/processes/${enc(proc)}/${action}`, hours ? { hours } : {}),
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

  policies: () => get<Policy[]>("/v1/policies"),

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

  // —— 对话 ——
  sessions: (f: { service?: string; env?: string; task?: string; q?: string } = {}) => get<SessionSummary[]>("/v1/sessions", f),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${enc(id)}`),

  // —— 审批 ——
  approvals: (f: ApprovalFilters = {}) => get<Approval[]>("/v1/approvals", { ...f }),
  approve: (id: number, comment = "") => post<Approval>(`/v1/approvals/${id}/approve`, { comment }),
  reject: (id: number, comment = "") => post<Approval>(`/v1/approvals/${id}/reject`, { comment }),

  // —— 记忆 ——
  knowledge: (f: MemoryFilters) => get<Knowledge[]>("/v1/knowledge", { ...f }),
  knowledgeHealth: (f: { service?: string; env?: string }) => get<MemoryHealth>("/v1/knowledge/health", f),
  knowledgeHistory: (id: number) => get<KnowledgeRevision[]>(`/v1/knowledge/${id}/history`),
  createKnowledge: (body: { service: string; env: string; task?: string; key: string; content: string }) =>
    post<Knowledge>("/v1/knowledge", body),
  patchKnowledge: (id: number, body: { content?: string; status?: "active" | "expired" }) => patch<Knowledge>(`/v1/knowledge/${id}`, body),
  searchKnowledge: (body: { query: string; service: string; env: string; task?: string }) =>
    post<{ hits: (Knowledge & { rank: number })[]; block: string }>("/v1/knowledge/search", body),
  assets: (f: MemoryFilters & { kind?: string }) => get<Asset[]>("/v1/assets", { ...f }),
  createAsset: (body: Pick<Asset, "service" | "env" | "task" | "kind" | "name" | "summary" | "content">) => post<Asset>("/v1/assets", body),
  patchAsset: (id: number, body: { summary?: string; content?: string; status?: "active" | "superseded" }) => patch<Asset>(`/v1/assets/${id}`, body),
  cases: (f: { service?: string; env?: string }) => get<Case[]>("/v1/cases", f),
  removeCase: (id: number) => del(`/v1/cases/${id}`),

  // —— 设置 ——
  settings: () => get<Settings>("/v1/settings"),
  putSettings: <S extends ConfigSection>(section: S, body: ConfigSections[S]) => put<Settings[S]>(`/v1/settings/${section}`, body),
  testChannel: (channel: string) => post<{ ok: boolean }>("/v1/settings/notifications/test", { channel }),
  apiKeys: () => get<ApiKey[]>("/v1/api-keys"),
  createApiKey: (body: Pick<ApiKey, "name" | "scope" | "services" | "envs" | "note" | "expires_at">) =>
    post<ApiKey & { token: string }>("/v1/api-keys", body),
  patchApiKey: (id: number, body: Partial<Pick<ApiKey, "services" | "envs" | "note" | "expires_at">>) => patch<ApiKey>(`/v1/api-keys/${id}`, body),
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
export const useRoles = () => useQuery(["roles"], api.roles);
export const useRole = (name: string) => useQuery(["roles", name], () => api.role(name));
export const useTasks = (service?: string) => useQuery(["tasks", service ?? ""], () => api.tasks(service));
export const useTask = (name: string) => useQuery(["tasks", "one", name], () => api.task(name));
export const useSubtasks = (name: string) => useQuery(["tasks", "subtasks", name], () => api.subtasks(name), { enabled: !!name });
export const usePolicies = () => useQuery(["policies"], api.policies);
export const useVersions = (kind: DefinitionPath | `settings/${ConfigSection}`, name?: string) =>
  useQuery(["versions", kind, name ?? ""], () => api.versions(kind, name));
export const useRuns = (f: RunFilters, o?: QueryOptions) => useQuery(["runs", "list", f], () => api.runs(f), { refetchInterval: 8000, ...o });
export const useRun = (id: string, live = false) => useQuery(["runs", "one", id], () => api.run(id), { refetchInterval: live ? 2000 : undefined, live });
export const useRunEvents = (id: string, live = false) => useQuery(["runs", "events", id], () => api.runEvents(id), { refetchInterval: live ? 1500 : undefined, live });
export const useSessions = (f: { service?: string; env?: string; task?: string; q?: string } = {}) => useQuery(["sessions", f], () => api.sessions(f));
export const useSession = (id: string) => useQuery(["sessions", "one", id], () => api.session(id), { enabled: !!id });
export const useApprovals = (f: ApprovalFilters = {}) => useQuery(["approvals", f], () => api.approvals(f), { refetchInterval: 10_000 });
export const useKnowledge = (f: MemoryFilters) => useQuery(["memory", "knowledge", f], () => api.knowledge(f));
export const useAssets = (f: MemoryFilters & { kind?: string }) => useQuery(["memory", "assets", f], () => api.assets(f));
export const useCases = (f: { service?: string; env?: string }) => useQuery(["memory", "cases", f], () => api.cases(f));
export const useFeedbackInbox = (f: FeedbackFilters) => useQuery(["feedback", f], () => api.feedbackInbox(f));
export const useSettings = () => useQuery(["settings"], api.settings);
export const useApiKeys = () => useQuery(["settings", "api-keys"], api.apiKeys);
export const useStats = (q: { hours?: number; env?: string; service?: string }) => useQuery(["stats", q], () => api.stats(q), { refetchInterval: 30_000 });

/** 环境列表（来自 meta，到处都要用） */
export function useEnvs() {
  const { data, ...rest } = useMeta();
  return { ...rest, data: data?.envs };
}
