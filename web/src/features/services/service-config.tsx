/**
 * 服务定义的结构化编辑器：基本信息 / 只读库 / 配置文件 / 日志 / 地址 / MCP / 环境覆盖 / 档案。
 * 同机部署：定义里写的是线上的代码目录、解释器、配置路径与日志，各环境不同的部分在「环境」里写。
 * 本地草稿 + 未保存提示条；保存 = 新版本，5 秒内热生效。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuDatabase, LuEyeOff, LuFileText, LuGlobe, LuLayers, LuPlug, LuPlus, LuScrollText, LuSettings, LuTrash2,
} from "react-icons/lu";

import { api, useEnvs } from "@/api/hooks";
import type { McpConnection, Service, ServiceEnvOverride, ServiceSummary } from "@/api/types";
import { DatabasesEditor, DatabasesHint } from "@/components/databases";
import { LogsEditor, logsError } from "@/components/logs";
import { SaveBar } from "@/components/save-bar";
import { EnvBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { KeyValueEditor, type KvSuggestion } from "@/components/ui/data";
import { Field, Input, Switch, TagInput, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/overlay";
import { Card, CardHeader } from "@/components/ui/primitives";
import { databasesError } from "@/lib/db";
import { invalidate, useMutation } from "@/lib/query";

export const PROFILE_SUGGESTIONS: KvSuggestion[] = [
  { key: "conventions", label: "口径与术语", placeholder: "如：每个环境一份 settings-{环境}.py；收益按交易日统计" },
  { key: "no_go", label: "禁区", placeholder: "如：不执行 manage.py migrate / crontab add；不在宿主上起 dagster-daemon" },
  { key: "env_notes", label: "环境差异", placeholder: "如：国内生产 172.24.16.100 是 docker 部署（docker-compose.yaml）" },
  { key: "pitfalls", label: "常见坑", placeholder: "如：上游资产没完成会级联失败，先看上游" },
];

/** mcp 单独编辑（每个 server 一段 JSON 文本，保存时才解析），不放进草稿 */
type Draft = Pick<Service, "title" | "description" | "root" | "code_paths" | "python" | "env_vars" | "urls" | "hosts" | "databases" | "configs" | "hidden" | "logs" | "envs" | "profile">;

