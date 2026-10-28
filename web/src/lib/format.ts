import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);
dayjs.locale("zh-cn");

export { dayjs };

/** 相对时间："3 分钟前"；超过 7 天给日期 */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = dayjs(iso);
  if (Math.abs(dayjs().diff(d, "day")) >= 7) return d.format("MM-DD HH:mm");
  return d.fromNow();
}

/** 未来时间："5 分钟后"、"22 小时后"、"3 天后"（dayjs 的 fromNow 把 22 小时说成「1 天内」，读起来像是随时会跑） */
export function until(iso: string | null | undefined): string {
  if (!iso) return "—";
  const min = Math.round(dayjs(iso).diff(dayjs(), "second") / 60);
  if (min < 1) return "马上";
  if (min < 60) return `${min} 分钟后`;
  if (min < 24 * 60) return `${Math.round(min / 60)} 小时后`;
  return `${Math.round(min / 60 / 24)} 天后`;
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
  if (s < 59.5) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const t = Math.round(s);          // 先取整再拆分，免得出现 "1m 60s"
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${t % 60}s`;
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
