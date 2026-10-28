/**
 * 工具调用的展示（运行详情的时间线、对话的过程）：参数一行摘要、参数详情、结果。
 * db_query（旧运行是 sql_query）单独排版：查询放代码块并标出库名；结果解析出 类型 · 库 · 行列数 · 耗时，
 * 大结果写进了工作目录的文件时给出可复制的路径，预览表格按表格显示。
 * logs 的结果第一行是 "[<文件或 docker:容器>] 最后 N 行…"，拆出来作标题。todo 的参数按清单显示。
 */
import { useState } from "react";
import { LuDatabase, LuFileText, LuScrollText } from "react-icons/lu";

import type { TodoItem } from "@/api/types";
import { cn } from "@/lib/cn";
import { num } from "@/lib/format";
import { CodeBlock, CopyButton, JsonView, Markdown } from "./ui/data";
import { Badge } from "./ui/primitives";

/** 查库工具：db_query(query, db)；旧运行里是 sql_query(sql) */
export const isDbTool = (tool: unknown) => tool === "db_query" || tool === "sql_query";

type Args = Record<string, unknown>;
const asArgs = (args: unknown): Args | null => (args && typeof args === "object" && !Array.isArray(args) ? (args as Args) : null);

/** 查库的语句：db_query 的 query（SQL，或 MongoDB 的 JSON），sql_query 的 sql */
function dbQueryOf(a: Args): { text: string; db: string; mongo: boolean } {
  const raw = a.query ?? a.sql ?? "";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const mongo = /^\s*[{[]/.test(text);
  let pretty = text;
  if (mongo) { try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 原样 */ } }
  return { text: pretty, db: typeof a.db === "string" ? a.db : "", mongo };
}

/** logs(name, lines, grep, since)：哪个日志 · 最后多少行 · 过滤 */
function logsSummary(a: Args): string {
  if (!a.name) return "列出可读的日志";
  return [String(a.name), `最后 ${a.lines ?? 200} 行`, a.grep ? `grep ${String(a.grep)}` : "", a.since ? `since ${String(a.since)}` : ""].filter(Boolean).join(" · ");
}

/** 时间线标题里的一行参数摘要 */
export function summarizeArgs(args: unknown, tool?: string): string {
  if (tool === "submit_result") return "交回结构化结果";
  const a = asArgs(args);
  if (!a) return args ? String(args) : "";
  if (isDbTool(tool)) {
    const q = dbQueryOf(a);
    return (q.db ? `${q.db} · ` : "") + q.text.replace(/\s+/g, " ").slice(0, 90);
  }
  if (tool === "logs") return logsSummary(a);
  if (tool === "host_status") return "负载、内存、磁盘、进程、容器";
  if (tool === "read") return `${String(a.path ?? "")}${Number(a.offset) > 1 ? ` · 从第 ${a.offset} 行` : ""}`;
  if (tool === "grep") return `${String(a.pattern ?? "")}${a.path ? ` · ${String(a.path)}` : ""}${a.glob ? ` · ${String(a.glob)}` : ""}`;
  if (tool === "todo") {
    const items = todoItems(a.items);
    return `待办 ${items.filter((i) => i.status === "completed").length}/${items.length}` + (items.find((i) => i.status === "in_progress") ? ` · 正在：${items.find((i) => i.status === "in_progress")!.content}` : "");
  }
  const v = a.subagent ? `${a.subagent}：${a.description ?? ""}` : a.command ?? a.code ?? a.what ?? Object.values(a)[0];
  return v ? (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, 90) : "";
}

export function todoItems(raw: unknown): TodoItem[] {
  return Array.isArray(raw) ? raw.filter((x): x is TodoItem => !!x && typeof x === "object" && typeof (x as TodoItem).content === "string"
    && typeof ((x as TodoItem).status ?? "pending") === "string") : [];
}

const TODO_MARK: Record<TodoItem["status"], { icon: string; cls: string; label: string }> = {
  pending: { icon: "○", cls: "text-fg-3", label: "待做" },
  in_progress: { icon: "◐", cls: "text-info", label: "进行中" },
  completed: { icon: "✓", cls: "text-ok", label: "已完成" },
  cancelled: { icon: "×", cls: "text-fg-3", label: "已取消" },
};

/** 待办清单（todo 工具的参数；运行详情侧栏也用） */
export function TodoList({ items, className }: { items: TodoItem[]; className?: string }) {
  return (
    <ul className={cn("space-y-1 text-[12.5px]", className)}>
      {items.map((it, i) => {
        const m = TODO_MARK[it.status] ?? TODO_MARK.pending;
        return (
          <li key={i} className="flex items-start gap-2">
            <span className={cn("mt-px w-3 shrink-0 text-center text-[11px]", m.cls)} aria-hidden>{m.icon}</span>
            <span className="sr-only">{m.label}：</span>
            <span className={cn("min-w-0 flex-1", it.status === "completed" ? "text-fg-3" : it.status === "in_progress" ? "font-medium text-fg" : "text-fg-2", it.status === "cancelled" && "line-through")}>
              {it.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ToolArgs({ tool, args }: { tool?: string; args: unknown }) {
  const a = asArgs(args);
  if (a && tool === "todo") {
    const items = todoItems(a.items);
    if (items.length) return <div className="rounded-md border border-line bg-sunken px-3 py-2.5"><TodoList items={items} /></div>;
  }
  if (a) {
    if (isDbTool(tool)) {
      const q = dbQueryOf(a);
      const title = (
        <span className="flex items-center gap-1.5">
          <LuDatabase className="size-3.5" />{q.mongo ? "MongoDB 查询" : "SQL"}
          <span>· 库 {q.db ? <code className="font-mono text-fg-2">{q.db}</code> : <span>（唯一配置的库）</span>}</span>
        </span>
      );
      return <CodeBlock title={title} code={q.text} maxHeight={260} />;
    }
    if (a.subagent && typeof a.description === "string") return <CodeBlock title={`委派给子代理 ${a.subagent}`} code={a.description} wrap maxHeight={220} />;
    const main = a.command ?? a.code;
    if (typeof main === "string") {
      const rest = Object.fromEntries(Object.entries(a).filter(([k]) => k !== "command" && k !== "code"));
      const extra = Object.keys(rest).length ? " · " + Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : "";
      return <CodeBlock title={(a.command ? "命令" : "代码") + extra} code={main} maxHeight={260} />;
    }
  }
  return <JsonView value={args} maxHeight={200} />;
}

// ———————— db_query 的结果 ————————

export interface DbResult {
  label: string;               // ClickHouse / PostgreSQL / …
  db: string;
  rows: number;
  cols: number | null;         // MongoDB 没有列数
  ms: number;
  note: string;                // 没取全的原因、账号限制说明
  file: string | null;         // 全部结果写在哪
  format: string;              // UTF-8 CSV，首行是列名 / JSONL，一行一个文档
  body: string;                // 预览（表格或 JSON 行）
}

const HEAD = /^\[([^\]]+?) · ([^\]]+)\] (\d+) 行(?: × (\d+) 列)?，(\d+) ms(.*)$/;
/** logs 的第一行（与 services/hostlocal.read_log 一致）：[target] 最后 N 行 / [target] 整个文件里匹配 'x' 的共 M 行… */
const LOG_HEAD = /^\[([^\]\n]+)\] ([^\n]*?(?:最后 \d+ 行|里匹配)[^\n]*)/;
const FILE = /^全部结果在 (.+?)（([^）]+)）：/;

/** 解析 db_query 的输出；不是这个格式（报错、旧运行）返回 null */
export function parseDbResult(output: string): DbResult | null {
  const lines = output.split("\n");
  const m = HEAD.exec(lines[0] ?? "");
  if (!m) return null;
  let rest = lines.slice(1);
  const f = FILE.exec(rest[0] ?? "");
  if (f) rest = rest.slice(1);
  return {
    label: m[1], db: m[2], rows: Number(m[3]), cols: m[4] ? Number(m[4]) : null, ms: Number(m[5]),
    note: m[6].replace(/^；/, "").trim(), file: f?.[1] ?? null, format: f?.[2] ?? "", body: rest.join("\n").trim(),
  };
}

function DbOutput({ r, raw }: { r: DbResult; raw: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const table = r.body.startsWith("|");
  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5 text-[11.5px] text-fg-3">
        <Badge tone="info" icon={<LuDatabase />}>{r.label}</Badge>
        <span>库 <code className="font-mono text-fg-2">{r.db}</code></span>
        <span className="tabular-nums text-fg-2">{num(r.rows)} 行{r.cols !== null && ` × ${r.cols} 列`}</span>
        <span className="tabular-nums">{num(r.ms)} ms</span>
        {r.note && <span className="text-warn">{r.note}</span>}
        <button type="button" onClick={() => setShowRaw(!showRaw)} className="ml-auto rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg">{showRaw ? "看预览" : "看原文"}</button>
      </div>
      {r.file && (
        <div className="flex min-w-0 items-center gap-1.5 border-b border-line bg-panel/60 px-3 py-1.5 text-[12px]">
          <LuFileText className="size-3.5 shrink-0 text-fg-3" />
          <span className="shrink-0 text-fg-3">全部结果</span>
          <code className="min-w-0 truncate font-mono text-[11.5px] text-fg" title={r.file}>{r.file}</code>
          <CopyButton text={r.file} label="复制路径" className="shrink-0" />
          {r.format && <span className="hidden shrink-0 text-[11px] text-fg-3 sm:inline">{r.format}</span>}
          {r.rows > 20 && <span className="ml-auto shrink-0 text-[11px] text-fg-3">下面是前 20 行</span>}
        </div>
      )}
      {showRaw ? <pre className="max-h-[300px] overflow-auto whitespace-pre px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg">{raw}</pre>
        : !r.body ? <div className="px-3 py-2.5 text-[12px] text-fg-3">没有返回行</div>
          : table ? (
            <div className="max-h-[300px] overflow-auto px-3 py-2.5 [&_td]:whitespace-nowrap [&_td]:font-mono [&_td]:text-[11.5px] [&_th]:whitespace-nowrap [&_th]:text-[11.5px]">
              <Markdown text={r.body} />
            </div>
          ) : <pre className="max-h-[300px] overflow-auto whitespace-pre px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg">{r.body}</pre>}
    </div>
  );
}

/** 工具返回的文本：[拒绝] / [失败] 这类前缀的按出错着色 */
export function ToolOutput({ tool, output, className }: { tool?: string; output: string; className?: string }) {
  if (isDbTool(tool)) {
    const r = parseDbResult(output);
    if (r) return <div className={className}><DbOutput r={r} raw={output} /></div>;
  }
  const failed = /^\[(拒绝|失败|超时|查询出错|不可用|未配置|参数|无服务|无数据|不符合要求|未执行|不存在|没有权限|读取失败|工具出错|看不到|已取消|重复调用|超出范围|内核出错|内核无响应|内核已退出)\]/.test(output);
  // logs 的输出第一行是 "[<文件或 docker:容器>] 最后 N 行…" / "…整个文件里匹配 …"：拆成标题，正文按日志排版
  const head = !failed && tool === "logs" ? LOG_HEAD.exec(output) : null;
  if (head) {
    const body = output.slice(head[0].length).replace(/^\n/, "");
    return (
      <CodeBlock title={<span className="flex min-w-0 items-center gap-1.5"><LuScrollText className="size-3.5 shrink-0" /><code className="truncate font-mono text-fg-2">{head[1]}</code><span className="shrink-0">{head[2]}</span></span>}
        code={body} maxHeight={320} className={className} />
    );
  }
  return (
    <CodeBlock title={<span className={cn(failed && "text-bad")}>{failed ? "工具结果（未成功）" : "工具结果"}</span>}
      code={output} maxHeight={260} className={className} />
  );
}
