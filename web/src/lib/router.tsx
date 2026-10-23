/**
 * 极简路由：history / hash 两种模式（构建期 __ROUTER__ 决定），
 * 路由表 = [模式, 组件]，模式支持 :param 与末尾 *。
 * 查询参数是一等公民：列表页的筛选全部放 URL（可分享、可回退）。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore,
  type AnchorHTMLAttributes, type ComponentType, type MouseEvent, type ReactNode,
} from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
const HASH = __ROUTER__ === "hash";

function readLocation(): string {
  if (HASH) return window.location.hash.slice(1) || "/";
  return window.location.pathname + window.location.search;
}

function emit() {
  listeners.forEach((l) => l());
}

window.addEventListener(HASH ? "hashchange" : "popstate", emit);

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ———————— 离开前提醒（编辑器有未保存的修改） ————————

/** watch：这些查询参数变了也算离开（标签页切换会卸载编辑器）；路径变了总算离开 */
interface LeaveGuard { watch: string[] }
const guards = new Set<LeaveGuard>();

function leaveBlocked(to: string): boolean {
  if (!guards.size) return false;
  const [curPath, curQs = ""] = readLocation().split("?");
  const [nextPath, nextQs = ""] = to.split("?");
  const a = new URLSearchParams(curQs), b = new URLSearchParams(nextQs);
  const leaving = [...guards].some((g) => curPath !== nextPath || g.watch.some((k) => a.get(k) !== b.get(k)));
  return leaving && !window.confirm("有未保存的修改，离开后会丢失。确定离开？");
}

/** 有未保存的修改时：站内跳转先确认，关闭 / 刷新页面时浏览器提示 */
export function useLeaveGuard(active: boolean, watch: string[] = ["tab", "part"]) {
  const key = watch.join(",");
  useEffect(() => {
    if (!active) return;
    const g: LeaveGuard = { watch: key.split(",").filter(Boolean) };
    guards.add(g);
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onUnload);
    return () => { guards.delete(g); window.removeEventListener("beforeunload", onUnload); };
  }, [active, key]);
}

/** 返回 false = 用户在"有未保存的修改"提示里选了留下 */
export function navigate(to: string, opts: { replace?: boolean; force?: boolean } = {}): boolean {
  if (to === readLocation()) return true;
  if (!opts.force && leaveBlocked(to)) return false;
  if (HASH) {
    if (opts.replace) window.location.replace("#" + to);
    else window.location.hash = to;
  } else {
    if (opts.replace) window.history.replaceState(null, "", to);
    else window.history.pushState(null, "", to);
    emit();
  }
  window.scrollTo({ top: 0 });
  return true;
}

export function useLocation(): { path: string; search: URLSearchParams; href: string } {
  const href = useSyncExternalStore(subscribe, readLocation);
  return useMemo(() => {
    const [path, qs = ""] = href.split("?");
    return { path: path || "/", search: new URLSearchParams(qs), href };
  }, [href]);
}

/** 查询参数读写：set 合并更新，值为空串/undefined 即删除 */
export function useSearch<T extends Record<string, string>>(): [Partial<T>, (patch: Partial<Record<keyof T, string | number | undefined | null>>, replace?: boolean) => void] {
  const { path, search } = useLocation();
  const params = useMemo(() => Object.fromEntries(search.entries()) as Partial<T>, [search]);
  const set = useCallback(
    (patch: Partial<Record<keyof T, string | number | undefined | null>>, replace = true) => {
      const next = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || v === "") next.delete(k);
        else next.set(k, String(v));
      }
      const qs = next.toString();
      navigate(path + (qs ? "?" + qs : ""), { replace });
    },
    [path, search],
  );
  return [params, set];
}

// ———————— 路由匹配 ————————

export interface RouteDef {
  path: string;
  component: ComponentType;
}

interface Match {
  route: RouteDef;
  params: Record<string, string>;
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") {
      params["*"] = s.slice(i).map(decodeURIComponent).join("/");
      return params;
    }
    if (i >= s.length) return null;
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return p.length === s.length ? params : null;
}

const ParamsContext = createContext<Record<string, string>>({});

export function useParams<T extends Record<string, string>>(): T {
  return useContext(ParamsContext) as T;
}

export function Routes({ routes, fallback }: { routes: RouteDef[]; fallback: ComponentType }) {
  const { path } = useLocation();
  const match: Match | null = useMemo(() => {
    for (const route of routes) {
      const params = matchPath(route.path, path);
      if (params) return { route, params };
    }
    return null;
  }, [routes, path]);
  const Comp = match?.route.component ?? fallback;
  return (
    <ParamsContext.Provider value={match?.params ?? {}}>
      <Comp key={match?.route.path ?? "404"} />
    </ParamsContext.Provider>
  );
}

// ———————— Link ————————

export function hrefOf(to: string): string {
  return HASH ? "#" + to : to;
}

export function Link({
  to, children, onClick, replace, ...rest
}: { to: string; children: ReactNode; replace?: boolean } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <a
      href={hrefOf(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || rest.target) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

/** 当前路径是否落在 prefix 下（侧栏高亮） */
export function useActive(prefix: string): boolean {
  const { path } = useLocation();
  return prefix === "/" ? path === "/" : path === prefix || path.startsWith(prefix + "/");
}
