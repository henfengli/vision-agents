// Demo 数据：?demo=1 时的内存假后端。用途：静态预览/学习 React 时离线可点。
// 形状与 api.ts 的 Api 接口严格一致——它是接口的第二种实现，不是另一套数据。

import type {
  Api, ApprovalItem, DefinitionRow, MemoryEntry, Meta, Overview,
  RunDetail, RunRow, TraceGraph,
} from "./api";

export const isDemo =
  new URLSearchParams(window.location.search).get("demo") === "1";

const NOW = Date.now();
const ago = (min: number) =>
  new Date(NOW - min * 60000).toISOString().replace("T", " ").slice(0, 19);

export const DEMO_RUN = "7f3a9c2e1b4d4e8fa6c05d2b9e81734a";
const APPR_RUN = "9b1c4d7e2f5a4c8ba3d6e0f1a9b2c5d7";

const RUNS: RunRow[] = [
  { run_id: DEMO_RUN, task_type: "data-qa", role: "data_searcher",
    target_env: "prod", status: "success", trigger_source: "web_chat",
    created_at: ago(12) },
  { run_id: APPR_RUN, task_type: "failure-analysis", role: "ops_analyst",
    target_env: "prod", status: "running", trigger_source: "sensor",
    created_at: ago(6) },
  { run_id: "a1b2c3d4e5f6478899aabbccddee0111", task_type: "failure-analysis",
    role: "ops_analyst", target_env: "prod", status: "failed",
    trigger_source: "sensor", created_at: ago(50) },
  { run_id: "a1b2c3d4e5f6478899aabbccddee0333", task_type: "data-qa",
    role: "data_searcher", target_env: "prod", status: "success",
    trigger_source: "sdk", created_at: ago(95) },
  { run_id: "a1b2c3d4e5f6478899aabbccddee0444", task_type: "daily-inspection",
    role: "ops_analyst", target_env: "prod", status: "success",
    trigger_source: "schedule", created_at: ago(400) },
];

const DEMO_EVENTS = [
  { seq: 1, kind: "thought", node: "model", created_at: ago(12),
    text: "收到问题：华东大区上季度毛利率。先查知识库有无现成口径，没有再读代码、查只读库。" },
  { seq: 2, kind: "tool_call", node: "tools", tool: "knowledge_lookup",
    created_at: ago(11),
    text: '{"env": "prod", "domain": "board", "key": "毛利率"}' },
  { seq: 3, kind: "tool_result", node: "tools", tool: "knowledge_lookup",
    created_at: ago(11), text: "未命中（feedback_score 阈值过滤后无结果），转代码检索。" },
  { seq: 4, kind: "tool_call", node: "tools", tool: "grep",
    created_at: ago(10),
    text: '{"pattern": "gross_margin", "path": "domains/board/mart"}' },
  { seq: 5, kind: "tool_result", node: "tools", tool: "grep",
    created_at: ago(10),
    text: "fct_order_daily.sql:42 → gross_margin = 1 - cost / gmv  -- 剔除内部交易单" },
  { seq: 6, kind: "tool_call", node: "tools", tool: "sql_query",
    created_at: ago(9),
    text: '{"sql": "SELECT round(100.0*(1-sum(cost)/sum(gmv)),1) AS margin FROM fct_order_daily WHERE region=\'华东\' AND dt>=\'2026-04-01\' AND dt<\'2026-07-01\' LIMIT 100"}' },
  { seq: 7, kind: "tool_result", node: "tools", tool: "sql_query",
    created_at: ago(9), text: "margin = 31.4  (1 row, 2.3s)" },
  { seq: 8, kind: "llm", node: "model", created_at: ago(8),
    text: "结论：2026 Q2 华东大区毛利率 31.4%。口径 = 1 - 营业成本÷GMV（剔除内部交易），定义见 mart/fct_order_daily.sql:42；已写回知识库备查。" },
];

function graphOf(events: typeof DEMO_EVENTS, status: string): TraceGraph {
  const nodes = [{ id: "start", label: "开始" }];
  const edges: { source: string; target: string }[] = [];
  let prev = "start";
  for (const e of events) {
    if (e.kind !== "tool_call") continue;
    const id = `seq-${e.seq}`;
    nodes.push({ id, label: e.tool! });
    edges.push({ source: prev, target: id });
    prev = id;
  }
  const last = events[events.length - 1];
  nodes.push({ id: `seq-${last.seq}`, label: "结论" });
  edges.push({ source: prev, target: `seq-${last.seq}` });
  prev = `seq-${last.seq}`;
  const statuses: Record<string, string> = {};
  for (const n of nodes) statuses[n.id] = "executed";
  if (status === "running") statuses[prev] = "active";
  if (status === "failed") statuses[prev] = "failed";
  return { nodes, edges, statuses, trace: true };
}

