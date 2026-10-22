import { nextRuns } from "../../lib/cron";

/** cron 的下一次触发（ISO）；表达式非法返回 null */
export function cronNextOf(cron: string): string | null {
  try {
    return nextRuns(cron, 1)[0]?.toISOString() ?? null;
  } catch {
    return null;
  }
}
