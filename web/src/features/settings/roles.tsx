/**
 * 角色：可复用的能力（系统提示 + 工具白名单），与服务无关。
 * 继承只收敛不扩张：子角色工具与父角色取交集，提示词追加。
 */
import { useEffect, useMemo, useState } from "react";
import { LuBot, LuHistory, LuLayoutDashboard, LuPlus, LuSettings, LuTriangleAlert } from "react-icons/lu";

import { api, useMeta, useRole, useRoles, useTasks } from "@/api/hooks";
import type { Role } from "@/api/types";
import { Page } from "@/components/layout/shell";
import { SaveBar } from "@/components/save-bar";
import { VersionHistory } from "@/components/versions";
import { Button } from "@/components/ui/button";
import { CodeBlock, Tabs, Table, Td, Th, Tr } from "@/components/ui/data";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Dialog, toast } from "@/components/ui/overlay";
import { Badge, Card, CardHeader, Empty, ErrorState, Skeleton, SkeletonRows } from "@/components/ui/primitives";
import { ago } from "@/lib/format";
import { invalidate, useMutation, useQuery } from "@/lib/query";
import { Link, navigate, useParams, useSearch } from "@/lib/router";
import { SettingsLayout } from "./layout";

export function RolesPage() {
  const { data, loading } = useRoles();
  const { data: tasks } = useTasks();
  const [creating, setCreating] = useState(false);
  return (
    <SettingsLayout title="角色" description="谁来做：系统提示 + 工具白名单。任务指定角色，执行时只拿得到白名单里的工具；工具在运行时绑定到该次的服务×环境。"
      actions={<Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>新建角色</Button>}>
      <Card>
        {loading ? <SkeletonRows /> : !data?.length ? <Empty icon={<LuBot />} title="还没有角色" /> : (
          <Table>
            <thead><tr><Th>角色</Th><Th>工具</Th><Th>继承</Th><Th>被任务使用</Th><Th className="text-right">版本</Th></tr></thead>
            <tbody>
              {data.map((r) => {
                const used = (tasks ?? []).filter((t) => t.role === r.name && !t.extends);
                return (
                  <Tr key={r.name} onClick={() => navigate(`/settings/roles/${r.name}`)}>
                    <Td className="max-w-[360px]">
                      <div className="font-medium text-fg">{r.title || r.name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-fg-3"><span className="font-mono">{r.name}</span> · {r.description}</div>
                    </Td>
                    <Td><div className="flex max-w-[320px] flex-wrap gap-1">{r.tools.map((t) => <Badge key={t} tone="outline" className="font-mono">{t}</Badge>)}</div></Td>
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
        <Field label="角色名" required help="小写字母、数字、下划线" error={name && !valid ? "格式不对" : null}><Input mono autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="ops_analyst" /></Field>
        <Field label="显示名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="运维分析" /></Field>
        <Field label="继承自（可选）" help="继承父角色的提示词与工具；子角色只能收敛工具，不能扩张">
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
  const { data: tasks } = useTasks();
  const { data: resolved } = useQuery(["roles", name, "resolved", role?.version], () => api.resolvedRole(name), { enabled: !!role });
  const tab = s.tab ?? "overview";
  if (error) return <Page><ErrorState error={error} onRetry={refetch} /></Page>;
  const used = (tasks ?? []).filter((t) => t.role === name && !t.extends);
  return (
    <SettingsLayout wide title={<span className="flex items-center gap-2"><LuBot className="size-5 text-fg-3" />{role?.title || name}</span>}
      description={role && <span className="flex flex-wrap items-center gap-x-3"><Link to="/settings/roles" className="text-accent hover:underline">← 全部角色</Link><span className="font-mono">{role.name}</span>{role.extends && <span>继承 <Link to={`/settings/roles/${role.extends}`} className="text-accent hover:underline">{role.extends}</Link></span>}<span>v{role.version} · {role.updated_by} · {ago(role.updated_at)}</span>{role.description && <span>{role.description}</span>}</span>}>
      <Tabs className="mb-5" value={tab} onChange={(v) => setS({ tab: v === "overview" ? undefined : v })} tabs={[
        { value: "overview", label: "概览", icon: <LuLayoutDashboard /> }, { value: "edit", label: "编辑", icon: <LuSettings /> }, { value: "versions", label: "版本", icon: <LuHistory /> },
      ]} />
      {!role ? <Skeleton className="h-96" /> : (
        <>
          {tab === "overview" && (
            <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
              <Card>
                <CardHeader title="生效的系统提示" description={resolved && resolved.lineage.length > 1 ? `沿继承链合并：${resolved.lineage.join(" → ")}` : "执行时作为该角色的系统提示"} />
                <div className="p-4">{resolved ? <CodeBlock code={resolved.prompt} wrap maxHeight={640} /> : <Skeleton className="h-64" />}</div>
              </Card>
              <div className="space-y-4">
                <ToolsCard tools={resolved?.tools ?? role.tools} />
                <Card>
                  <CardHeader title="被这些任务使用" description="改角色会影响它们的下一次运行" />
                  {used.length === 0 ? <div className="px-4 py-4 text-[12.5px] text-fg-3">未被任何任务使用</div> : (
                    <ul className="divide-y divide-line">{used.map((t) => (
                      <li key={t.name}><Link to={`/tasks/${encodeURIComponent(t.name)}`} className="flex items-center gap-2 px-4 py-2 text-[13px] hover:bg-hover/70"><span className="truncate text-fg">{t.title || t.name}</span><span className="ml-auto text-[11.5px] text-fg-3">{t.stats_24h.runs} 次/24h</span></Link></li>
                    ))}</ul>
                  )}
                </Card>
              </div>
            </div>
          )}
          {tab === "edit" && <RoleEditor role={role} onSaved={refetch} />}
          {tab === "versions" && <VersionHistory kind="roles" name={name} onRestored={refetch} />}
        </>
      )}
    </SettingsLayout>
  );
}

function ToolsCard({ tools }: { tools: string[] }) {
  const { data: meta } = useMeta();
  return (
    <Card>
      <CardHeader title="工具白名单" description="运行时绑定到本次的服务×环境，签名里没有服务/环境参数" />
      <ul className="divide-y divide-line">
        {tools.map((t) => {
          const info = meta?.tools.find((x) => x.name === t);
          return (
            <li key={t} className="px-4 py-2">
              <div className="flex items-center gap-2"><code className="font-mono text-[12.5px] text-fg">{t}</code>{info?.dangerous && <Badge tone="warn" icon={<LuTriangleAlert />}>审批</Badge>}</div>
              {info && <div className="mt-0.5 text-[11.5px] text-fg-3">{info.description}</div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function RoleEditor({ role, onSaved }: { role: Role; onSaved: () => void }) {
  const { data: meta } = useMeta();
  const { data: roles } = useRoles();
  const [d, setD] = useState(role);
  useEffect(() => setD(role), [role.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(d) !== JSON.stringify(role);
  const parent = roles?.find((r) => r.name === d.extends);
  const groups = useMemo(() => {
    const g: Record<string, NonNullable<typeof meta>["tools"]> = {};
    for (const t of meta?.tools ?? []) (g[t.group] ??= []).push(t);
    return g;
  }, [meta]);
  const save = useMutation(async () => {
    try {
      const r = await api.update<Role>("roles", role.name, { title: d.title, description: d.description, prompt: d.prompt, tools: d.tools, extends: d.extends, prompt_append: d.prompt_append });
      toast(`已保存为 v${r.version}`, { description: "5 秒内对新运行生效" });
      invalidate("roles");
      onSaved();
    } catch (e) { toast.error("保存失败", (e as Error).message); }
  });
  const GROUP: Record<string, string> = { core: "执行", service: "服务（绑定本次服务×环境）", memory: "记忆", notify: "通知", mcp: "MCP" };
  return (
    <div className="grid gap-4 pb-20 xl:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader title="提示词" />
        <div className="space-y-4 p-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="显示名"><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
            <Field label="继承自"><Select value={d.extends ?? ""} onChange={(v) => setD({ ...d, extends: v || null })} options={[{ value: "", label: "不继承" }, ...(roles ?? []).filter((r) => r.name !== role.name).map((r) => ({ value: r.name, label: r.title || r.name }))]} /></Field>
          </div>
          <Field label="说明" help="一句话：这个角色擅长什么"><Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          {d.extends ? (
            <Field label="追加提示词" help={`接在 ${d.extends} 的提示词之后`}><Textarea mono rows={10} value={d.prompt_append} onChange={(e) => setD({ ...d, prompt_append: e.target.value })} /></Field>
          ) : (
            <Field label="系统提示" help="平台会在它前面自动拼上：服务×环境视图、档案、召回的记忆"><Textarea mono rows={18} value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} /></Field>
          )}
        </div>
      </Card>
      <Card className="h-fit">
        <CardHeader title="工具" description={parent ? `继承：只能在 ${parent.name} 的工具里收敛` : "危险工具调用时命中危险模式会挂起审批"} />
        <div className="space-y-4 p-4">
          {Object.entries(groups).map(([g, list]) => (
            <div key={g}>
              <div className="mb-1 text-[11.5px] font-semibold text-fg-3">{GROUP[g] ?? g}</div>
              {list.map((t) => {
                const allowedByParent = !parent || parent.tools.includes(t.name);
                return (
                  <Checkbox key={t.name} checked={d.tools.includes(t.name)} disabled={!allowedByParent}
                    onChange={(v) => setD({ ...d, tools: v ? [...d.tools, t.name] : d.tools.filter((x) => x !== t.name) })}
                    label={<span className="flex items-center gap-1.5"><code className="font-mono text-[12.5px]">{t.name}</code>{t.dangerous && <LuTriangleAlert className="size-3 text-warn" />}</span>}
                    hint={allowedByParent ? t.description : `父角色没有此工具`} />
                );
              })}
            </div>
          ))}
        </div>
      </Card>
      <SaveBar visible={dirty} saving={save.pending} onDiscard={() => setD(role)} onSave={() => save.mutate(undefined)} label={`保存为 v${role.version + 1}`} />
    </div>
  );
}
