/**
 * 服务定义的结构化编辑器：基本信息 / 配置文件 / 进程 / 环境覆盖 / 档案。
 * 本地草稿 + 未保存提示条；保存 = 新版本，5 秒内热生效。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LuFileText, LuGlobe, LuPlug, LuPlus, LuScrollText, LuServer, LuSettings, LuTrash2, LuLayers } from "react-icons/lu";

import { api, useEnvs } from "@/api/hooks";
import type { McpConnection, ProcessDef, Service, ServiceEnvOverride, ServiceSummary } from "@/api/types";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { KeyValueEditor, type KvSuggestion } from "@/components/ui/data";
import { Field, Input, Switch, TagInput, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Card, CardHeader } from "@/components/ui/primitives";
import { invalidate, useMutation } from "@/lib/query";

export const PROFILE_SUGGESTIONS: KvSuggestion[] = [
  { key: "conventions", label: "口径与术语", placeholder: "如：GMV 不含退款；total_fee 单位是分" },
  { key: "no_go", label: "禁区", placeholder: "如：prod 不手工触发 backfill" },
  { key: "env_notes", label: "环境差异", placeholder: "如：test 数据是脱敏快照，金额乘了随机系数" },
  { key: "pitfalls", label: "常见坑", placeholder: "如：上游 03:00 后完成会级联失败" },
];

/** mcp 单独编辑（每个 server 一段 JSON 文本，保存时才解析），不放进草稿 */
type Draft = Pick<Service, "title" | "description" | "root" | "code_paths" | "repo" | "ref" | "python" | "env_vars" | "urls" | "hosts" | "readonly_dsn" | "configs" | "processes" | "envs" | "profile">;

function toDraft(s: ServiceSummary): Draft {
  return structuredClone({
    title: s.title, description: s.description, root: s.root, code_paths: s.code_paths, repo: s.repo, ref: s.ref,
    python: s.python ?? "", env_vars: s.env_vars ?? {}, urls: s.urls ?? {}, hosts: s.hosts, readonly_dsn: s.readonly_dsn, configs: s.configs,
    processes: s.processes, envs: s.envs, profile: s.profile,
  });
}

// ———————— MCP：每个 server 一块，名字 + 连接配置（JSON） ————————

interface McpRow { id: number; name: string; text: string }
let mcpRowId = 0;
const toMcpRows = (mcp: Record<string, McpConnection> | undefined): McpRow[] =>
  Object.entries(mcp ?? {}).map(([name, cfg]) => ({ id: ++mcpRowId, name, text: JSON.stringify(cfg, null, 2) }));
const sameRows = (a: McpRow[], b: McpRow[]) => JSON.stringify(a.map((r) => [r.name, r.text])) === JSON.stringify(b.map((r) => [r.name, r.text]));

const MCP_TEMPLATES: Record<"stdio" | "http", McpConnection> = {
  stdio: { transport: "stdio", command: "{platform_python}", args: ["{platform}/mcp_servers/xxx_mcp.py"], env: { BASE_URL: "{url:deployed}" }, envs: { prod: {}, test: {} } },
  http: { transport: "streamable_http", url: "{url:deployed}/mcp", headers: { Authorization: "Bearer ${XXX_TOKEN}" }, envs: { prod: {}, test: {} } },
};

/** 每块的错误：名字不合法 / 重名 / 不是合法的 JSON 对象 */
function mcpErrors(rows: McpRow[]): Record<number, string> {
  const out: Record<number, string> = {};
  const seen = new Set<string>();
  for (const r of rows) {
    if (!/^[A-Za-z][\w-]{0,40}$/.test(r.name)) { out[r.id] = "名字：字母开头，可含字母、数字、_ -"; continue; }
    if (seen.has(r.name)) { out[r.id] = `重名：${r.name}`; continue; }
    seen.add(r.name);
    try {
      const v = JSON.parse(r.text);
      if (!v || typeof v !== "object" || Array.isArray(v)) out[r.id] = "连接配置要是一个 JSON 对象 { … }";
      else if (v.envs !== undefined && (!v.envs || typeof v.envs !== "object" || Array.isArray(v.envs))) out[r.id] = "envs 要是 {环境: 覆盖} 的对象";
    } catch (e) {
      out[r.id] = `不是合法的 JSON：${(e as Error).message}`;
    }
  }
  return out;
}

const DSN_HELP = "口令写成 ${VAR}，真实值放 secrets.env；直接写的口令回显为 ***，原样保存表示不改";
const URL_SUGGESTIONS: KvSuggestion[] = [
  { key: "site", label: "site 线上页面" }, { key: "local", label: "local 本机副本" }, { key: "deployed", label: "deployed 线上服务" },
];
const PYTHON_HELP = "项目内核（py 工具）与进程 cmd 里的 {python} 用它；可含 {env}，空 = python3";