function toDraft(s: ServiceSummary): Draft {
  return structuredClone({
    title: s.title, description: s.description, root: s.root, code_paths: s.code_paths, python: s.python ?? "",
    env_vars: s.env_vars ?? {}, urls: s.urls ?? {}, hosts: s.hosts, databases: s.databases ?? {}, configs: s.configs ?? [], hidden: s.hidden ?? [],
    logs: s.logs ?? {}, envs: s.envs, profile: s.profile,
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

const URL_SUGGESTIONS: KvSuggestion[] = [
  { key: "site", label: "site 线上页面" }, { key: "deployed", label: "deployed 线上服务" }, { key: "api", label: "api 线上接口" },
];
const PYTHON_HELP = "py 工具（项目内核）用线上这个解释器；可写 {env}、~，空 = python3";

/** 环境变量会出现在内核进程的环境里：不允许 ${VAR}，口令写进给 agent 的配置文件 */
function envVarsError(v: Record<string, string>): string | null {
  const bad = Object.entries(v).filter(([, x]) => x.includes("${")).map(([k]) => k);
  return bad.length ? `不支持 \${VAR}：${bad.join("、")}（口令写进给 agent 用的配置文件）` : null;
}

const absolute = (p: string) => p.startsWith("/") || p.startsWith("~");

/** 路径列表的错误：空、不是绝对路径、重复（与后端 _config_paths 一致） */
function pathsError(paths: string[], label: string): string | null {
  const seen = new Set<string>();
  for (const [i, raw] of paths.entries()) {
    const p = raw.trim();
    if (!p) return `${label}第 ${i + 1} 项：路径不能为空`;
    if (!absolute(p)) return `${label}第 ${i + 1} 项要写绝对路径（可以 ~ 开头）：${p}`;
    if (seen.has(p)) return `${label}第 ${i + 1} 项重复：${p}`;
    seen.add(p);
  }
  return null;
}

/** 一行一个路径的小列表编辑器 */
function PathListEditor({ value, onChange, placeholder, addLabel, empty }: {
  value: string[]; onChange: (v: string[]) => void; placeholder: string; addLabel: string; empty: ReactNode;
}) {
  return (
    <div className="space-y-2">
      {value.length === 0 && <div className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-fg-3">{empty}</div>}
      {value.map((p, i) => {
        const bad = p.trim() && !absolute(p.trim());
        return (
          <div key={i}>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              <Input mono value={p} placeholder={placeholder} aria-invalid={!!bad} spellCheck={false}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="ghost" size="icon-sm" aria-label="删除这一项" onClick={() => onChange(value.filter((_, j) => j !== i))}><LuTrash2 /></Button>
            </div>
            {bad && <div className="mt-0.5 text-xs text-bad">要写绝对路径（可以 ~ 开头）</div>}
          </div>
        );
      })}
      <Button size="xs" icon={<LuPlus />} onClick={() => onChange([...value, ""])}>{addLabel}</Button>
    </div>
  );
}

function Section({ id, icon, title, description, children }: { id: string; icon: ReactNode; title: string; description: ReactNode; children: ReactNode }) {
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
  const dbError = databasesError(draft.databases)
    ?? Object.entries(draft.envs).map(([env, o]) => { const e = databasesError(o.databases, true); return e && `环境 ${env}：${e}`; }).find(Boolean) ?? null;
  const fileError = pathsError(draft.configs, "配置文件") ?? pathsError(draft.hidden, "遮蔽的文件");
  const logError = logsError(draft.logs)
    ?? Object.entries(draft.envs).map(([env, o]) => { const e = logsError(o.logs, true); return e && `环境 ${env}：${e}`; }).find(Boolean) ?? null;
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
      const body = { ...draft, configs: draft.configs.map((p) => p.trim()), hidden: draft.hidden.map((p) => p.trim()), mcp };
      const res = await api.update<ServiceSummary>("services", svc.name, body);
      toast(`已保存为 v${res.version}`, { description: "5 秒内对新运行生效" });
      invalidate("services");
      onSaved();
    } catch (e) {
      toast.error("保存失败", (e as Error).message);
    }
  });

  const allEnvs = envs ?? [];

  return (
    <div className="grid gap-5 lg:grid-cols-[180px_1fr]">
      <nav className="sticky top-4 hidden h-fit space-y-0.5 text-[12.5px] lg:block">
        {[["basic", "基本信息"], ["databases", "只读库"], ["configs", "配置文件"], ["logs", "日志"], ["urls", "地址"], ["mcp", "MCP"], ["envs", "环境"], ["profile", "服务档案"]].map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}
            className="block rounded-md px-2.5 py-1.5 text-fg-2 hover:bg-hover hover:text-fg">{label}</a>
        ))}
      </nav>
      <div className="min-w-0 space-y-4 pb-20">
        <Section id="basic" icon={<LuSettings />} title="基本信息" description="写的是线上实际部署的那份：agent 装在部署主机上，读的就是这里的代码、用的就是这里的解释器。~ 是部署用户的 home（平台和项目是同一个用户），路径可以写 {env}；各环境不同的部分在下面「环境」里覆盖。代码目录也用来校验记忆新鲜度（引用的文件改过即过期）">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名"><Input value={draft.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="代码目录" help="线上部署的代码，agent 只读；可写 {env}、~"><Input mono value={draft.root} placeholder="~/deploy/xxx" onChange={(e) => set("root", e.target.value)} /></Field>
            <Field label="说明" className="md:col-span-2"><Textarea rows={2} value={draft.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <Field label="其他代码目录" help="回车添加；缺省 = 代码目录"><TagInput mono value={draft.code_paths} onChange={(v) => set("code_paths", v)} placeholder="~/deploy/xxx-lib" suggestions={draft.root && !draft.code_paths.includes(draft.root) ? [draft.root] : []} /></Field>
            <Field label="部署主机" help="host_metrics 查监控用；可按环境覆盖"><TagInput mono value={draft.hosts} onChange={(v) => set("hosts", v)} placeholder="172.24.16.100" /></Field>
            <Field label="项目 Python" help={`${PYTHON_HELP}；可按环境覆盖`}>
              <Input mono value={draft.python} onChange={(e) => set("python", e.target.value.trim())} placeholder="~/miniconda3/envs/xxx/bin/python" />
            </Field>
            <Field label="环境变量" className="md:col-span-2" error={varsError}
              help="项目内核带上；值里可以写 {env}。不支持 ${VAR}：口令写进给 agent 的配置文件">
              <KeyValueEditor value={draft.env_vars} onChange={(v) => set("env_vars", v)} multiline={false} keyPlaceholder="NAME" valuePlaceholder="值，可含 {env}" />
            </Field>
          </div>
        </Section>

        <Section id="databases" icon={<LuDatabase />} title="只读库" description="db_query 能查的库：{库名: 连接串}，agent 调用时 db 填库名（只登记了一个时可省略）。各环境在下面「环境」里按库名覆盖，比如生产换成生产库的地址与口令。">
          <div className="space-y-2">
            <DatabasesEditor value={draft.databases} onChange={(v) => set("databases", v)} />
            <DatabasesHint />
          </div>
        </Section>

        <Section id="configs" icon={<LuFileText />} title="配置文件" description={<>项目读配置的路径（绝对路径，可写 ~、{"{env}"}）。<b className="font-medium text-fg-2">受保护的环境（生产）</b>：真实配置平台不读、不显示，agent 也看不到（bash 里被遮蔽）；项目内核启动时，平台把控制台里填的只读版盖在这个路径上——在服务页「配置 → 配置文件」里按环境填。<b className="font-medium text-fg-2">不受保护的环境（测试）</b>：agent 直接用项目的真实配置，不用填。</>}>
          <div className="space-y-4">
            <PathListEditor value={draft.configs} onChange={(v) => set("configs", v)} placeholder="~/deploy/xxx/xxx/settings-{env}.py" addLabel="添加配置文件"
              empty="没有声明配置文件：项目内核用线上代码目录里的默认配置" />
            {draft.configs.some((c) => c.trim() && !c.includes("{env}")) && allEnvs.length > 1 && (
              <div className="text-xs text-fg-3">没写 {"{env}"} 的路径各环境相同；给 agent 的只读版仍按受保护的环境分开填。</div>
            )}
            <div className="border-t border-line pt-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-fg"><LuEyeOff className="size-3.5 text-fg-3" />只遮蔽的文件</div>
              <div className="mb-2 text-xs text-fg-3">代码目录里其他含口令、agent 不该看的文件或目录（比如生成出来的 docker-compose.yaml）：受保护的环境（生产）的运行里 bash 和项目内核都遮蔽，不替换内容；测试的运行里不遮。</div>
              <PathListEditor value={draft.hidden} onChange={(v) => set("hidden", v)} placeholder="~/deploy/xxx/docker-compose.yaml" addLabel="添加遮蔽的文件"
                empty="没有要额外遮蔽的文件" />
            </div>
          </div>
        </Section>

        <Section id="logs" icon={<LuScrollText />} title="日志" description={<>agent 的 logs 工具能读的线上日志：{"{名字: 目标}"}。目标写文件路径（绝对路径，可以 ~ 开头、写 {"{env}"}）或 <code className="font-mono">docker:&lt;容器名&gt;</code>；文件要平台用户有读权限，docker 要平台用户能用 docker。各环境在下面「环境」里按名字覆盖。</>}>
          <LogsEditor value={draft.logs} onChange={(v) => set("logs", v)} />
        </Section>

        <Section id="urls" icon={<LuGlobe />} title="地址" description="有名字的地址：线上部署的页面 / API……agent 在运行环境里看得到，MCP 配置里用 {url:名字} 引用。可写 {env}；各环境的不同地址在下面「环境」里按名字覆盖。">
          <KeyValueEditor value={draft.urls} onChange={(v) => set("urls", v)} multiline={false} keyPlaceholder="名字，如 site / deployed"
            valuePlaceholder="https://xxx.ipa.zs/" suggestions={URL_SUGGESTIONS} />
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

        <Section id="envs" icon={<LuLayers />} title="环境" description="服务在每个环境是否启用，以及和基座不同的部分（只写差异）。">
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
                    <Field label="代码目录" help="这个环境的代码目录不同时才写">
                      <Input mono value={o.root ?? ""} onChange={(ev) => setO({ root: ev.target.value.trim() || undefined })} placeholder={draft.root || "~/deploy/xxx"} />
                    </Field>
                    <Field label="解释器" help="该环境单独的 Python；空 = 用基本信息里的项目 Python">
                      <Input mono value={o.python ?? ""} onChange={(ev) => setO({ python: ev.target.value.trim() || undefined })} placeholder={draft.python || "python3（继承基座）"} />
                    </Field>
                    <Field label="主机"><TagInput mono value={o.hosts ?? []} onChange={(v) => setO({ hosts: v })} placeholder={draft.hosts.join(", ") || "继承基座"} /></Field>
                    <Field label="只读库覆盖" className="md:col-span-2" help="按库名覆盖上面「只读库」里的同名项；连接串留空 = 这个环境没有这个库">
                      <DatabasesEditor value={o.databases ?? {}} onChange={(v) => setO({ databases: v })} base={draft.databases} />
                    </Field>
                    <Field label="日志覆盖" className="md:col-span-2" help="按名字覆盖上面「日志」里的同名项；目标留空 = 这个环境没有这个日志">
                      <LogsEditor value={o.logs ?? {}} onChange={(v) => setO({ logs: v })} base={draft.logs} />
                    </Field>
                    <Field label="地址覆盖" className="md:col-span-2" help="按名字覆盖上面「地址」里的同名项，也可以加只有这个环境才有的（如 deployed）">
                      <KeyValueEditor value={o.urls ?? {}} onChange={(v) => setO({ urls: v })} multiline={false} keyPlaceholder="名字"
                        valuePlaceholder="https://xxx-test.ipa.zs/" suggestions={Object.keys(draft.urls).filter((k) => !(k in (o.urls ?? {}))).map((k) => ({ key: k, label: k }))} />
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

        <Section id="profile" icon={<LuScrollText />} title="服务档案" description="置顶逐字注入该服务的所有运行，不走召回。只记代码和配置里读不出来的事实——能读出来的写进来只会过时。">
          <KeyValueEditor value={draft.profile} onChange={(v) => set("profile", v)} suggestions={PROFILE_SUGGESTIONS} />
        </Section>
      </div>

      <SaveBar visible={dirty} saving={save.pending} onDiscard={discard} label={`保存为 v${svc.version + 1}`}
        onSave={() => {
          const mcpError = Object.entries(mcpErr).map(([id, msg]) => `MCP ${mcpRows.find((r) => r.id === Number(id))?.name || "?"}：${msg}`)[0];
          const first = varsError ?? dbError ?? fileError ?? logError ?? mcpError;
          if (first) toast.error("还有错误没改", first);
          else save.mutate(undefined);
        }} />
    </div>
  );
}
