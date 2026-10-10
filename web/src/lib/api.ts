// API 客户端：与后端 /v1 形状一一对应。
// ?demo=1 时整体切到 demo.ts 的内存假数据（预览/教学用，不碰网络）。

export interface RunRow {
  run_id: string; task_type: string; role: string; target_env: string;
  status: string; trigger_source: string; created_at: string;
}

export interface RunEvent {
  seq: number; kind: string; node: string; created_at: string;
  tool?: string; text: string;
}

export interface TraceGraph {
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string }[];
  statuses: Record<string, string>;
  trace?: boolean;
}

export interface RunDetail {
  run: {
    run_id: string; task_type: string; task_version: number | null;
    role: string; role_version: number | null; status: string;
    trigger_source: string; target_env: string;
    duration_ms: number | null; input: unknown; output: unknown;
  };
  created_at: string;
  events: RunEvent[];
  graph: TraceGraph | null;
  pending: { command: string } | null;
  trace: { url: string; embed: boolean; publish: boolean } | null;
}

export interface Meta {
  env: string; target_envs: string[]; domains: string[];
  version: string; langfuse: { enabled: boolean; publish: boolean };
}

export interface Overview {
  by_status: Record<string, number>;
  tasks: { task_type: string; total: number; success: number; failed: number }[];
  failed: { run_id: string; task_type: string; role: string;
            target_env: string; created_at: string }[];
  hours: number;
}

export interface ApprovalItem {
  id: number; run_id: string; command: string; created_at: string;
  task_type: string; trigger_source: string;
}

export interface MemoryEntry {
  id: number; env: string; domain: string; key: string; content: string;
  expired: boolean; superseded: boolean; feedback_score: number;
  [k: string]: unknown;
}

export interface DefinitionRow {
  name: string; version: number; definition: Record<string, unknown>;
  updated_by?: string; created_at?: string;
}

export interface Api {
  meta(): Promise<Meta>;
  overview(): Promise<Overview>;
  runs(env?: string): Promise<RunRow[]>;
  runDetail(runId: string): Promise<RunDetail>;
  rerun(runId: string): Promise<{ run_id: string }>;
  stepFeedback(runId: string, seq: number, score: 1 | -1): Promise<void>;
  runFeedback(runId: string, score: 1 | -1, comment: string): Promise<void>;
  approvals(): Promise<{ count: number; items: ApprovalItem[] }>;
  decide(runId: string, approved: boolean, decidedBy: string): Promise<void>;
  memoryEntries(env?: string, domain?: string,
                includeInactive?: boolean): Promise<MemoryEntry[]>;
  memoryUpdate(id: number, content: string): Promise<void>;
  roles(): Promise<DefinitionRow[]>;
  tasks(): Promise<DefinitionRow[]>;
  policies(): Promise<DefinitionRow[]>;
  history(kind: string, name: string): Promise<DefinitionRow[]>;
  graphTopology(): Promise<TraceGraph>;
  chatStream(body: Record<string, unknown>): Promise<Response>;
}

const TOKEN_KEY = "agent_token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || "";
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class Unauthorized extends Error {}

async function req(path: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${getToken()}`,
      ...(init?.headers || {}),
    },
  });
  if (resp.status === 401) throw new Unauthorized();
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch { /* 非 JSON */ }
    throw new Error(detail);
  }
  return resp;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await req(path, init)).json();
}

export const httpApi: Api = {
  meta: () => json("/v1/console/meta"),
  overview: () => json("/v1/console/overview"),
  runs: (env) => json(`/v1/runs?limit=100${env ? `&env=${env}` : ""}`),
  runDetail: (id) => json(`/v1/console/runs/${id}`),
  rerun: (id) => json(`/v1/console/runs/${id}/rerun`, { method: "POST" }),
  stepFeedback: async (id, seq, score) => {
    await json(`/v1/console/runs/${id}/steps/${seq}/feedback`,
               { method: "POST", body: JSON.stringify({ score }) });
  },
  runFeedback: async (id, score, comment) => {
    await json(`/v1/feedback/${id}`,
               { method: "POST", body: JSON.stringify({ score, comment }) });
  },
  approvals: () => json("/v1/console/approvals"),
  decide: async (runId, approved, decidedBy) => {
    await json(`/v1/approvals/${runId}`,
               { method: "POST",
                 body: JSON.stringify({ approved, decided_by: decidedBy }) });
  },
  memoryEntries: (env, domain, includeInactive) => {
    const q = new URLSearchParams();
    if (env) q.set("env", env);
    if (domain) q.set("domain", domain);
    if (includeInactive) q.set("include_inactive", "true");
    return json(`/v1/console/memory/entries?${q}`);
  },
  memoryUpdate: async (id, content) => {
    await json(`/v1/console/memory/entries/${id}`,
               { method: "POST", body: JSON.stringify({ content }) });
  },
  roles: () => json("/v1/admin/roles"),
  tasks: () => json("/v1/admin/tasks"),
  policies: () => json("/v1/admin/policies"),
  history: (kind, name) => json(`/v1/admin/${kind}s/${name}/history`),
  graphTopology: () => json("/v1/console/graph"),
  chatStream: (body) => req("/v1/chat/stream",
                            { method: "POST", body: JSON.stringify(body) }),
};

// demo 模式：?demo=1 时由 demo.ts 接管（预览/教学用，不碰网络）
import { demoApi, isDemo } from "./demo";
export { isDemo };
export const api: Api = isDemo ? demoApi : httpApi;
