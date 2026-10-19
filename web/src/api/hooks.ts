/**
 * 类型化的接口函数 + 查询 hook。页面只从这里取数据，不直接拼 URL。
 * 查询 key 以资源名开头：invalidate("runs") 刷新所有运行相关缓存。
 */
import { del, get, post, put } from "./client";
import type {
  Approval, Asset, Case, Env, Instance, Knowledge, KnowledgeRevision, MemoryHealth, Meta, Page, Policy,
  ResolvedRole, Role, Run, RunAccepted, RunEvent, RunFilters, RunListItem, RunRequest, SearchHit,
  ServiceSummary, ServiceView, SessionDetail, SessionSummary, Stats, Task, TaskSummary, Version,
} from "./types";
import { useQuery, type QueryOptions } from "../lib/query";

const enc = encodeURIComponent;

export const api = {
  meta: () => get<Meta>("/v1/meta"),
  envs: () => get<Env[]>("/v1/envs"),
  putEnv: (name: string, body: Partial<Env>) => put<Env>(`/v1/envs/${enc(name)}`, body),

  services: () => get<ServiceSummary[]>("/v1/services"),
  service: (name: string) => get<ServiceSummary>(`/v1/services/${enc(name)}`),
  createService: (body: Partial<ServiceSummary>) => post<ServiceSummary>("/v1/services", body),
  putService: (name: string, body: Partial<ServiceSummary>) => put<ServiceSummary>(`/v1/services/${enc(name)}`, body),
  serviceView: (name: string, env: string) => get<ServiceView>(`/v1/services/${enc(name)}/view`, { env }),
  serviceConfig: (name: string, env: string, path: string) => get<{ path: string; content: string }>(`/v1/services/${enc(name)}/configs`, { env, path }),
  instances: (name: string) => get<Instance[]>(`/v1/services/${enc(name)}/instances`),
  instanceAction: (name: string, env: string, proc: string, action: "start" | "stop" | "renew") =>
    post<{ instance: Instance; approval: Approval | null }>(`/v1/services/${enc(name)}/instances/${enc(env)}/${enc(proc)}/${action}`),
  instanceLogs: (name: string, env: string, proc: string) => get<{ lines: string[] }>(`/v1/services/${enc(name)}/instances/${enc(env)}/${enc(proc)}/logs`),

  roles: () => get<Role[]>("/v1/roles"),
  role: (name: string) => get<Role>(`/v1/roles/${enc(name)}`),
  resolvedRole: (name: string) => get<ResolvedRole>(`/v1/roles/${enc(name)}/resolved`),
  createRole: (body: Partial<Role>) => post<Role>("/v1/roles", body),
  putRole: (name: string, body: Partial<Role>) => put<Role>(`/v1/roles/${enc(name)}`, body),

  tasks: (service?: string) => get<TaskSummary[]>("/v1/tasks", { service }),
  task: (name: string) => get<TaskSummary>(`/v1/tasks/${enc(name)}`),
  createTask: (body: Partial<Task>) => post<TaskSummary>("/v1/tasks", body),
  putTask: (name: string, body: Partial<Task>) => put<TaskSummary>(`/v1/tasks/${enc(name)}`, body),

  policies: () => get<Policy[]>("/v1/policies"),
  createPolicy: (body: Partial<Policy>) => post<Policy>("/v1/policies", body),
  putPolicy: (name: string, body: Partial<Policy>) => put<Policy>(`/v1/policies/${enc(name)}`, body),

  versions: (kind: string, name: string) => get<Version[]>(`/v1/${kind}/${enc(name)}/versions`),
  restoreVersion: (kind: string, name: string, v: number) => post<unknown>(`/v1/${kind}/${enc(name)}/versions/${v}/restore`),

  runs: (f: RunFilters) => get<Page<RunListItem>>("/v1/runs", { ...f }),
  run: (id: string) => get<Run>(`/v1/runs/${enc(id)}`),
  runEvents: (id: string) => get<RunEvent[]>(`/v1/runs/${enc(id)}/events`),
  submitRun: (req: RunRequest) => post<RunAccepted>("/v1/runs", req),
  cancelRun: (id: string) => post<Run>(`/v1/runs/${enc(id)}/cancel`),
  rerun: (id: string) => post<RunAccepted>(`/v1/runs/${enc(id)}/rerun`),
  runFeedback: (id: string, score: number, comment = "") => post(`/v1/runs/${enc(id)}/feedback`, { score, comment }),
  stepFeedback: (id: string, seq: number, score: number) => post(`/v1/runs/${enc(id)}/steps/${seq}/feedback`, { score }),

  sessions: () => get<SessionSummary[]>("/v1/sessions"),
  session: (id: string) => get<SessionDetail>(`/v1/sessions/${enc(id)}`),

  approvals: (status: "pending" | "decided" | "" = "") => get<Approval[]>("/v1/approvals", { status }),
  decide: (id: number, approve: boolean, comment = "") => post<Approval>(`/v1/approvals/${id}/decision`, { approve, comment }),

  knowledge: (q: { service?: string; env?: string; status?: string; q?: string }) => get<Knowledge[]>("/v1/knowledge", q),
  knowledgeHealth: (q: { service?: string; env?: string }) => get<MemoryHealth>("/v1/knowledge/health", q),
  knowledgeHistory: (id: number) => get<KnowledgeRevision[]>(`/v1/knowledge/${id}/history`),
  putKnowledge: (id: number, body: Partial<Knowledge>) => put<Knowledge>(`/v1/knowledge/${id}`, body),
  searchKnowledge: (body: { query: string; service?: string; env?: string; task?: string }) =>
    post<{ hits: (Knowledge & { rank: number })[]; block: string }>("/v1/knowledge/search", body),
  cases: (q: { service?: string; env?: string }) => get<Case[]>("/v1/cases", q),
  assets: (q: { service?: string; env?: string; kind?: string }) => get<Asset[]>("/v1/assets", q),

  stats: (q: { hours?: number; env?: string; service?: string }) => get<Stats>("/v1/stats", q),
  search: (q: string) => get<SearchHit[]>("/v1/search", { q }),
  logout: () => del("/auth/session"),
};

