/**
 * 全局 UI 状态（持久化到 localStorage）：主题、全局环境、侧栏折叠。
 * 全局环境是"看哪套环境"的视角：列表/统计默认按它过滤，"" = 全部。
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

interface UiState {
  theme: Theme;
  env: string;
  sidebarCollapsed: boolean;
}

const KEY = "ap.ui";
const defaults: UiState = { theme: "system", env: "", sidebarCollapsed: false };

function read(): UiState {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return defaults;
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