/** 环境变量落在明文启动规格里：不允许 ${VAR}，口令放进该环境的配置文件 */
function envVarsError(v: Record<string, string>): string | null {
  const bad = Object.entries(v).filter(([, x]) => x.includes("${")).map(([k]) => k);
  return bad.length ? `不支持 \${VAR}：${bad.join("、")}（口令写进该环境的配置文件）` : null;
}

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
  const [mcpRows, setMcpRows] = useState<McpRow[]>(() => toMcpRows(svc.mcp));
  const [mcpBase, setMcpBase] = useState<McpRow[]>(mcpRows);
  const { data: envs } = useEnvs();
  useEffect(() => {
    setDraft(toDraft(svc));
    const rows = toMcpRows(svc.mcp);
    setMcpRows(rows);
    setMcpBase(rows);
  }, [svc.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(toDraft(svc)) || !sameRows(mcpRows, mcpBase), [draft, svc, mcpRows, mcpBase]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const varsError = envVarsError(draft.env_vars);
  const mcpErr = mcpErrors(mcpRows);
  const setRow = (id: number, patch: Partial<McpRow>) => setMcpRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = (kind: "stdio" | "http") => {
    let name = "server"; let i = 1;
    while (mcpRows.some((r) => r.name === name)) name = `server${++i}`;
    setMcpRows([...mcpRows, { id: ++mcpRowId, name, text: JSON.stringify(MCP_TEMPLATES[kind], null, 2) }]);
  };
  const discard = () => { setDraft(toDraft(svc)); setMcpRows(mcpBase); };

  const save = useMutation(async () => {
    try {
      const mcp = Object.fromEntries(mcpRows.map((r) => [r.name, JSON.parse(r.text) as McpConnection]));
      const res = await api.update<ServiceSummary>("services", svc.name, { ...draft, mcp });
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
        {[["basic", "基本信息"], ["configs", "配置文件"], ["processes", "进程"], ["urls", "地址"], ["mcp", "MCP"], ["envs", "环境覆盖"], ["profile", "服务档案"]].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}
            className="block rounded-md px-2.5 py-1.5 text-fg-2 hover:bg-hover hover:text-fg">{label}</a>
        ))}
      </nav>
      <div className="min-w-0 space-y-4 pb-20">
        <Section id="basic" icon={<LuSettings />} title="基本信息" description="路径与解释器里可以写 {env}：每个环境一份代码（如 /srv/svc/board/code/{env}）、一份 venv，各环境停在不同的提交上。代码目录用于读代码、校验记忆新鲜度（引用的文件改过即过期）">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名"><Input value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="部署目录" help="agent 只读访问；可含 {env}"><Input mono value={draft.root} placeholder="/srv/svc/xxx/code/{env}" onChange={(e) => set("root", e.target.value)} /></Field>
            <Field label="说明" className="md:col-span-2"><Textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="代码仓库" help="git 远端；配了才能在服务页「同步代码」，GitLab 部署事件也会自动同步"><Input mono value={draft.repo} onChange={(e) => set("repo", e.target.value)} placeholder="git@gitlab.internal:group/xxx.git" /></Field>
            <Field label="跟踪分支" help="代码同步的默认目标；各环境可在「环境」里覆盖"><Input mono value={draft.ref} onChange={(e) => set("ref", e.target.value)} placeholder="远端默认分支" /></Field>
            <Field label="代码目录" help="回车添加；缺省 = 部署目录"><TagInput mono value={draft.code_paths} onChange={(v) => set("code_paths", v)} placeholder="/srv/xxx" suggestions={draft.root && !draft.code_paths.includes(draft.root) ? [draft.root] : []} /></Field>
            <Field label="部署主机" help="host_metrics 查监控用；可按环境覆盖"><TagInput mono value={draft.hosts} onChange={(v) => set("hosts", v)} placeholder="10.0.0.11" /></Field>
            <Field label="项目 Python" help={`${PYTHON_HELP}；可按环境覆盖`}>
              <Input mono value={draft.python} onChange={(e) => set("python", e.target.value.trim())} placeholder="/srv/svc/xxx/venv/{env}/bin/python" />
            </Field>
            <Field label="只读库 DSN" help={`sql_query 的数据源，只给只读账号；可按环境覆盖。${DSN_HELP}`} className="md:col-span-2">
              <Input mono value={draft.readonly_dsn ?? ""} onChange={(e) => set("readonly_dsn", e.target.value || null)} placeholder="postgresql://ro:${RO_PASSWORD}@host:5432/db" />
            </Field>
            <Field label="环境变量" className="md:col-span-2" error={varsError}
              help="服务级，项目内核与所有进程都带上（进程自己的变量叠加在上面）；值里可以写 {env}。不支持 ${VAR}：口令写进该环境的配置文件">
              <KeyValueEditor value={draft.env_vars} onChange={(v) => set("env_vars", v)} multiline={false} keyPlaceholder="NAME" valuePlaceholder="值，可含 {env}" />
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

        <Section id="processes" icon={<LuServer />} title="进程" description="服务在该环境启用就能按需启停。cmd 里 {python}（该环境的解释器）/{port}/{env} 会按环境替换；每次启动带租约，到期自动停止。">
          <div className="space-y-3">
            {procEntries.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">没有进程：这个服务只读不启停</div>}
            {procEntries.map(([name, p]) => (
              <div key={name} className="rounded-lg border border-line bg-sunken/40 p-3.5">
                <div className="grid gap-3 md:grid-cols-[180px_1fr_auto]">
                  <Field label="名称"><Input mono value={name} onChange={(e) => setProc(name, p, e.target.value.replace(/\s/g, ""))} /></Field>
                  <Field label="启动命令" help="空格分隔；含空格的参数用引号；{python} = 该环境的解释器，如 {python} -m app.server --port {port}">
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

        <Section id="urls" icon={<LuGlobe />} title="地址" description="有名字的地址：线上部署的页面 / API、本机副本的端口……agent 在运行环境里看得到，MCP 配置里用 {url:名字} 引用。可写 {env} 与 {port:进程名}（该进程在这个环境的端口）；各环境的不同地址在下面「环境」里按名字覆盖。">
          <KeyValueEditor value={draft.urls} onChange={(v) => set("urls", v)} multiline={false} keyPlaceholder="名字，如 local / site"
            valuePlaceholder="http://127.0.0.1:{port:server}" suggestions={URL_SUGGESTIONS} />
        </Section>

        <Section id="mcp" icon={<LuPlug />} title="MCP" description="服务自己的 MCP server：{名字: 连接配置}。运行在本服务上时工具自动出现，按运行的环境连接；写了 envs 就只在列出的环境可用（envs.<环境> 里的内容深合并覆盖上面的配置）。">
          <div className="space-y-3">
            <div className="rounded-md bg-sunken px-3 py-2 text-[12px] leading-relaxed text-fg-3">
              字符串里可写 <code className="font-mono">{"{env}"}</code>（运行的环境）、<code className="font-mono">{"{url:名字}"}</code>（上面「地址」里该环境的地址）、
              <code className="font-mono">{"${VAR}"}</code>（连接时从部署机的环境变量 / secrets.env 取值，口令写这里）、
              <code className="font-mono">{"{platform}"}</code>（平台安装目录）、<code className="font-mono">{"{platform_python}"}</code>（平台自己的解释器）。
              工具清单和连接是否成功在服务页的「工具」标签看。
            </div>
            {mcpRows.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-fg-3">没有声明 MCP：这个服务只用角色里的内置工具与平台 MCP</div>}
            {mcpRows.map((r) => (
              <div key={r.id} className="rounded-lg border border-line bg-sunken/40 p-3.5">
                <div className="grid gap-3 md:grid-cols-[200px_1fr_auto]">
                  <Field label="名字" help="连接名形如 服务.名字@环境">
                    <Input mono value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value.trim() })} placeholder="dagster" aria-invalid={!!mcpErr[r.id]?.startsWith("名字") || !!mcpErr[r.id]?.startsWith("重名")} />
                  </Field>
                  <Field label="连接配置（JSON）" error={mcpErr[r.id] ?? null}>
                    <Textarea mono rows={Math.min(18, Math.max(5, r.text.split("\n").length))} value={r.text} spellCheck={false}
                      onChange={(e) => setRow(r.id, { text: e.target.value })} aria-invalid={!!mcpErr[r.id]} />
                  </Field>
                  <div className="flex items-start pt-6"><Button variant="ghost" size="icon-sm" aria-label="删除" onClick={() => setMcpRows(mcpRows.filter((x) => x.id !== r.id))}><LuTrash2 /></Button></div>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" icon={<LuPlus />} onClick={() => addRow("stdio")}>添加 stdio server</Button>
              <Button size="xs" icon={<LuPlus />} onClick={() => addRow("http")}>添加 HTTP server</Button>
            </div>
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
                    <Field label="解释器" help="该环境单独的 Python；空 = 用基本信息里的项目 Python">
                      <Input mono value={o.python ?? ""} onChange={(ev) => setO({ python: ev.target.value.trim() || undefined })} placeholder={draft.python || "python3（继承基座）"} />
                    </Field>
                    <Field label="地址覆盖" className="md:col-span-2" help="按名字覆盖上面「地址」里的同名项，也可以加只有这个环境才有的（如 deployed）">
                      <KeyValueEditor value={o.urls ?? {}} onChange={(v) => setO({ urls: v })} multiline={false} keyPlaceholder="名字"
                        valuePlaceholder={`http://10.0.0.11:3000`} suggestions={Object.keys(draft.urls).filter((k) => !(k in (o.urls ?? {}))).map((k) => ({ key: k, label: k }))} />
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

      <SaveBar visible={dirty} saving={save.pending} onDiscard={discard} label={`保存为 v${svc.version + 1}`}
        onSave={() => {
          const mcpError = Object.entries(mcpErr).map(([id, msg]) => `MCP ${mcpRows.find((r) => r.id === Number(id))?.name || "?"}：${msg}`)[0];
          if (varsError || mcpError) toast.error("还有错误没改", varsError ?? mcpError);
          else save.mutate(undefined);
        }} />
    </div>
  );
}