function detailOf(row: RunRow): RunDetail {
  const isAppr = row.run_id === APPR_RUN;
  return {
    run: {
      run_id: row.run_id, task_type: row.task_type, task_version: 3,
      role: row.role, role_version: 2, status: row.status,
      trigger_source: row.trigger_source, target_env: row.target_env,
      duration_ms: row.status === "running" ? null : 96700,
      input: { question: "上季度华东大区毛利率是多少？口径怎么算？" },
      output: row.status === "success"
        ? { answer: "2026 Q2 华东大区毛利率 31.4%。口径：1 - 营业成本 ÷ GMV，剔除内部交易；定义见 mart/fct_order_daily.sql:42。" }
        : null,
    },
    created_at: row.created_at,
    events: DEMO_EVENTS,
    graph: graphOf(DEMO_EVENTS, row.status),
    pending: isAppr
      ? { command: "kubectl rollout restart deployment/board-web" }
      : null,
    trace: null, // demo：无 Langfuse，展示自研轨迹图 + 时间线
  };
}

export const demoApi: Api = {
  meta: async (): Promise<Meta> => ({
    env: "prod", target_envs: ["prod", "test"],
    domains: ["board", "dagster", "config-center"], version: "5.0.0-demo",
    langfuse: { enabled: false, publish: true },
  }),
  overview: async (): Promise<Overview> => ({
    by_status: { success: 41, failed: 3, running: 1, queued: 0 },
    tasks: [
      { task_type: "data-qa", total: 18, success: 17, failed: 1 },
      { task_type: "failure-analysis", total: 12, success: 10, failed: 2 },
      { task_type: "daily-inspection", total: 8, success: 8, failed: 0 },
    ],
    failed: [
      { run_id: "a1b2c3d4e5f6478899aabbccddee0111",
        task_type: "failure-analysis", role: "ops_analyst",
        target_env: "prod", created_at: ago(50) },
    ],
    hours: 24,
  }),
  runs: async () => RUNS,
  runDetail: async (id) => {
    const row = RUNS.find((r) => r.run_id === id) || RUNS[0];
    return detailOf({ ...row, run_id: id });
  },
  rerun: async (id) => ({ run_id: id }),
  stepFeedback: async () => {},
  runFeedback: async () => {},
  approvals: async (): Promise<{ count: number; items: ApprovalItem[] }> => ({
    count: 1,
    items: [{
      id: 7, run_id: APPR_RUN,
      command: "kubectl rollout restart deployment/board-web",
      created_at: ago(6), task_type: "failure-analysis",
      trigger_source: "sensor",
    }],
  }),
  decide: async () => {},
  memoryEntries: async (): Promise<MemoryEntry[]> => [
    { id: 3, env: "prod", domain: "board", key: "毛利率口径",
      content: "gross_margin = 1 - cost/gmv，剔除内部交易；定义见 mart/fct_order_daily.sql:42",
      expired: false, superseded: false, feedback_score: 5 },
    { id: 2, env: "prod", domain: "dagster", key: "connection refused",
      content: "连接失败先查服务存活与端口，再查防火墙。",
      expired: false, superseded: false, feedback_score: 2 },
    { id: 1, env: "prod", domain: "board", key: "毛利率口径（旧）",
      content: "gross_margin = (gmv - cost)/gmv（未剔除内部交易，已废弃）",
      expired: false, superseded: true, feedback_score: -1 },
  ],
  memoryUpdate: async () => {},
  roles: async (): Promise<DefinitionRow[]> => [
    { name: "data_searcher", version: 2, updated_by: "admin",
      definition: { description: "数据口径问答", domains: ["board"],
                    tools: ["knowledge_lookup", "grep", "sql_query"],
                    prompt: "你是数据分析师……" } },
    { name: "ops_analyst", version: 4, updated_by: "admin",
      definition: { description: "故障分析", domains: ["dagster"],
                    tools: ["bash", "grep", "host_metrics"],
                    prompt: "你是运维专家……" } },
  ],
  tasks: async (): Promise<DefinitionRow[]> => [
    { name: "data-qa", version: 3,
      definition: { role: "data_searcher", timeout_s: 300,
                    input_schema: { question: "str" } } },
    { name: "failure-analysis", version: 5,
      definition: { role: "ops_analyst", timeout_s: 600,
                    env_gate: ["prod", "test"] } },
  ],
  policies: async (): Promise<DefinitionRow[]> => [
    { name: "prod-write-gate", version: 2,
      definition: { match: { target_env: "prod" },
                    action: "require_approval" } },
  ],
  history: async () => [],
  graphTopology: async () => graphOf(DEMO_EVENTS, "success"),
  chatStream: async () => new Response(
    `data: {"type":"run","run_id":"${DEMO_RUN}","session_id":"demo-session"}\n\n` +
    `data: {"type":"thought","content":"先查知识库。"}\n\n` +
    `data: {"type":"tool_call","tool":"knowledge_lookup","args":"{\\"key\\":\\"毛利率\\"}"}\n\n` +
    `data: {"type":"tool_result","tool":"knowledge_lookup","output":"命中：fct_order_daily.sql:42"}\n\n` +
    `data: {"type":"final","output":{"answer":"2026 Q2 华东大区毛利率 31.4%。（demo 数据）"}}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }),
};
