/**
 * 服务定义的结构化编辑器：基本信息 / 配置文件 / 进程 / 环境覆盖 / 档案。
 * 本地草稿 + 未保存提示条；保存 = 新版本，5 秒内热生效。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LuFileText, LuPlus, LuScrollText, LuServer, LuSettings, LuTrash2, LuLayers } from "react-icons/lu";

import { api, useEnvs } from "@/api/hooks";
import type { ProcessDef, Service, ServiceEnvOverride, ServiceSummary } from "@/api/types";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { KeyValueEditor, type KvSuggestion } from "@/components/ui/data";
import { Field, Input, Segmented, Switch, TagInput, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Card, CardHeader } from "@/components/ui/primitives";
import { invalidate, useMutation } from "@/lib/query";

export const PROFILE_SUGGESTIONS: KvSuggestion[] = [
  { key: "conventions", label: "口径与术语", placeholder: "如：GMV 不含退款；total_fee 单位是分" },
  { key: "no_go", label: "禁区", placeholder: "如：prod 不手工触发 backfill" },
  { key: "env_notes", label: "环境差异", placeholder: "如：test 数据是脱敏快照，金额乘了随机系数" },
  { key: "pitfalls", label: "常见坑", placeholder: "如：上游 03:00 后完成会级联失败" },
];

type Draft = Pick<Service, "title" | "description" | "root" | "code_paths" | "repo" | "ref" | "hosts" | "readonly_dsn" | "configs" | "processes" | "envs" | "profile">;

function toDraft(s: ServiceSummary): Draft {
  return structuredClone({ title: s.title, description: s.description, root: s.root, code_paths: s.code_paths, repo: s.repo, ref: s.ref, hosts: s.hosts, readonly_dsn: s.readonly_dsn, configs: s.configs, processes: s.processes, envs: s.envs, profile: s.profile });
}

const DSN_HELP = "口令写成 ${VAR}，真实值放 secrets.env；直接写的口令回显为 ***，原样保存表示不改";

function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-4">
      <CardHeader icon={icon} title={title} description={description} />
      <div className="p-4">{children}</div>
    </Card>
  );
}

export function ServiceConfigEditor({ svc, onSaved }: { svc: ServiceSummary; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(svc));
  const { data: envs } = useEnvs();
  useEffect(() => setDraft(toDraft(svc)), [svc.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(svc)), [draft, svc]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation(async () => {
    try {
      const res = await api.update<ServiceSummary>("services", svc.name, draft);
      toast(`已保存为 v${res.version}`, { description: "5 秒内对新运行生效" });
      invalidate("services");
      onSaved();
    } catch (e) {
      toast.error("保存失败", (e as Error).message);
    }
  });

  const procEntries = Object.entries(draft.processes);
  const setProc = (name: string, p: ProcessDef | null, rename?: string) => {
    const next: Record<string, ProcessDef> = {};
    for (const [k, v] of Object.entries(draft.processes)) {
      if (k !== name) next[k] = v;
      else if (p) next[rename ?? k] = p;
    }
    set("processes", next);
  };
  const allEnvs = envs ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
      <nav className="sticky top-4 hidden h-fit space-y-0.5 text-[12.5px] lg:block">
        {[["basic", "基本信息"], ["configs", "配置文件"], ["processes", "进程"], ["envs", "环境覆盖"], ["profile", "服务档案"]].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}
            className="block rounded-md px-2.5 py-1.5 text-fg-2 hover:bg-hover hover:text-fg">{label}</a>
        ))}
      </nav>
      <div className="min-w-0 space-y-4 pb-20">
        <Section id="basic" icon={<LuSettings />} title="基本信息" description="路径里可以写 {env}：每个环境一份代码（如 /srv/svc/board/code/{env}），各环境停在不同的提交上。代码目录用于读代码、校验记忆新鲜度（引用的文件改过即过期）">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名"><Input value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="部署目录" help="agent 只读访问；可含 {env}"><Input mono value={draft.root} placeholder="/srv/svc/xxx/code/{env}" onChange={(e) => set("root", e.target.value)} /></Field>
            <Field label="说明" className="md:col-span-2"><Textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="代码仓库" help="git 远端；配了才能在服务页「同步代码」，GitLab 部署事件也会自动同步"><Input mono value={draft.repo} onChange={(e) => set("repo", e.target.value)} placeholder="git@gitlab.internal:group/xxx.git" /></Field>
            <Field label="跟踪分支" help="代码同步的默认目标；各环境可在「环境」里覆盖"><Input mono value={draft.ref} onChange={(e) => set("ref", e.target.value)} placeholder="远端默认分支" /></Field>
            <Field label="代码目录" help="回车添加；缺省 = 部署目录"><TagInput mono value={draft.code_paths} onChange={(v) => set("code_paths", v)} placeholder="/srv/xxx" suggestions={draft.root && !draft.code_paths.includes(draft.root) ? [draft.root] : []} /></Field>
            <Field label="部署主机" help="host_metrics 查监控用；可按环境覆盖"><TagInput mono value={draft.hosts} onChange={(v) => set("hosts", v)} placeholder="10.0.0.11" /></Field>
            <Field label="只读库 DSN" help={`sql_query 的数据源，只给只读账号；可按环境覆盖。${DSN_HELP}`} className="md:col-span-2">
              <Input mono value={draft.readonly_dsn ?? ""} onChange={(e) => set("readonly_dsn", e.target.value || null)} placeholder="postgresql://ro:${RO_PASSWORD}@host:5432/db" />
            </Field>
          </div>
        </Section>

        <Section id="configs" icon={<LuFileText />} title="配置文件" description="固定路径 ← 每环境一份的模板（{env} 占位）。启动进程时选中环境的文件 bind 到固定路径，其余环境的文件遮蔽，进程不可能读错环境；agent 的 bash 里所有配置文件都被遮蔽，只能经 service_info 读本环境（密钥打码）。">
          <div className="space-y-2">
            {draft.configs.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                <Input mono value={c.template} placeholder="/srv/svc/x/conf/{env}/app.yaml" onChange={(e) => set("configs", draft.configs.map((x, j) => (j === i ? { ...x, template: e.target.value } : x)))} />
                <span className="text-fg-3">→</span>
                <Input mono value={c.canonical} placeholder="/srv/svc/x/code/{env}/app.yaml" onChange={(e) => set("configs", draft.configs.map((x, j) => (j === i ? { ...x, canonical: e.target.value } : x)))} />
                <Button variant="ghost" size="icon-sm" onClick={() => set("configs", draft.configs.filter((_, j) => j !== i))}><LuTrash2 /></Button>
              </div>
            ))}
            {draft.configs.some((c) => c.template && !c.template.includes("{env}")) && <div className="text-xs text-warn">模板路径里没有 {"{env}"}：所有环境会读同一个文件</div>}
            <Button size="xs" icon={<LuPlus />} onClick={() => set("configs", [...draft.configs, { canonical: "", template: "" }])}>添加配置文件</Button>
          </div>
        </Section>

        <Section id="processes" icon={<LuServer />} title="进程" description="可按环境启停的进程。cmd 里 {port}/{env} 会按环境替换；每次启动带租约，到期自动停止。">
          <div className="space-y-3">
            {procEntries.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">没有进程：这个服务只读不启停</div>}
            {procEntries.map(([name, p]) => (
              <div key={name} className="rounded-lg border border-line bg-sunken/40 p-3.5">
                <div className="grid gap-3 md:grid-cols-[180px_1fr_auto]">
                  <Field label="名称"><Input mono value={name} onChange={(e) => setProc(name, p, e.target.value.replace(/\s/g, ""))} /></Field>
                  <Field label="启动命令" help="空格分隔；含空格的参数用引号">
                    <Input mono value={p.cmd.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}
                      onChange={(e) => setProc(name, { ...p, cmd: (e.target.value.match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, "")) })} />
                  </Field>
                  <div className="flex items-end pb-0.5"><Button variant="ghost" size="icon-sm" onClick={() => setProc(name, null)}><LuTrash2 /></Button></div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr_140px]">
                  <Field label="工作目录"><Input mono value={p.workdir ?? ""} onChange={(e) => setProc(name, { ...p, workdir: e.target.value || null })} placeholder={draft.root} /></Field>
                  <Field label="端口（按环境）">
                    <div className="flex flex-wrap gap-2">
                      {allEnvs.map((e) => (
                        <label key={e.name} className="flex items-center gap-1.5">
                          <EnvBadge env={e.name} />
                          <input value={p.ports?.[e.name] ?? ""} inputMode="numeric"
                            onChange={(ev) => {
                              const ports = { ...(p.ports ?? {}) };
                              if (ev.target.value) ports[e.name] = Number(ev.target.value.replace(/\D/g, "")); else delete ports[e.name];
                              setProc(name, { ...p, ports });
                            }}
                            className="h-8 w-20 rounded-md border border-line bg-panel px-2 font-mono text-[12.5px] outline-none focus:border-accent" />
                        </label>
                      ))}
                    </div>
                  </Field>
                  <Field label="租约（小时）" help="空 = 平台默认"><Input inputMode="decimal" value={p.lease_hours ?? ""} placeholder="默认" onChange={(e) => setProc(name, { ...p, lease_hours: e.target.value ? Number(e.target.value) || null : null })} /></Field>
                </div>
              </div>
            ))}
            <Button size="xs" icon={<LuPlus />} onClick={() => {
              let n = "app"; let i = 1;
              while (n in draft.processes) n = `app${++i}`;
              set("processes", { ...draft.processes, [n]: { cmd: [], workdir: null, ports: {}, lease_hours: null } });
            }}>添加进程</Button>
          </div>
        </Section>

        <Section id="envs" icon={<LuLayers />} title="环境" description="服务在每个环境是否启用，以及和基座不同的部分（只写差异）。一套 agent 操作多套业务环境，差异只在这里。">
          <div className="space-y-3">
            {allEnvs.map((e) => {
              const o: ServiceEnvOverride = draft.envs[e.name] ?? {};
              const setO = (patch: Partial<ServiceEnvOverride>) => {
                const next = { ...o, ...patch };
                for (const k of Object.keys(next) as (keyof ServiceEnvOverride)[]) {
                  const v = next[k];
                  if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete next[k];
                }
                const envsNext = { ...draft.envs, [e.name]: next };
                if (!Object.keys(next).length) delete envsNext[e.name];
                set("envs", envsNext);
              };
              return (
                <div key={e.name} className="rounded-lg border border-line p-3.5">
                  <div className="mb-3 flex items-center gap-2"><EnvBadge env={e.name} /><span className="text-[12.5px] font-medium text-fg">{e.title}</span>
                    {!Object.keys(o).length && <span className="text-xs text-fg-3">与基座相同</span>}
                    <div className="ml-auto"><Switch size="sm" checked={o.enabled !== false} onChange={(v) => setO({ enabled: v ? undefined : false })} label={<span className="text-[12px]">{o.enabled === false ? "该环境停用" : "启用"}</span>} /></div>
                  </div>
                  {o.enabled !== false && <div className="grid gap-3 md:grid-cols-2">
                    <Field label="主机"><TagInput mono value={o.hosts ?? []} onChange={(v) => setO({ hosts: v })} placeholder={draft.hosts.join(", ") || "继承基座"} /></Field>
                    <Field label="只读库 DSN" help={DSN_HELP}><Input mono value={o.readonly_dsn ?? ""} onChange={(ev) => setO({ readonly_dsn: ev.target.value || undefined })} placeholder={draft.readonly_dsn ?? "继承基座"} /></Field>
                    <Field label="跟踪分支"><Input mono value={o.ref ?? ""} onChange={(ev) => setO({ ref: ev.target.value || undefined })} placeholder={draft.ref || "继承基座"} /></Field>
                    <Field label="起进程" help={`空 = 跟随环境默认（${e.startable ? "可起" : "只看不起"}）`}>
                      <Segmented value={o.startable == null ? "inherit" : o.startable ? "yes" : "no"}
                        onChange={(v) => setO({ startable: v === "inherit" ? undefined : v === "yes" })}
                        options={[{ value: "inherit", label: "跟随环境" }, { value: "yes", label: "可起" }, { value: "no", label: "只看不起" }]} />
                    </Field>
                    <Field label="档案补充（只对该环境）" className="md:col-span-2">
                      <KeyValueEditor value={o.profile ?? {}} onChange={(v) => setO({ profile: v })} suggestions={PROFILE_SUGGESTIONS.slice(1, 3)} />
                    </Field>
                  </div>}
                </div>
              );
            })}
          </div>
        </Section>

        <Section id="profile" icon={<LuScrollText />} title="服务档案" description="置顶逐字注入该服务的所有 run，不走召回。只记代码和配置里读不出来的事实——能读出来的写进来只会过时。">
          <KeyValueEditor value={draft.profile} onChange={(v) => set("profile", v)} suggestions={PROFILE_SUGGESTIONS} />
        </Section>
      </div>

      <SaveBar visible={dirty} saving={save.pending} onDiscard={() => setDraft(toDraft(svc))} onSave={() => save.mutate(undefined)} label={`保存为 v${svc.version + 1}`} />
    </div>
  );
}
