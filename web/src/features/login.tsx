import { useState } from "react";
import { LuKeyRound, LuUser } from "react-icons/lu";

import { post } from "@/api/client";
import { Logo } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { navigate, useSearch } from "@/lib/router";

/**
 * 登录：用一把 API 密钥（或部署时的 root_token）换 httponly 会话 cookie。
 * 平台没有用户体系，也不分权限；"你的名字"写进版本台账和运行的发起方，让人知道是谁改的、谁发起的。
 */
export function LoginPage() {
  const [search] = useSearch<{ next: string }>();
  const [token, setToken] = useState("");
  const [name, setName] = useState(() => { try { return localStorage.getItem("ap.login.name") ?? ""; } catch { return ""; } });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      await post("/auth/session", { token: token.trim(), name: name.trim() });
      try { localStorage.setItem("ap.login.name", name.trim()); } catch { /* 无痕模式 */ }
      // next 只接受站内路径（/ 开头且不是 //）：不跳到别的站点
      const next = search.next && /^\/(?!\/)/.test(search.next) && !search.next.startsWith("/login") ? search.next : "/";
      navigate(next, { replace: true, force: true });
    } catch (err) {
      setError((err as Error).message || "登录失败");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-6">
      <form onSubmit={submit} className="w-full max-w-[360px] rounded-xl border border-line bg-panel p-7 shadow-[var(--shadow-pop)]">
        <Logo className="size-9" />
        <h1 className="mt-4 text-[17px] font-semibold text-fg">登录 agent-platform</h1>
        <p className="mt-1 text-[12.5px] text-fg-3">用一把 API 密钥（或部署时的 root_token）登录；密钥只标识身份，登录后能使用全部功能。</p>
        <Field label="密钥" className="mt-5" error={error}>
          <Input autoFocus type="password" mono autoComplete="current-password" value={token} onChange={(e) => setToken(e.target.value)} prefixIcon={<LuKeyRound />} placeholder="ap_…" aria-invalid={!!error} aria-label="密钥" />
        </Field>
        <Field label="你的名字" className="mt-3" help="记进版本台账与运行的发起方；不填则显示密钥名">
          <Input value={name} autoComplete="username" onChange={(e) => setName(e.target.value)} prefixIcon={<LuUser />} placeholder="zhangsan" aria-label="你的名字" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-5 w-full" loading={pending} disabled={!token.trim()}>登录</Button>
      </form>
    </div>
  );
}
