import { useState } from "react";
import { LuKeyRound, LuUser } from "react-icons/lu";

import { post } from "@/api/client";
import { Logo } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { navigate, useSearch } from "@/lib/router";

/**
 * 登录：用一把 API 密钥（或部署时的 root_token）换 httponly 会话 cookie。
 * 平台没有用户体系；"你的名字"写进版本台账和审批记录，让人知道是谁改的、谁放行的。
 */
export function LoginPage() {
  const [search] = useSearch<{ next: string }>();
  const [token, setToken] = useState("");
  const [name, setName] = useState(() => { try { return localStorage.getItem("ap.login.name") ?? ""; } catch { return ""; } });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await post("/auth/session", { token, name: name.trim() });
      try { localStorage.setItem("ap.login.name", name.trim()); } catch { /* 无痕模式 */ }
      navigate(search.next && search.next.startsWith("/") ? search.next : "/", { replace: true });
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
        <p className="mt-1 text-[12.5px] text-fg-3">用一把 API 密钥登录；管理范围的密钥才能改定义和审批。</p>
        <Field label="密钥" className="mt-5" error={error}>
          <Input autoFocus type="password" mono value={token} onChange={(e) => setToken(e.target.value)} prefixIcon={<LuKeyRound />} placeholder="ak_…" aria-invalid={!!error} />
        </Field>
        <Field label="你的名字" className="mt-3" help="记进版本台账与审批记录；不填则显示密钥名">
          <Input value={name} onChange={(e) => setName(e.target.value)} prefixIcon={<LuUser />} placeholder="zhangsan" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-5 w-full" loading={pending} disabled={!token}>登录</Button>
      </form>
    </div>
  );
}