// ———————— hooks ————————

export const useMeta = () => useQuery(["meta"], api.meta, { staleTime: 60_000 });
export const useEnvs = () => useQuery(["envs"], api.envs, { staleTime: 30_000 });
export const useServices = (o?: QueryOptions) => useQuery(["services"], api.services, o);
export const useService = (name: string) => useQuery(["services", name], () => api.service(name));
export const useServiceView = (name: string, env: string) => useQuery(["services", name, "view", env], () => api.serviceView(name, env), { enabled: !!env });
export const useInstances = (name: string) => useQuery(["services", name, "instances"], () => api.instances(name), { refetchInterval: 10_000 });
export const useRoles = () => useQuery(["roles"], api.roles);
export const useRole = (name: string) => useQuery(["roles", name], () => api.role(name));
export const useTasks = (service?: string) => useQuery(["tasks", service ?? ""], () => api.tasks(service));
export const useTask = (name: string) => useQuery(["tasks", "one", name], () => api.task(name));
export const usePolicies = () => useQuery(["policies"], api.policies);
export const useVersions = (kind: string, name: string) => useQuery(["versions", kind, name], () => api.versions(kind, name));
export const useRuns = (f: RunFilters, o?: QueryOptions) => useQuery(["runs", "list", f], () => api.runs(f), { refetchInterval: 8000, ...o });
export const useRun = (id: string, live = false) => useQuery(["runs", "one", id], () => api.run(id), { refetchInterval: live ? 2000 : undefined });
export const useRunEvents = (id: string, live = false) => useQuery(["runs", "events", id], () => api.runEvents(id), { refetchInterval: live ? 1500 : undefined });
export const useSessions = () => useQuery(["sessions"], api.sessions);
export const useSession = (id: string) => useQuery(["sessions", id], () => api.session(id), { enabled: !!id });
export const useApprovals = (status: "pending" | "decided" | "" = "") => useQuery(["approvals", status], () => api.approvals(status), { refetchInterval: 10_000 });
export const useStats = (q: { hours?: number; env?: string; service?: string }) => useQuery(["stats", q], () => api.stats(q), { refetchInterval: 30_000 });
