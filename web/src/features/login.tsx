import { useState } from "react";
import { LuKeyRound } from "react-icons/lu";

import { post } from "@/api/client";
import { Logo } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { navigate, useSearch } from "@/lib/router";

/** 登录：输入平台 bearer token，换 httponly 会话 cookie（无用户体系） */
export function LoginPage() {
  const [search] = useSearch<{ next: string }>();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await post("/auth/session", { token });
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
        <p className="mt-1 text-[12.5px] text-fg-3">使用平台访问令牌（与 API 的 bearer token 相同）</p>
        <Field label="访问令牌" className="mt-5" error={error}>
          <Input autoFocus type="password" mono value={token} onChange={(e) => setToken(e.target.value)} prefixIcon={<LuKeyRound />} placeholder="AGENT_BEARER_TOKEN" aria-invalid={!!error} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-5 w-full" loading={pending} disabled={!token}>登录</Button>
      </form>
    </div>
  );
}
