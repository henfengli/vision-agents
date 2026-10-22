/**
 * HTTP 客户端：唯一的请求出口。mock 构建（__MOCK__）时请求转给内存 mock 服务，
 * 页面代码对此无感知。错误统一成 ApiError（code 是后端原因码）。
 */
import type { ApiErrorBody } from "./types";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function qs(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}

async function mockCall<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
  const { handle } = await import("./mock/server");
  return handle(method, path, query ?? {}, body) as Promise<T>;
}

export async function request<T>(method: string, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  if (__MOCK__) return mockCall<T>(method, path, opts.query, opts.body);
  const res = await fetch(path + qs(opts.query), {
    method,
    credentials: "same-origin",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    window.dispatchEvent(new CustomEvent("ap:unauthorized"));
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try { body = await res.json(); } catch { /* 非 JSON 错误体 */ }
    throw new ApiError(res.status, body?.error.code ?? "http_" + res.status, body?.error.message ?? res.statusText, body?.error.detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const get = <T>(path: string, query?: Query) => request<T>("GET", path, { query });
export const post = <T>(path: string, body?: unknown, query?: Query) => request<T>("POST", path, { body: body ?? {}, query });
export const put = <T>(path: string, body: unknown) => request<T>("PUT", path, { body });
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, { body });
export const del = <T>(path: string) => request<T>("DELETE", path);

/**
 * SSE 流：POST 发起、逐事件回调；返回 abort 函数。
 * 后端用 text/event-stream，每条 `data: {json}`。
 */
export function stream(path: string, body: unknown, onEvent: (ev: Record<string, unknown>) => void,
  onDone: (err?: Error) => void): () => void {
  if (__MOCK__) {
    let cancel = () => {};
    import("./mock/server").then(({ handleStream }) => { cancel = handleStream(path, body, onEvent, onDone); });
    return () => cancel();
  }
  const ctl = new AbortController();
  (async () => {
    try {
      const res = await fetch(path, {
        method: "POST", credentials: "same-origin", signal: ctl.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        let b: ApiErrorBody | null = null;
        try { b = await res.json(); } catch { /* ignore */ }
        throw new ApiError(res.status, b?.error.code ?? "http_" + res.status, b?.error.message ?? res.statusText);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
        }
      }
      onDone();
    } catch (e) {
      if ((e as Error).name !== "AbortError") onDone(e as Error);
    }
  })();
  return () => ctl.abort();
}
