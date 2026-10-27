/**
 * 界面状态（只存在这台浏览器的 localStorage，不经过后端）：主题（侧栏底部的账户菜单里切）、全局环境视角、侧栏、
 * 对话默认项（记住上次新对话用的服务 / 环境 / 任务 / 记忆开关）。
 * 全局环境是"看哪套环境"的视角：列表/统计默认按它过滤，"" = 全部。
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

export interface UiState {
  theme: Theme;
  env: string;
  sidebarCollapsed: boolean;
  /** recall / save：null = 跟随任务与平台的默认 */
  chat: { service: string; env: string; task: string; recall: boolean | null; save: boolean | null };
}

const KEY = "ap.ui";
export const UI_DEFAULTS: UiState = {
  theme: "system", env: "", sidebarCollapsed: false, chat: { service: "", env: "", task: "", recall: null, save: null },
};

function read(): UiState {
  try {
    // 旧版本存过的其他键（首页、密度、每页条数……）原样带着，没人读，不影响
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...UI_DEFAULTS, ...saved, chat: { ...UI_DEFAULTS.chat, ...(saved.chat ?? {}) } };
  } catch {
    return UI_DEFAULTS;
  }
}

let state = read();
const listeners = new Set<() => void>();

/** "跟随系统"时：宿主若在 <html data-theme> 上指定了主题（嵌入场景）就跟宿主，否则跟操作系统 */
function systemDark(): boolean {
  const host = document.documentElement.getAttribute("data-theme");
  if (host === "dark") return true;
  if (host === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem("ap.theme", theme); } catch { /* 隐私模式 */ }
}
applyTheme(state.theme);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(state.theme));
new MutationObserver(() => applyTheme(state.theme)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/** 窄屏（手机）：侧栏强制收起 */
const narrowQuery = matchMedia("(max-width: 768px)");
let narrow = narrowQuery.matches;
narrowQuery.addEventListener("change", (e) => { narrow = e.matches; listeners.forEach((l) => l()); });
export function useNarrow(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => narrow);
}

export function setUi(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 隐私模式 */ }
  if (patch.theme) applyTheme(patch.theme);
  listeners.forEach((l) => l());
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
}

export function getUi(): UiState {
  return state;
}
