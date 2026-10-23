import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

import { getUi } from "./store";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

export { dayjs };

/** 相对时间："3 分钟前"；超过 7 天给日期。个人偏好选了"绝对时间"则一律给日期时间 */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = dayjs(iso);
  if (getUi().timeFormat === "absolute") return d.format(d.year() === dayjs().year() ? "MM-DD HH:mm" : "YYYY-MM-DD HH:mm");
  if (Math.abs(dayjs().diff(d, "day")) >= 7) return d.format("MM-DD HH:mm");
  return d.fromNow();
}

/** 未来时间："5 分钟后" */
export function until(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dayjs(iso).fromNow();
}

export function datetime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return "—";
  return dayjs(iso).format(withSeconds ? "YYYY-MM-DD HH:mm:ss" : "YYYY-MM-DD HH:mm");
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  return dayjs(iso).format("HH:mm:ss");
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** 配置里的秒数（超时、去重窗口）："15 分钟"、"2 小时"、"45 秒" */
export function seconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600} 小时`;
  if (s >= 60 && s % 60 === 0) return `${s / 60} 分钟`;
  return `${s} 秒`;
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString("zh-CN");
}

export function pct(part: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
