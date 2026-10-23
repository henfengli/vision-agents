/**
 * 个人偏好（只存在这台浏览器的 localStorage，不经过后端）：主题、全局环境视角、侧栏、
 * 首页、时间显示、列表密度、自动刷新、每页条数、对话默认项。设置 → 个人偏好 里改。
 * 全局环境是"看哪套环境"的视角：列表/统计默认按它过滤，"" = 全部。
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

export interface UiState {
  theme: Theme;
  env: string;
  sidebarCollapsed: boolean;
  landing: (typeof LANDINGS)[number];
  timeFormat: "relative" | "absolute";
  density: "comfortable" | "compact";
  autoRefresh: boolean;          // 关掉后列表不再定时刷新（运行中的详情页与对话仍实时）
  pageSize: 30 | 50 | 100;
  chat: { service: string; env: string; task: string; recall: boolean; save: boolean };
}

/** "打开控制台时进入"可选的页面 */
export const LANDINGS = ["/", "/runs", "/chat", "/services", "/tasks"] as const;

const KEY = "ap.ui";
export const UI_DEFAULTS: UiState = {
  theme: "system", env: "", sidebarCollapsed: false, landing: "/", timeFormat: "relative", density: "comfortable",
  autoRefresh: true, pageSize: 30, chat: { service: "", env: "", task: "", recall: true, save: true },
};

function read(): UiState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    // 旧版本存过的首页可能已经不存在（比如审批页）：回到概览
    if (!LANDINGS.includes(saved.landing)) delete saved.landing;
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
function applyDensity(density: UiState["density"]) {
  document.documentElement.dataset.density = density;
}
applyTheme(state.theme);
applyDensity(state.density);
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
  if (patch.density) applyDensity(patch.density);
  listeners.forEach((l) => l());
}

export function resetUi() {
  setUi(UI_DEFAULTS);
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
