/**
 * 角色：可复用的能力（系统提示 + 工具 + 可委派的子代理），与服务无关。
 *
 * 工具写法：内置工具名 / 平台 MCP 工具名；"*" = 全部内置工具 + 全部平台 MCP 工具；
 * "mcp:<server>" = 某个平台 MCP server 的全部工具（server 来自 meta.tools 的 server 字段）。
 * 服务自己声明的 MCP 不写在这里：service_tools 开着（默认）时，运行在哪个服务上就自动带上哪个服务的。
 * 子代理：运行中按需把子问题交给它，用它自己的提示词和工具独立完成，结论交回（只委派一层）。
 * 继承：写了就替换——子角色写了工具 / 子代理 / 自动带服务工具就整体替换父角色的，没写就跟随；提示词在父角色之后追加。
 */
import { useEffect, useMemo, useState } from "react";
import { LuAsterisk, LuBot, LuHistory, LuInfo, LuLayoutDashboard, LuPlug, LuPlus, LuSettings, LuTrash2, LuTriangleAlert, LuUsers, LuWrench, LuX } from "react-icons/lu";

import { api, useMeta, useRole, useRoles, useTasks } from "@/api/hooks";
import type { Role, ToolInfo } from "@/api/types";
import { Page } from "@/components/layout/shell";
import { SaveBar } from "@/components/save-bar";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/form";
import { Dialog, Tooltip, confirm, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { ago } from "@/lib/format";
import { invalidate, useMutation, useQuery } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { SettingsLayout } from "./layout";

const ALL = "*";
const mcpGroup = (server: string) => `mcp:${server}`;
const isMcpGroup = (t: string) => t.startsWith("mcp:");

/**
 * 运行时自动附带的工具（与后端 agent/tools/catalog.py 的 Toolbox.expand 一致）：
 * 有 bash（或 "*"）就带 read / grep（只读，是 bash 能力的子集）；todo 每个角色都有。不用写进 tools。
 */
const AUTO_TOOLS = ["read", "grep", "todo"];
const hasBash = (tools: string[]) => tools.includes(ALL) || tools.includes("bash");
const autoTools = (tools: string[]) => (hasBash(tools) ? ["read", "grep", "todo"] : ["todo"]);
/** 去掉会自动附带的（展示与保存都不重复列）。有父角色时去完变空就保留原样：空 = 跟随父角色，意思会变 */
function withoutAuto(tools: string[], inherits: boolean): string[] {
  const auto = autoTools(tools);
  const out = tools.filter((t) => !auto.includes(t));
  return out.length || !inherits ? out : tools;
}

/** 继承了 name 的角色（子、孙……）：不能被 name 继承，否则成环 */
function descendantsOf(name: string, roles: Role[]): Set<string> {
  const out = new Set<string>();
  let frontier = [name];
  while (frontier.length) {
    const next = roles.filter((r) => r.extends && frontier.includes(r.extends) && !out.has(r.name) && r.name !== name).map((r) => r.name);
    next.forEach((n) => out.add(n));
    frontier = next;
  }
  return out;
}

const SUBAGENT_HINT = "运行中可以把子问题交给这些角色独立完成，结论交回来（只交一层）";

/** 工具写法的显示："*" 与 "mcp:<server>" 用醒目的标签 */
export function ToolChip({ tool, onRemove }: { tool: string; onRemove?: () => void }) {
  const remove = onRemove && (
    <button type="button" aria-label={`移除 ${tool}`} onClick={onRemove} className="-mr-0.5 text-current opacity-60 hover:opacity-100"><LuX className="size-3" /></button>
  );
  if (tool === ALL) return <Badge tone="accent" icon={<LuAsterisk />}>全部工具 *{remove}</Badge>;
  if (isMcpGroup(tool)) return <Badge tone="info" icon={<LuPlug />} className="font-mono">{tool}{remove}</Badge>;
  return <Badge tone="outline" className="font-mono">{tool}{remove}</Badge>;
}

export function RolesPage() {
  const { data, loading, error, refetch } = useRoles();
  const { data: tasks } = useTasks();
  const [creating, setCreating] = useState(false);
  return (
    <SettingsLayout title="角色" description="角色决定 agent 怎么做事：用什么提示词、能用哪些工具、能把子问题交给谁。"
      actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>新建角色</Button>}>
      <Card>
        {error && !data ? <ErrorState error={error} onRetry={refetch} /> : loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuBot />} title="还没有角色" action={<Button icon={<LuPlus />} onClick={() => setCreating(true)}>新建角色</Button>} /> : (
          <Table>
            <thead><tr><Th>角色</Th><Th>工具</Th><Th>子代理</Th><Th>继承</Th><Th>被任务使用</Th><Th className="text-right">版本</Th></tr></thead>
            <tbody>
              {data.map((r) => {
                const used = (tasks ?? []).filter((t) => t.role === r.name && !t.extends);
                return (
                  <Tr key={r.name} onClick={() => navigate(`/settings/roles/${r.name}`)}>
                    <Td className="max-w-[340px]">
                      <div className="font-medium text-fg">{r.title || r.name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-fg-3"><span className="font-mono">{r.name}</span> · {r.description}</div>
                    </Td>
                    <Td>
                      <div className="flex max-w-[320px] flex-wrap gap-1">
                        {r.tools.length ? withoutAuto(r.tools, !!r.extends).map((t) => <ToolChip key={t} tool={t} />) : <span className="text-[12px] text-fg-3">{r.extends ? `跟随 ${r.extends}` : "无"}</span>}
                        {r.service_tools === false && <Tooltip content="不自动带上服务声明的 MCP 工具"><span><Badge tone="idle">不带服务工具</Badge></span></Tooltip>}
                      </div>
                    </Td>
                    <Td className="text-[12px] text-fg-2">{r.subagents?.length ? <span className="font-mono">{r.subagents.join("、")}</span> : <span className="text-fg-3">—</span>}</Td>
                    <Td className="font-mono text-[12px] text-fg-3">{r.extends ?? "—"}</Td>
                    <Td className="text-[12.5px] text-fg-2">{used.length ? used.map((t) => t.name).join("、") : <span className="text-fg-3">未被使用</span>}</Td>
                    <Td className="text-right text-[12px] text-fg-3">v{r.version} · {ago(r.updated_at)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <CreateRoleDialog open={creating} onClose={() => setCreating(false)} roles={data ?? []} />
    </SettingsLayout>
  );
}

function CreateRoleDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [ext, setExt] = useState("");
  useEffect(() => { if (open) { setName(""); setTitle(""); setExt(""); } }, [open]);
  const valid = /^[a-z][a-z0-9_]{1,40}$/.test(name);
  const create = useMutation(async () => {
    try {
      await api.create("roles", { name, title, extends: ext || null });
      invalidate("roles");
      onClose();
      navigate(`/settings/roles/${name}`);
    } catch (e) { toast.error("创建失败", (e as Error).message); }
  });
  return (
    <Dialog open={open} onClose={onClose} title="新建角色"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={create.pending} onClick={() => create.mutate(undefined)}>创建</Button></>}>
      <div className="space-y-3.5">
        <Field label="角色名" required help="小写字母开头，可含数字、下划线；创建后不可改" error={name && !valid ? "格式不对：小写字母开头，可含数字、下划线" : null}><Input mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="report_checker" /></Field>
        <Field label="显示名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="报表核对" /></Field>
        <Field label="继承自（可选）" help="继承父角色的提示词、工具和子代理；子角色写了哪项就用自己的那项，提示词接在父角色后面">
          <Select value={ext || null} onChange={setExt} placeholder="不继承" options={[{ value: "", label: "不继承" }, ...roles.map((r) => ({ value: r.name, label: r.title || r.name, hint: r.name }))]} />
        </Field>
      </div>
    </Dialog>
  );
}

export function RoleDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [s, setS] = useSearch<{ tab: "overview" | "edit" | "versions" }>();
  const { data: role, error, refetch } = useRole(name);
  const { data: roles } = useRoles();
  const { data: tasks } = useTasks();
  const { data: resolved } = useQuery(["roles", name, "resolved", role?.version], () => api.resolvedRole(name), { enabled: !!role });
  const tab = s.tab ?? "overview";
  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;
  const used = (tasks ?? []).filter((t) => t.role === name && !t.extends);
  const delegatedBy = (roles ?? []).filter((r) => r.name !== name && r.subagents?.includes(name));
  const children = (roles ?? []).filter((r) => r.extends === name);
  const remove = async () => {
    // 页面上知道的引用先列出来；以服务端的检查为准（还有引用时 409 in_use，列出是谁在用）
    const users = [...used.map((t) => `任务 ${t.name}`), ...children.map((r) => `角色 ${r.name}（继承它）`), ...delegatedBy.map((r) => `角色 ${r.name}（把它当子代理）`)];
    const ok = await confirm({
      title: `删除角色 ${name}？`, danger: true, confirmText: "删除", requireText: name,
      description: users.length ? `还有这些在用它，删不掉：${users.join("、")}。先把它们改掉。` : "删除后任务不能再用这个角色；版本记录保留。",
    });
    if (!ok) return;
    try {
      await api.remove("roles", name);
      toast(`已删除角色 ${name}`);
      navigate("/settings/roles", { force: true });
      invalidate("roles");
    } catch (e) { toast.error("删除失败", (e as Error).message); }
  };
  return (
    <SettingsLayout wide title={<span className="flex items-center gap-2"><LuBot className="size-5 text-fg-3" />{role?.title || name}</span>}
      actions={role && <Button variant="danger-ghost" icon={<LuTrash2 />} onClick={remove}>删除角色</Button>}
      description={role && <span className="flex flex-wrap items-center gap-x-3"><Link to="/settings/roles" className="text-accent hover:underline">← 全部角色</Link><span className="font-mono">{role.name}</span>{role.extends && <span>继承 <Link to={`/settings/roles/${role.extends}`} className="text-accent hover:underline">{role.extends}</Link></span>}<span>v{role.version} · {role.updated_by} · {ago(role.updated_at)}</span>{role.description && <span>{role.description}</span>}</span>}>
      <Tabs className="mb-5" value={tab} onChange={(v) => setS({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> }, { value: "edit", label: "编辑", icon: <LuSettings /> }, { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />
      {!role ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && (
            <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
              {/* 不跟右边一起拉高（提示词短时卡片底下不留空），滚动时贴顶 */}
              <Card className="xl:sticky xl:top-0 xl:self-start">
                <CardHeader title="生效的系统提示" description={resolved && resolved.lineage.length > 1 ? `沿继承链合并：${resolved.lineage.join(" → ")}` : "执行时作为该角色的系统提示"} />
                <div className="p-4">{resolved ? <CodeBlock code={resolved.prompt} wrap maxHeight={640} /> : <Skeleton className="h-64" />}</div>
              </Card>
              <div className="space-y-4">
                <ToolsCard tools={resolved?.tools ?? role.tools} serviceTools={resolved?.service_tools ?? role.service_tools ?? true} />
                <SubagentsCard names={resolved?.subagents ?? role.subagents ?? []} roles={roles ?? []} />
                <Card>
                  <CardHeader title="被这些任务使用" description="改角色会影响它们的下一次运行" />
                  {used.length === 0 && delegatedBy.length === 0 ? <div className="px-4 py-4 text-[12.5px] text-fg-3">未被任何任务使用</div> : (
                    <ul className="divide-y divide-line">
                      {used.map((t) => (
                        <li key={t.name}><Link to={`/tasks/${encodeURIComponent(t.name)}`} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-hover/70"><span className="truncate text-fg">{t.title || t.name}</span><span className="ml-auto text-[11.5px] text-fg-3">{t.stats_24h.runs} 次/24h</span></Link></li>
                      ))}
                      {delegatedBy.map((r) => (
                        <li key={r.name}><Link to={`/settings/roles/${r.name}`} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-hover/70"><LuUsers className="size-3.5 text-fg-3" /><span className="truncate text-fg">{r.title || r.name}</span><span className="ml-auto text-[11.5px] text-fg-3">把它当子代理</span></Link></li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>
          )}
          {tab === "edit" && <RoleEditor role={role} onSaved={refetch} />}
          {tab === "versions" && <VersionHistory kind="roles" name={name} onRestored={refetch} stats />}
        </>
      )}
    </SettingsLayout>
  );
}

/** 生效工具：把 "*" 与 "mcp:<server>" 展开说明 */
function ToolsCard({ tools, serviceTools }: { tools: string[]; serviceTools: boolean }) {
  const { data: meta } = useMeta();
  const mcpOf = (server: string) => (meta?.tools ?? []).filter((t) => t.group === "mcp" && t.server === server).map((t) => t.name);
  // 自动附带的只在下面「附带」那一行列一次
  const auto = autoTools(tools);
  const listed = tools.filter((t) => !auto.includes(t));
  return (
    <Card>
      <CardHeader title="生效的工具" description="运行时只作用于这次运行的服务和环境" />
      <ul className="divide-y divide-line">
        {listed.length === 0 && <li className="px-4 py-3 text-[12.5px] text-fg-3">没有工具</li>}
        {listed.map((t) => {
          const info = meta?.tools.find((x) => x.name === t);
          const members = isMcpGroup(t) ? mcpOf(t.slice(4)) : [];
          return (
            <li key={t} className="px-4 py-2">
              <div className="flex items-center gap-2">
                {t === ALL || isMcpGroup(t) ? <ToolChip tool={t} /> : <code className="font-mono text-[12.5px] text-fg">{t}</code>}
                {info?.dangerous && <Tooltip content="会改动东西：执行命令、跑项目代码"><span><Badge tone="warn" icon={<LuTriangleAlert />}>有副作用</Badge></span></Tooltip>}
              </div>
              <div className="mt-0.5 text-[11.5px] text-fg-3">
                {t === ALL ? "全部内置工具 + 全部平台 MCP 工具"
                  : isMcpGroup(t) ? (members.length ? `平台 MCP server ${t.slice(4)} 的全部工具：${members.join("、")}` : `平台 MCP server ${t.slice(4)} 的全部工具（部署配置里没配这个 server 时忽略）`)
                    : info?.description ?? "部署里没有这个工具，运行时忽略"}
              </div>
            </li>
          );
        })}
        <li className="flex items-center gap-2 px-4 py-2.5 text-[12px]">
          <LuWrench className="size-3.5 text-fg-3" />
          <span className="text-fg-2">附带</span>
          <code className="font-mono text-fg">{auto.join(" · ")}</code>
          <span className="text-fg-3">· {hasBash(tools) ? "有 bash 就带 read / grep；" : ""}每个角色都有待办清单，不用写</span>
        </li>
        <li className="flex items-center gap-2 px-4 py-2.5 text-[12px]">
          <LuPlug className="size-3.5 text-fg-3" />
          <span className="text-fg-2">服务工具</span>
          <span className={serviceTools ? "text-ok" : "text-fg-3"}>{serviceTools ? "自动带上" : "不带"}</span>
          <span className="text-fg-3">· 运行所在服务声明的 MCP 工具</span>
        </li>
      </ul>
    </Card>
  );
}

function SubagentsCard({ names, roles }: { names: string[]; roles: Role[] }) {
  return (
    <Card>
      <CardHeader title="子代理" icon={<LuUsers />} description={SUBAGENT_HINT} />
      {names.length === 0 ? <div className="px-4 py-3 text-[12.5px] text-fg-3">没有子代理：所有事都自己做</div> : (
        <ul className="divide-y divide-line">
          {names.map((n) => {
            const r = roles.find((x) => x.name === n);
            return (
              <li key={n}>
                <Link to={`/settings/roles/${n}`} className="block px-4 py-2 hover:bg-hover/70">
                  <div className="flex items-center gap-2 text-[13px]"><span className="text-fg">{r?.title || n}</span><span className="font-mono text-[11.5px] text-fg-3">{n}</span>{!r && <Badge tone="bad">不存在</Badge>}</div>
                  {r?.description && <div className="mt-0.5 text-[11.5px] text-fg-3">{r.description}</div>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const GROUP: Record<string, string> = { core: "执行", service: "服务（只作用于这次运行的服务和环境）", memory: "记忆", notify: "通知", mcp: "平台 MCP" };

function RoleEditor({ role, onSaved }: { role: Role; onSaved: () => void }) {
  const { data: meta } = useMeta();
  const { data: roles } = useRoles();
  /** 有父角色时 null = 跟随父角色；没有父角色时 null 就是默认值（无子代理 / 带服务工具）。会自动附带的工具不放进草稿（保存时也就不写） */
  const pick = (r: Role) => {
    const base = { ...r, tools: withoutAuto(r.tools, !!r.extends) };
    return r.extends ? base : { ...base, subagents: r.subagents ?? [], service_tools: r.service_tools ?? true };
  };
  const [d, setD] = useState(() => pick(role));
  useEffect(() => setD(pick(role)), [role.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(pick(role));
  const parent = roles?.find((r) => r.name === d.extends);
  const { data: parentResolved } = useQuery(["roles", d.extends, "resolved"], () => api.resolvedRole(d.extends!), { enabled: !!d.extends });

  /** 内置工具按 group 分组；平台 MCP 工具再按 server 分组 */
  const { groups, servers } = useMemo(() => {
    const g: Record<string, ToolInfo[]> = {};
    const s: Record<string, ToolInfo[]> = {};
    for (const t of meta?.tools ?? []) {
      if (t.group === "mcp") (s[t.server || "其他"] ??= []).push(t);
      else (g[t.group] ??= []).push(t);
    }
    return { groups: g, servers: s };
  }, [meta]);

  const all = d.tools.includes(ALL);
  const has = (t: string) => d.tools.includes(t);
  /** 勾上 bash 后 read / grep 变成自动附带：从清单里拿掉，免得重复 */
  const setTools = (tools: string[]) => setD({ ...d, tools: withoutAuto(tools, !!d.extends) });
  const toggle = (t: string, on: boolean) => setTools(on ? [...d.tools.filter((x) => x !== t), t] : d.tools.filter((x) => x !== t));
  /** 勾"全部"就只留 "*"；整组选某个 server 就去掉该组里单独勾的工具 */
  const setAll = (on: boolean) => setTools(on ? [ALL] : d.tools.filter((x) => x !== ALL));
  const auto = autoTools(d.tools);
  /** 自动附带的工具：勾选状态跟着 bash / *，不能单独勾掉。没有 bash 时 read / grep 可以单独选（只读角色） */
  const autoHint = (t: string) => (t === "todo" ? "每个角色都有，不用选" : "有 bash 就自动带上");
  const setGroup = (server: string, on: boolean) => {
    const members = (servers[server] ?? []).map((t) => t.name);
    setTools(on ? [...d.tools.filter((x) => !members.includes(x) && x !== mcpGroup(server)), mcpGroup(server)] : d.tools.filter((x) => x !== mcpGroup(server)));
  };
  const subs = d.subagents ?? [];
  const followSubs = !!d.extends && d.subagents === null;
  const toggleSub = (n: string, on: boolean) => setD({ ...d, subagents: on ? [...subs, n] : subs.filter((x) => x !== n) });
  const serviceTools = d.service_tools ?? parentResolved?.service_tools ?? true;

  const save = useMutation(async () => {
    try {
      const r = await api.update<Role>("roles", role.name, {
        title: d.title, description: d.description, prompt: d.prompt, tools: d.tools, subagents: d.subagents, service_tools: d.service_tools,
        extends: d.extends, prompt_append: d.prompt_append,
      });
      toast(`已保存为 v${r.version}`, { description: "5 秒内对新运行生效" });
      invalidate("roles");
      onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });

  const others = (roles ?? []).filter((r) => r.name !== role.name);
  /** 能继承的：不能是自己，也不能是继承了自己的（成环） */
  const descendants = descendantsOf(role.name, roles ?? []);
  const parents = others.filter((r) => !descendants.has(r.name));
  /** 继承开关变了：提示词、工具的意思跟着变 */
  const extendsSwitched = !!d.extends !== !!role.extends;
  const toolsHint = parent
    ? d.tools.length ? `写了就替换：只用这里选的，不再跟随 ${parent.name}` : `没选 = 跟随 ${parent.name}${parentResolved ? `（${parentResolved.tools.join("、") || "无"}）` : ""}`
    : "标 ⚠ 的工具会改动东西（执行命令、跑项目代码），只给需要的角色";

  return (
    <div className="grid gap-4 pb-20 xl:grid-cols-[1fr_400px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="提示词" />
          <div className="space-y-4 p-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="显示名"><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
              <Field label="继承自" help={descendants.size ? `子角色写了哪项就用自己的，没写的跟随父角色。${[...descendants].join("、")} 继承了它，不能选` : "子角色写了哪项就用自己的，没写的跟随父角色"}>
                <Select value={d.extends ?? ""} onChange={(v) => setD({ ...d, extends: v || null })} options={[{ value: "", label: "不继承" }, ...parents.map((r) => ({ value: r.name, label: r.title || r.name, hint: r.name }))]} />
              </Field>
            </div>
            {extendsSwitched && (
              <div className="flex gap-2 rounded-md bg-info-soft px-3 py-2 text-[12.5px] text-info">
                <LuInfo className="mt-0.5 size-4 shrink-0" />
                <span>{d.extends
                  ? `改成继承 ${d.extends} 后：「系统提示」不再生效，改用「追加提示词」接在 ${d.extends} 的提示词后面（原来的系统提示还留在定义里，只是不用）；工具不选就跟随 ${d.extends}。`
                  : `改成不继承后：「追加提示词」不再生效，改用「系统提示」${d.prompt.trim() ? "" : "（现在还是空的，记得写上）"}；工具不选就是没有工具。`}</span>
              </div>
            )}
            <Field label="说明" help="一句话：这个角色擅长什么。别的角色把它当子代理时，看这句话决定要不要委派"><Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
            {d.extends ? (
              <Field label="追加提示词" help={`接在 ${d.extends} 的提示词之后`}><Textarea mono rows={10} value={d.prompt_append} onChange={(e) => setD({ ...d, prompt_append: e.target.value })} /></Field>
            ) : (
              <Field label="系统提示" help={<>前面会接上平台基础约定（<Link to="/settings/prompts" className="text-accent hover:underline">设置 → 提示词</Link>）；服务信息、档案和记忆由平台另外带上</>}><Textarea mono rows={18} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} /></Field>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="子代理" icon={<LuUsers />} description={<>{SUBAGENT_HINT}。{parent ? `写了就替换 ${parent.name} 的子代理。` : ""}</>} />
          <div className="p-4">
            {d.extends && (
              <div className="mb-3">
                <Switch checked={followSubs} onChange={(on) => setD({ ...d, subagents: on ? null : [...(parentResolved?.subagents ?? [])] })}
                  label={<span>跟随 {d.extends}<span className="ml-1.5 text-[11.5px] text-fg-3">{parentResolved ? (parentResolved.subagents.join("、") || "没有子代理") : ""}</span></span>} />
              </div>
            )}
            {followSubs ? null : others.length === 0 ? <div className="text-[12.5px] text-fg-3">没有别的角色可选</div> : (
              <div className="grid gap-x-4 sm:grid-cols-2">
                {others.map((r) => (
                  <Checkbox key={r.name} checked={subs.includes(r.name)} onChange={(v) => toggleSub(r.name, v)}
                    label={<span className="flex items-center gap-1.5">{r.title || r.name}<code className="font-mono text-[11.5px] text-fg-3">{r.name}</code></span>}
                    hint={r.description || undefined} />
                ))}
              </div>
            )}
            {subs.filter((n) => !others.some((r) => r.name === n)).map((n) => (
              <div key={n} className="mt-2 flex items-center gap-2 text-[12px] text-bad">角色 <code className="font-mono">{n}</code> 不存在
                <Button size="xs" variant="ghost" onClick={() => toggleSub(n, false)}>移除</Button></div>
            ))}
          </div>
        </Card>
      </div>
      <Card className="h-fit">
        <CardHeader title="工具" description={toolsHint} />
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-1.5 text-[11.5px] font-semibold text-fg-3">已选</div>
            <div className="flex flex-wrap gap-1">
              {d.tools.length === 0 ? <span className="text-[12px] text-fg-3">{parent ? `跟随 ${parent.name}` : "还没选"}</span>
                : d.tools.map((t) => <ToolChip key={t} tool={t} onRemove={() => toggle(t, false)} />)}
            </div>
            {!(parent && d.tools.length === 0) && (
              <div className="mt-1.5 text-[11.5px] text-fg-3">自动附带：<code className="font-mono">{auto.join(" · ")}</code>（不用选）</div>
            )}
          </div>
          <Checkbox checked={all} onChange={setAll}
            label={<span className="flex items-center gap-1.5 font-medium">全部<code className="font-mono text-[12px] text-fg-3">*</code></span>}
            hint="全部内置工具 + 全部平台 MCP 工具（通用角色用）" />
          {Object.entries(groups).map(([g, list]) => (
            <div key={g}>
              <div className="mb-1 text-[11.5px] font-semibold text-fg-3">{GROUP[g] ?? g}</div>
              {list.map((t) => {
                // 自动附带的（todo；有 bash 时的 read / grep）：锁住，勾选状态跟着 bash / *，不写进 tools
                const locked = AUTO_TOOLS.includes(t.name) && auto.includes(t.name);
                return (
                  <Checkbox key={t.name} checked={all || locked || has(t.name)} disabled={all || locked} onChange={(v) => toggle(t.name, v)}
                    label={<span className="flex items-center gap-1.5"><code className="font-mono text-[12.5px]">{t.name}</code>{t.dangerous && <LuTriangleAlert className="size-3 text-warn" />}
                      {locked && <Badge tone="outline">自动附带</Badge>}</span>}
                    hint={locked ? `${autoHint(t.name)} · ${t.description}` : t.description} />
                );
              })}
            </div>
          ))}
          {Object.keys(servers).length > 0 && (
            <div>
              <div className="mb-1 text-[11.5px] font-semibold text-fg-3">{GROUP.mcp}<span className="ml-1 font-normal">（部署配置里的 MCP server，所有服务通用）</span></div>
              <div className="space-y-2">
                {Object.entries(servers).map(([server, list]) => {
                  const whole = server !== "其他" && has(mcpGroup(server));
                  return (
                    <div key={server} className="rounded-md border border-line px-2.5 py-1.5">
                      {server !== "其他" ? (
                        <Checkbox checked={all || whole} disabled={all} onChange={(v) => setGroup(server, v)}
                          label={<span className="flex items-center gap-1.5"><LuPlug className="size-3.5 text-fg-3" />整组<code className="font-mono text-[12.5px]">{mcpGroup(server)}</code></span>}
                          hint={`${server} 的全部 ${list.length} 个工具，以后新增的也自动带上`} />
                      ) : <div className="py-1 text-[12px] text-fg-3">未标明 server 的 MCP 工具</div>}
                      <div className="pl-6">
                        {list.map((t) => (
                          <Checkbox key={t.name} checked={all || whole || has(t.name)} disabled={all || whole} onChange={(v) => toggle(t.name, v)}
                            label={<code className="font-mono text-[12.5px]">{t.name}</code>} hint={t.description} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-2 border-t border-line pt-3">
            {d.extends && (
              <Switch checked={d.service_tools === null} onChange={(on) => setD({ ...d, service_tools: on ? null : serviceTools })}
                label={<span>服务工具跟随 {d.extends}<span className="ml-1.5 text-[11.5px] text-fg-3">{parentResolved ? (parentResolved.service_tools ? "带上" : "不带") : ""}</span></span>} />
            )}
            <Switch checked={serviceTools} disabled={!!d.extends && d.service_tools === null} onChange={(service_tools) => setD({ ...d, service_tools })}
              label={<span>自动带上服务工具<span className="ml-1.5 text-[11.5px] text-fg-3">运行在哪个服务上就带上它声明的 MCP 工具</span></span>} />
          </div>
        </div>
      </Card>
      <SaveBar visible={dirty} saving={save.pending} onDiscard={() => setD(pick(role))} onSave={() => save.mutate(undefined)} label={`保存为 v${role.version + 1}`} />
    </div>
  );
}

