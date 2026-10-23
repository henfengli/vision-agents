/**
 * 工具调用的展示（运行详情的时间线、对话的过程）：参数一行摘要、参数详情、结果。
 * db_query（旧运行是 sql_query）单独排版：查询放代码块并标出库名；结果解析出 类型 · 库 · 行列数 · 耗时，
 * 大结果写进了工作目录的文件时给出可复制的路径，预览表格按表格显示。
 */
import { useState } from "react";
import { LuDatabase, LuFileText } from "react-icons/lu";

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

/** 时间线标题里的一行参数摘要 */
export function summarizeArgs(args: unknown, tool?: string): string {
  if (tool === "submit_result") return "交回结构化结果";
  const a = asArgs(args);
  if (!a) return args ? String(args) : "";
  if (isDbTool(tool)) {
    const q = dbQueryOf(a);
    return (q.db ? `${q.db} · ` : "") + q.text.replace(/\s+/g, " ").slice(0, 90);
  }
  const v = a.subagent ? `${a.subagent}：${a.description ?? ""}` : a.command ?? a.code ?? a.what ?? Object.values(a)[0];
  return v ? (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").slice(0, 90) : "";
}

export function ToolArgs({ tool, args }: { tool?: string; args: unknown }) {
  const a = asArgs(args);
  if (a) {
    if (isDbTool(tool)) {
      const q = dbQueryOf(a);
      const title = (
        <span className="flex items-center gap-1.5">
          <LuDatabase className="size-3.5" />{q.mongo ? "MongoDB 查询" : "SQL"}
          <span>· 库 {q.db ? <code className="font-mono text-fg-2">{q.db}</code> : <span>（唯一登记的库）</span>}</span>
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
  const failed = /^\[(拒绝|失败|超时|查询出错|不可用|未配置|参数|无服务|无进程|无数据|监控不可用|不符合要求|未执行)\]/.test(output);
  return (
    <CodeBlock title={<span className={cn(failed && "text-bad")}>{failed ? "工具结果（未成功）" : "工具结果"}</span>}
      code={output} maxHeight={260} className={className} />
  );
}
