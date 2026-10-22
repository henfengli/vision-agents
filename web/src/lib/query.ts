/**
 * 数据层：按 key 缓存的请求（SWR 语义：先给缓存、后台刷新），
 * 轮询、窗口回焦刷新、前缀失效。约 150 行替代 react-query 的常用子集。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getUi } from "./store";

type Key = readonly unknown[];

interface Entry<T = unknown> {
  data?: T;
  error?: Error;
  updatedAt: number;
  promise?: Promise<T>;
  fetcher?: () => Promise<T>;
  subscribers: Set<() => void>;
}

const cache = new Map<string, Entry>();
const hashKey = (key: Key) => JSON.stringify(key);

function entry(hash: string): Entry {
  let e = cache.get(hash);
  if (!e) {
    e = { updatedAt: 0, subscribers: new Set() };
    cache.set(hash, e);
  }
  return e;
}

function notify(e: Entry) {
  e.subscribers.forEach((fn) => fn());
}

async function load<T>(hash: string, fetcher: () => Promise<T>): Promise<T> {
  const e = entry(hash) as Entry<T>;
  e.fetcher = fetcher;
  if (e.promise) return e.promise;
  e.promise = fetcher()
    .then((data) => {
      e.data = data;
      e.error = undefined;
      e.updatedAt = Date.now();
      return data;
    })
    .catch((err: Error) => {
      e.error = err;
      throw err;
    })
    .finally(() => {
      e.promise = undefined;
      notify(e);
    });
  notify(e);
  return e.promise;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;        // 首次加载（无缓存）
  fetching: boolean;       // 任意加载中（含后台刷新）
  refetch: () => Promise<T | undefined>;
}

export interface QueryOptions {
  enabled?: boolean;
  refetchInterval?: number;  // 毫秒
  staleTime?: number;        // 毫秒内复用缓存不发请求（默认 5s）
  live?: boolean;            // 实时视图（运行中的详情）：不受"自动刷新"偏好影响
}

export function useQuery<T>(key: Key, fetcher: () => Promise<T>, opts: QueryOptions = {}): QueryResult<T> {
  const { enabled = true, refetchInterval, staleTime = 5000, live = false } = opts;
  const hash = hashKey(key);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const snapshot = useSyncExternalStore(
    useCallback((cb) => {
      const e = entry(hash);
      e.subscribers.add(cb);
      return () => e.subscribers.delete(cb);
    }, [hash]),
    () => {
      const e = entry(hash);
      return `${e.updatedAt}|${e.promise ? 1 : 0}|${e.error ? e.error.message : ""}`;
    },
  );
  void snapshot;

  const run = useCallback(() => load(hash, () => fetcherRef.current()).catch(() => undefined), [hash]);

  useEffect(() => {
    if (!enabled) return;
    const e = entry(hash);
    if (!e.promise && Date.now() - e.updatedAt > staleTime) void run();
  }, [hash, enabled, staleTime, run]);

  useEffect(() => {
    if (!enabled || !refetchInterval) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && (live || getUi().autoRefresh)) void run();
    }, refetchInterval);
    return () => window.clearInterval(id);
  }, [enabled, refetchInterval, live, run]);

  const e = entry(hash) as Entry<T>;
  return {
    data: e.data,
    error: e.error,
    loading: enabled && e.data === undefined && !e.error,
    fetching: !!e.promise,
    refetch: run as () => Promise<T | undefined>,
  };
}

/** 前缀失效：key 以 prefix 开头的缓存全部后台重取 */
export function invalidate(...prefix: unknown[]) {
  const p = JSON.stringify(prefix).slice(0, -1);
  for (const [hash, e] of cache) {
    if (hash.startsWith(p) && e.fetcher && e.subscribers.size > 0) void load(hash, e.fetcher).catch(() => undefined);
    else if (hash.startsWith(p)) e.updatedAt = 0;
  }
}

/** 直接写缓存（乐观更新） */
export function setQueryData<T>(key: Key, updater: (old: T | undefined) => T) {
  const e = entry(hashKey(key)) as Entry<T>;
  e.data = updater(e.data);
  e.updatedAt = Date.now();
  notify(e);
}

window.addEventListener("focus", () => {
  for (const [hash, e] of cache) {
    if (e.subscribers.size > 0 && e.fetcher && Date.now() - e.updatedAt > 15000) void load(hash, e.fetcher).catch(() => undefined);
  }
});

export interface MutationResult<A, R> {
  mutate: (arg: A) => Promise<R>;
  pending: boolean;
  error: Error | undefined;
}

export function useMutation<A, R>(fn: (arg: A) => Promise<R>): MutationResult<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error>();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mutate = useCallback(async (arg: A) => {
    setPending(true);
    setError(undefined);
    try {
      return await fnRef.current(arg);
    } catch (e) {
      setError(e as Error);
      throw e;
    } finally {
      setPending(false);
    }
  }, []);
  return { mutate, pending, error };
}
