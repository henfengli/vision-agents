/**
 * 5 段 cron（分 时 日 月 周）：解析、校验、算接下来 N 次触发、给中文描述。
 * 与 Temporal Schedule 的 cron 语义一致（周日 = 0 或 7；日与周同时限定时取"或"）。
 */

interface Field { min: number; max: number }
const FIELDS: Field[] = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 }, { min: 1, max: 12 }, { min: 0, max: 7 },
];
const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *",
};

export interface Cron {
  sets: Set<number>[];
  domStar: boolean;
  dowStar: boolean;
}

function parseField(text: string, f: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`步长不合法：${part}`);
    let lo: number, hi: number;
    if (range === "*") { lo = f.min; hi = f.max; }
    else if (range.includes("-")) { [lo, hi] = range.split("-").map(Number); }
    else { lo = Number(range); hi = stepText ? f.max : lo; }
    if (![lo, hi].every(Number.isInteger) || lo < f.min || hi > f.max || lo > hi) throw new Error(`取值越界：${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const text = MACROS[expr.trim()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error("需要 5 段：分 时 日 月 周");
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function validateCron(expr: string): string | null {
  try { parseCron(expr); return null; } catch (e) { return (e as Error).message; }
}

function matchesDay(c: Cron, d: Date): boolean {
  const dom = c.sets[2].has(d.getDate());
  const dow = c.sets[4].has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

/** 接下来 n 次触发（本地时区），最多向前搜 2 年 */
export function nextRuns(expr: string, n = 5, from = new Date()): Date[] {
  const c = parseCron(expr);
  const out: Date[] = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 2 * 366 * 86400_000;
  while (out.length < n && d.getTime() < limit) {
    if (!c.sets[3].has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    if (!matchesDay(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue; }
    if (!c.sets[1].has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue; }
    if (!c.sets[0].has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 常见形态的中文描述；复杂表达式返回原文 */
export function describeCron(expr: string): string {
  const text = MACROS[expr.trim()] ?? expr.trim();
  const p = text.split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = p;
  const at = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
  if (mi.startsWith("*/") && h === "*" && dom === "*" && mon === "*" && dow === "*") return `每 ${mi.slice(2)} 分钟`;
  if (/^\d+$/.test(mi) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `每小时第 ${mi} 分`;
  if (/^\d+$/.test(mi) && h.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") return `每 ${h.slice(2)} 小时（第 ${mi} 分）`;
  if (at && dom === "*" && mon === "*" && dow === "*") return `每天 ${at}`;
  if (at && dom === "*" && mon === "*" && dow === "1-5") return `工作日 ${at}`;
  if (at && dom === "*" && mon === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `每${dow.split(",").map((d) => WEEK[Number(d) % 7]).join("、")} ${at}`;
  if (at && /^\d+$/.test(dom) && mon === "*" && dow === "*") return `每月 ${dom} 日 ${at}`;
  return expr;
}
