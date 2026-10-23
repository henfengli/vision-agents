/**
 * mock 代码同步与配置文件：每个服务一段仓库提交历史；每个 服务×环境 的当前提交、远端最近一次检查（代码跟踪）、
 * 同步步骤上次结果、配置文件的上游核对到了哪一版，以及配置文件的真实内容与备份。
 * sync() 走和后端 CodeSync.sync 一样的流程：拉取 → 步骤（when 变了才跑，shared 的按解释器只做一次；force 全部重跑）→ 配置上游 → 重启。
 *
 * 种子按时间回放：
 * - vision-board：26 小时前代码跟踪把三个环境同步到 B2（升级依赖，共享的「安装依赖」只装一次；dev 收集静态资源失败）；
 *   约 1 小时前发现 B3（vision_board/settings.py 加了 CHROME_BIN → 各环境的 settings 待更新），prod / test 同步成功，dev 拉取失败、落后远端；
 *   40 分钟前 liyd 按上游改了 test 的 settings（保存即核对），prod 的还没人处理。
 * - vision-dagster：30 小时前 D2 在 .env.template 里加了 doris 接口 → 三个环境的 .env 待更新；18 小时前 gaodl 改了 test 的 .env；
 *   20 小时前 D3 修了子账户映射（只改代码，不跑步骤）。
 * - vision-web：6 天前同步到 W1，之后远端没有新提交。
 */
import { ApiError } from "../client";
import type { ConfigRaw, ConfigSaved, ConfigUpstream, ConfigVersion, Run, RunEvent, RunStatus, Service, SyncStatus, SyncStep } from "../types";
import * as db from "./data";

type StepLast = NonNullable<SyncStatus["steps"][number]["last"]>;

const { HOUR, MIN, DAY, NOW } = db;
const isoAt = (ms: number) => new Date(ms).toISOString();
const render = (path: string, env: string) => path.replaceAll("{env}", env);
const pythonOf = (s: Service, env: string) => render(s.envs[env]?.python || s.python || "python3", env);
const rootOf = (s: Service, env: string) => render(s.root, env);
const branchOf = (s: Service, env: string) => s.envs[env]?.ref || s.ref || "（远端默认分支）";
const envEnabled = (s: Service, env: string) => s.enabled && s.envs[env]?.enabled !== false;
const label = (st: SyncStep) => st.title || st.run.join(" ").slice(0, 60);
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** 仓库内路径的 glob（** 跨目录） */
function globRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
const matches = (file: string, patterns: string[]) => patterns.some((p) => globRe(p).test(file));

/** 内容摘要（和后端一样是 16 位十六进制） */
function sha(text: string): string {
  let a = 0x811c9dc5, b = 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

// ———————— 仓库 ————————

interface Commit { sha: string; subject: string; author: string; at: string; files: string[]; diffs?: Record<string, string> }
interface Repo { files: string[]; commits: Commit[] }     // 提交旧的在前；最后一个是远端分支现在的提交

const commit = (sha: string, subject: string, author: string, msAgo: number, files: string[], diffs?: Record<string, string>): Commit =>
  ({ sha, subject, author, at: db.iso(msAgo), files, diffs });

const BOARD_FILES = ["manage.py", "requirements.txt", "check_deps.py", "README.md", "vision_board/__init__.py", "vision_board/settings.py", "vision_board/urls.py",
  "report/__init__.py", "report/views.py", "report/pnl.py", "report/strategy.py", "report/static/report/css/report.css", "report/static/report/js/chart.js",
  "templates/report/pnl_daily.html", "templates/report/strategy_weekly.html", "scripts/export_html.py"];
const BOARD_SETTINGS_DIFF = `--- a/vision_board/settings.py
+++ b/vision_board/settings.py
@@ -118,6 +118,9 @@ STATIC_URL = "/static/"
 STATIC_ROOT = BASE_DIR / "static"
 CRONTAB_COMMAND_PREFIX = "DJANGO_SETTINGS_MODULE=vision_board.settings"
+
+# 离线 HTML 导出：Chrome headless 的路径（每台机器不同，部署时改）
+CHROME_BIN = "/usr/bin/google-chrome"`;
const DAGSTER_FILES = ["pyproject.toml", "setup.py", ".env.template", "dagster.template.yaml", "docker-compose.template.yaml", "vision_dagster/__init__.py",
  "vision_dagster/assets/fills.py", "vision_dagster/assets/positions.py", "vision_dagster/assets/pnl.py", "vision_dagster/jobs.py", "vision_dagster/sensors.py",
  "vision_dagster_tests/test_pnl.py", "scripts/backfill.py", "notebooks/pnl_check.ipynb"];
const DAGSTER_ENV_DIFF = `--- a/.env.template
+++ b/.env.template
@@ -4,3 +4,8 @@ CK_HOST=
 CK_PORT=8123
 CK_USER=
 CK_PASSWORD=
+# Doris（新接入的成交明细库，MySQL 协议）
+DORIS_HOST=
+DORIS_PORT=9030
+DORIS_USER=
+DORIS_PASSWORD=`;
const WEB_FILES = ["manage.py", "requirements.txt", "vision_web/__init__.py", "vision_web/settings.py", "vision_web/urls.py", "vision_cfg/models.py", "vision_cfg/views.py",
  "vision_cfg/api.py", "static/css/cfg.css", "docs/api.md", "scripts/export_cfg.py"];

const B = ["3f2a9c1e0b7d4a5f8e6c2b1a9d8e7f6a5b4c3d2e", "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "5e6f7a8b9c0d1e2f3a4b5c6d7e8f901234567890", "e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e"];
const D = ["0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e", "8d02b7f1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3", "52be0aa3b5d7f9b1d3f5b7d9f1b3d5f7b9d1f3b5", "c41e9a2d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a39"];
const W = ["1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5", "9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b"];

const REPOS: Record<string, Repo> = {
  "vision-board": {
    files: BOARD_FILES,
    commits: [
      commit(B[0], "init: 报表展示系统（Django）", "liyd", 60 * DAY, BOARD_FILES),
      commit(B[1], "feat: 策略周报加收益率曲线", "wangzh", 3 * DAY, ["report/strategy.py", "templates/report/strategy_weekly.html", "report/static/report/js/chart.js"]),
      commit(B[2], "chore: 升级 Django 4.2.16，加 django-crontab", "liyd", 26 * HOUR + 20 * MIN, ["requirements.txt", "report/static/report/css/report.css"]),
      commit(B[3], "feat: 离线 HTML 导出改用 Chrome headless（settings 加 CHROME_BIN）", "wangzh", 75 * MIN,
        ["vision_board/settings.py", "scripts/export_html.py", "templates/report/pnl_daily.html"], { "vision_board/settings.py": BOARD_SETTINGS_DIFF }),
    ],
  },
  "vision-dagster": {
    files: DAGSTER_FILES,
    commits: [
      commit(D[0], "init: vision dagster 资产", "gaodl", 120 * DAY, DAGSTER_FILES),
      commit(D[1], "feat: 成交回报接入子账户", "wangzh", 12 * DAY, ["vision_dagster/assets/fills.py", "vision_dagster/assets/pnl.py"]),
      commit(D[2], "chore: 加 doris 接口配置", "gaodl", 30 * HOUR, [".env.template", "pyproject.toml"], { ".env.template": DAGSTER_ENV_DIFF }),
      commit(D[3], "fix: account_pnl_daily 先映射子账户", "gaodl", 20 * HOUR, ["vision_dagster/assets/pnl.py", "vision_dagster_tests/test_pnl.py"]),
    ],
  },
  "vision-web": {
    files: WEB_FILES,
    commits: [
      commit(W[0], "init: 配置管理系统（vision_cfg）", "liyd", 200 * DAY, WEB_FILES),
      commit(W[1], "feat: 组合配置加风控参数", "wangzh", 6 * DAY + 3 * HOUR, ["vision_cfg/models.py", "vision_cfg/views.py", "static/css/cfg.css"]),
    ],
  },
};

const repoOf = (s: Service): Repo | undefined => (s.repo ? REPOS[s.name] : undefined);
const indexOf = (repo: Repo, sha: string) => repo.commits.findIndex((c) => c.sha === sha);
const latest = (repo: Repo) => repo.commits[repo.commits.length - 1].sha;

/** when 文件在某个提交的"内容摘要"：那之前最后一次改到它们的提交；仓库里一个都没有 → null */
function digestAt(repo: Repo, at: string, patterns: string[]): string | null {
  if (!repo.files.some((f) => matches(f, patterns))) return null;
  for (let i = indexOf(repo, at); i >= 0; i--) if (repo.commits[i].files.some((f) => matches(f, patterns))) return repo.commits[i].sha;
  return null;
}

function diffBetween(repo: Repo, from: string, to: string, file: string): string {
  const parts = repo.commits.slice(indexOf(repo, from) + 1, indexOf(repo, to) + 1).map((c) => c.diffs?.[file]).filter(Boolean);
  return parts.length ? parts.join("\n") : `--- a/${file}\n+++ b/${file}\n（mock 没有这段 diff）`;
}

// ———————— 状态 ————————

const heads = new Map<string, string>();                                              // 服务@环境 → 当前提交
const remotes = new Map<string, { commit: string; checked_at: string }>();            // 服务@环境 → 代码跟踪最近一次看到的远端
const stepState = new Map<string, { digest: string | null; detail: StepLast }>();     // 服务|范围|步骤 → 上次成功时的 when 摘要 + 上次结果
const acked = new Map<string, { commit: string; at: string; by: string; notified?: string }>();   // 服务@环境|固定路径 → 已核对的上游版本

const stepKey = (s: Service, env: string, st: SyncStep) =>
  `${s.name}|${st.shared ? "python:" + pythonOf(s, env) : env}|${JSON.stringify([st.run, st.when])}`;

/** 配置文件 + 上游（不写时固定路径在代码目录里就是它自己） */
export function configEntries(s: Service, env: string): { path: string; canonical: string; upstream: string }[] {
  const root = rootOf(s, env).replace(/\/$/, "");
  return s.configs.map((c) => {
    const canonical = render(c.canonical, env);
    return { path: render(c.template, env), canonical, upstream: c.upstream || (canonical.startsWith(root + "/") ? canonical.slice(root.length + 1) : "") };
  });
}

function entry(s: Service, env: string, path: string) {
  const c = configEntries(s, env).find((x) => path === x.path || path === x.canonical);
  if (!c) throw new ApiError(404, "not_found", `${path} 不是服务 ${s.name} 在 ${env} 声明的配置文件`);
  return c;
}

/** 声明了上游（且仓库里有）的配置文件：上游自上次核对以来变了没有。第一次见到时以当前为准 */
function configStates(s: Service, env: string, o: { at?: number; onOutdated?: (c: ConfigUpstream) => void } = {}): ConfigUpstream[] {
  const repo = repoOf(s);
  const head = heads.get(`${s.name}@${env}`);
  if (!repo || !head) return [];
  const out: ConfigUpstream[] = [];
  for (const c of configEntries(s, env)) {
    if (!c.upstream || !repo.files.includes(c.upstream)) continue;
    const blob = digestAt(repo, head, [c.upstream])!;
    const key = `${s.name}@${env}|${c.canonical}`;
    const last = acked.get(key);
    const item: ConfigUpstream = { ...c, pending: false };
    if (!last) acked.set(key, { commit: blob, at: isoAt(o.at ?? Date.now()), by: "初次同步" });
    else if (last.commit !== blob) {
      Object.assign(item, { pending: true, diff: diffBetween(repo, last.commit, blob, c.upstream), since: last.at });
      if (o.onOutdated && last.notified !== blob) { last.notified = blob; o.onOutdated(item); }
    }
    out.push(item);
  }
  return out;
}

export function headOf(s: Service, env: string): Commit | null {
  const repo = repoOf(s);
  const head = heads.get(`${s.name}@${env}`);
  return repo && head ? repo.commits[indexOf(repo, head)] ?? null : null;
}

/** GET /v1/services/{s}/envs/{env}/sync */
export function status(s: Service, env: string): SyncStatus {
  if (!db.envs.some((e) => e.name === env)) throw new ApiError(404, "unknown_env", `环境 ${env} 不存在`);
  const repo = repoOf(s);
  const head = headOf(s, env);
  const remote = remotes.get(`${s.name}@${env}`) ?? null;
  return {
    service: s.name, env, enabled: envEnabled(s, env), auto: s.sync.auto, repo: s.repo, dir: rootOf(s, env), branch: branchOf(s, env),
    head: head ? { commit: head.sha, short: head.sha.slice(0, 7), subject: head.subject, author: head.author, committed_at: head.at } : null,
    remote, behind: !!(remote && head && remote.commit !== head.sha),
    steps: s.sync.steps.map((st) => {
      const rec = stepState.get(stepKey(s, env, st));
      const digest = repo && head ? digestAt(repo, head.sha, st.when) : null;
      return { title: label(st), when: st.when, shared: st.shared, pending: digest !== null && (!rec || rec.digest !== digest), last: rec?.detail ?? null };
    }),
    configs: configStates(s, env),
  };
}

// ———————— 一次同步 ————————

/** 步骤的输出与耗时（按命令猜一个像样的） */
function stepRun(st: SyncStep, s: Service, env: string, ok: boolean, quick: boolean): { output: string; ms: number } {
  const argv = st.run.join(" ");
  const py = pythonOf(s, env);
  const site = py.replace(/\/bin\/python$/, "") + "/lib/python3.12/site-packages";
  const pick = (full: number) => (quick ? 300 + (full % 700) : full);
  if (argv.includes("pip") && argv.includes("-r")) return { ms: pick(38_400), output: [
    "Collecting Django==4.2.16 (from -r requirements.txt (line 1))",
    "  Downloading Django-4.2.16-py3-none-any.whl (8.0 MB)",
    "Collecting django-crontab==0.7.1 (from -r requirements.txt (line 4))",
    "  Downloading django_crontab-0.7.1.tar.gz (7.9 kB)",
    `Requirement already satisfied: clickhouse-driver==0.2.9 in ${site} (0.2.9)`,
    "Installing collected packages: django-crontab, Django",
    "  Attempting uninstall: Django",
    "    Found existing installation: Django 4.2.11",
    "    Successfully uninstalled Django-4.2.11",
    "Successfully installed Django-4.2.16 django-crontab-0.7.1",
  ].join("\n") };
  if (argv.includes("pip") && argv.includes("-e")) return { ms: pick(21_600), output: `Obtaining file://${rootOf(s, env)}\n  Installing build dependencies ... done\n  Getting requirements to build editable ... done\nRequirement already satisfied: dagster==1.8.12 in ${site} (1.8.12)\nSuccessfully installed ${s.name.replace("-", "_")}-0.4.2` };
  if (argv.includes("collectstatic")) return ok
    ? { ms: pick(4_200), output: `14 static files copied to '/srv/svc/${s.name}/static/${env}', 203 unmodified.` }
    : { ms: pick(2_900), output: [
      "Traceback (most recent call last):",
      `  File "${rootOf(s, env)}/manage.py", line 22, in <module>`,
      "    main()",
      "  …",
      `PermissionError: [Errno 13] Permission denied: '/srv/svc/${s.name}/static/${env}/report/css/report.css'`,
    ].join("\n") };
  return { ms: pick(1_500), output: ok ? "完成" : "失败" };
}

interface Outcome { status: RunStatus; events: RunEvent[]; output: Run["output"]; errorCode?: string; finishedAt: number }

function sync(s: Service, env: string, o: { at: number; runId: string; target?: string; fail?: string[]; fetchError?: string; quick?: boolean; force?: boolean }): Outcome {
  let t = o.at;
  const events: RunEvent[] = [];
  const push = (kind: RunEvent["kind"], payload: RunEvent["payload"], dt: number) => {
    t += dt;
    events.push({ seq: events.length + 1, kind, at: isoAt(t), payload });
  };
  const reject = (message: string, code: string): Outcome => {
    push("error", { content: message }, 400);
    return { status: "failed", events, output: { error: message }, errorCode: code, finishedAt: t };
  };
  push("stage", { stage: "prepare", title: "准备", content: "内建处理器 code-sync" + (o.force ? " · 强制重跑所有同步步骤" : "") }, 120);
  const repo = repoOf(s);
  if (!repo) return reject(`服务 ${s.name} 没有配置 repo（git 远端）`, "code_sync_failed");
  if (o.fetchError) return reject(`git fetch --quiet 失败：${o.fetchError}`, "code_sync_failed");

  // 拉取：对齐到跟踪分支（mock 的远端就是仓库的最后一个提交）
  const key = `${s.name}@${env}`;
  const dir = rootOf(s, env);
  const branch = branchOf(s, env);
  const before = heads.get(key) ?? null;
  const after = o.target ?? latest(repo);
  const cloned = !before;
  const changed = cloned || before !== after;
  const files = before && changed ? [...new Set(repo.commits.slice(indexOf(repo, before) + 1, indexOf(repo, after) + 1).flatMap((c) => c.files))] : [];
  push("stage", {
    stage: "pull",
    title: cloned ? `克隆 · ${branch} @ ${after.slice(0, 8)}` : changed ? `拉取 · ${branch} ${before!.slice(0, 8)} → ${after.slice(0, 8)}（${files.length} 个文件）` : `拉取 · ${branch} 已是最新（${after.slice(0, 8)}）`,
    content: [`目录 ${dir}`, ...(files.length ? ["变更文件：\n" + files.join("\n")] : [])].join("\n"),
  }, o.quick ? 600 : 2600);
  heads.set(key, after);
  remotes.set(key, { commit: latest(repo), checked_at: isoAt(t) });

  // 步骤：when 里的文件自这一步上次成功以来变了才跑；force 时不管变没变全部重跑
  const steps: Record<string, unknown>[] = [];
  for (const st of s.sync.steps) {
    const item = { title: label(st), when: st.when, shared: st.shared };
    const digest = digestAt(repo, after, st.when);
    if (digest === null) { steps.push({ ...item, status: "skipped", note: "仓库里没有匹配的文件" }); continue; }
    const sk = stepKey(s, env, st);
    const last = stepState.get(sk);
    if (last && last.digest === digest && !o.force) { steps.push({ ...item, status: "unchanged" }); continue; }
    const ok = !(o.fail ?? []).includes(item.title);
    const code = ok ? 0 : 1;
    const { output, ms } = stepRun(st, s, env, ok, !!o.quick);
    const argv = st.run.map((a) => render(a.replaceAll("{python}", pythonOf(s, env)), env)).join(" ");
    push("stage", { stage: "sync_step", title: `${item.title} · ${ok ? "完成" : `失败（退出码 ${code}）`}`, content: `$ ${argv}\n${output}`, duration_ms: ms }, ms);
    stepState.set(sk, { digest: ok ? digest : last?.digest ?? null, detail: { ok, at: isoAt(t), run_id: o.runId, env, code, message: output.slice(-500) } });
    steps.push({ ...item, status: ok ? "ok" : "failed", code, ms });
  }

  // 配置上游：变了就标待更新（本环境每个上游版本记一条事件；通知按上游变化只发一次，在先同步到的环境）
  const configs = configStates(s, env, {
    at: t,
    onOutdated: (c) => push("stage", { stage: "config_outdated", title: `配置待更新 · ${c.path}`, content: `仓库里的 ${c.upstream} 变了，本环境的 ${c.path} 可能要跟着改：\n${c.diff}` }, 150),
  });

  const failed = steps.filter((x) => x.status === "failed");
  const ran = steps.some((x) => x.status === "ok" || x.status === "failed");
  const report: Record<string, unknown> = { service: s.name, env, dir, branch, before, after, changed, cloned, force: !!o.force, files, discarded: [], backup: null, adopted: [], steps, configs };
  if (changed || ran) {
    report.kernels_closed = env === "prod" ? 0 : 1;
    report.restarted = failed.length ? [] : restart(s, env, t);
    if ((report.restarted as string[]).length) {
      push("stage", { stage: "restart", title: "已重启进程 · " + (report.restarted as string[]).join("、"), content: "代码或依赖变了，在跑的进程已重启" }, o.quick ? 500 : 2400);
    }
  }
  if (failed.length) {
    return reject(`代码已对齐到 ${after.slice(0, 8)}，但这些步骤失败了：` + failed.map((x) => `${x.title}（退出码 ${x.code}）`).join("；")
      + "。修好后在控制台点同步会重跑失败的步骤", "sync_step_failed");
  }
  push("final", { content: JSON.stringify(report, null, 2) }, 80);
  return { status: "success", events, output: report, finishedAt: t };
}

/** 在跑的本机副本进程重启，用上新代码 / 新依赖 */
function restart(s: Service, env: string, at: number): string[] {
  const done: string[] = [];
  for (const inst of db.instances) {
    if (inst.service !== s.name || inst.env !== env || (inst.state !== "running" && inst.state !== "starting")) continue;
    const lease = (s.processes[inst.process]?.lease_hours ?? db.settings.processes.default_lease_hours) * HOUR;
    // 种子回放的是过去的同步：进程是之后才（重新）起的，就不改它现在的启动时间与租约
    if (!inst.started_at || at > new Date(inst.started_at).getTime()) {
      Object.assign(inst, { pid: (inst.pid ?? 3000) + 17, started_at: isoAt(at), started_by: "code-sync", lease_until: isoAt(at + lease) });
    }
    done.push(inst.process);
  }
  return done;
}

function newRun(s: Service, env: string, trigger: Run["trigger"], at: number, runId: string, force = false): db.MockRun {
  const task = db.tasks.find((t) => t.name === "code-sync")!;
  const run: db.MockRun = {
    run_id: runId, session_id: runId, task: task.name, task_title: task.title, service: s.name, env, role: null, status: "running", resolution: null,
    trigger, summary: force ? `${task.title}（强制重跑步骤）` : task.title, tokens: 0, duration_ms: null, created_at: isoAt(at), finished_at: null,
    task_version: task.version, role_version: null, recipe: null, replay_of: null, input: force ? { force: true } : {}, output: null, error_code: null,
    memory: {}, feedback: [],
    context: { profile: "", recalled_knowledge: [], recalled_assets: [], saved_knowledge: [], saved_assets: [], session_runs: [] },
  };
  run.recipe = db.recipeOf(run, Math.max(0, Date.now() - at));
  return run;
}

function finish(run: db.MockRun, o: Outcome) {
  Object.assign(run, {
    status: o.status, resolution: "builtin", duration_ms: o.finishedAt - new Date(run.created_at).getTime(), finished_at: isoAt(o.finishedAt),
    _events: o.events, _output: o.output, _error_code: o.errorCode,
  });
}

/** 控制台 / API 发起的同步：先挂一个运行中的 run，几秒后按顺序跑完（共享步骤自然只做一次） */
let nextSlot = 0;
export function startRun(s: Service, env: string, trigger: Run["trigger"], force = false): db.MockRun {
  const at = Date.now();
  const run = newRun(s, env, trigger, at, db.hex(12), force);
  run._events = [{ seq: 1, kind: "stage", at: isoAt(at + 120), payload: { stage: "prepare", title: "准备", content: "内建处理器 code-sync" + (force ? " · 强制重跑所有同步步骤" : "") } }];
  db.runs.unshift(run);
  nextSlot = Math.max(at + 2500, nextSlot + 1500);
  setTimeout(() => finish(run, sync(s, env, { at, runId: run.run_id, quick: true, force })), nextSlot - at);
  return run;
}

// ———————— 配置文件（真实内容 + 备份） ————————

interface FileState { content: string | null; history: (ConfigVersion & { content: string })[] }
const fileStore = new Map<string, FileState>();

/** 时间戳形如 20261020-030405-123000（后端备份 id 的样子） */
const stamp = (ms: number) => isoAt(ms).replace(/[-:]/g, "").replace("T", "-").replace(/\.(\d{3})Z$/, (_, frac: string) => `-${frac}000`);

const CK_HOST: Record<string, string> = { prod: "172.168.0.125", test: "172.24.17.66", dev: "172.24.17.66" };

function initialContent(s: Service, env: string, path: string): string | null {
  const name = path.split("/").pop() ?? "";
  if (s.name === "vision-web" && env === "dev") return null;       // 开发环境的 settings 还没建：进程起不来
  if (s.name === "vision-dagster" && name === ".env") return [
    `# vision-dagster · ${env}：真实配置在代码目录外，进程 / 内核 / 同步步骤启动时 bind 到 ${rootOf(s, env)}/.env`,
    `CK_HOST=${CK_HOST[env] ?? CK_HOST.test}`, "CK_PORT=8123", "CK_USER=dagster_rw", `CK_PASSWORD=mock-${env}-Ck82pw`,
    `DAGSTER_PG_URL=postgresql://dagster:mock-${env}-dg7Q@127.0.0.1:5432/dagster_${env}`, "TZ=Asia/Shanghai", "",
  ].join("\n");
  if (name === "dagster.yaml") return `# ${path}\nrun_coordinator:\n  module: dagster._core.run_coordinator\n  class: QueuedRunCoordinator\n  config:\n    max_concurrent_runs: ${env === "prod" ? 6 : 2}\nstorage:\n  postgres:\n    postgres_url:\n      env: DAGSTER_PG_URL\ntelemetry:\n  enabled: false\n`;
  if (s.name === "vision-board") return `# vision-board · ${env}：复制自仓库的 vision_board/settings.py，改了 STATIC_ROOT、CRONTAB_COMMAND_PREFIX、库口令与认证授权
from .settings import *  # noqa: F401,F403

DEBUG = ${env === "dev" ? "True" : "False"}
ALLOWED_HOSTS = [${env === "prod" ? '"vision-board.moon-prod.ipa.zs"' : env === "test" ? '"vision-board.ipa.zs"' : '"127.0.0.1"'}, "127.0.0.1", "localhost"]

CLICKHOUSE = {
    "host": "${CK_HOST[env] ?? CK_HOST.test}",
    "port": 8123,
    "user": "board_ro",
    "password": "mock-${env}-Bd31ro",
    "database": "default",
}

STATIC_ROOT = "/srv/svc/vision-board/static/${env}"
CRONTAB_COMMAND_PREFIX = "DJANGO_SETTINGS_MODULE=vision_board.settings-${env}"

AUTH_SERVER = "https://auth.ipa.zs"
AUTH_APP_ID = "vision-board-${env}"
AUTH_APP_SECRET = "mock-${env}-9f1c2a"
`;
  if (s.name === "vision-web") return `# vision-web · ${env}：复制自仓库的 vision_web/settings.py
from .settings import *  # noqa: F401,F403

DEBUG = False
ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "HOST": "${env === "prod" ? "172.24.16.31" : "172.24.24.31"}",
        "NAME": "vision_cfg",
        "USER": "vision_web",
        "PASSWORD": "mock-${env}-Wb77pw",
    }
}

# 用户登录走 FreeIPA；本地应用授权码手动生成后写在这里
FREEIPA_SERVER = "ipa.ipa.zs"
AUTH_APP_CODE = "mock-${env}-a7c03e"
`;
  return `# ${path}\n`;
}

function fileOf(s: Service, env: string, path: string): FileState {
  const key = `${s.name}@${env}|${path}`;
  let f = fileStore.get(key);
  if (!f) fileStore.set(key, (f = { content: initialContent(s, env, path), history: [] }));
  return f;
}

/** 服务×环境视图里的配置文件：路径 + 上游 + 是否存在、大小 */
export function viewFiles(s: Service, env: string) {
  return configEntries(s, env).map((c) => {
    const f = fileOf(s, env, c.path);
    return { canonical: c.canonical, path: c.path, upstream: c.upstream, exists: f.content !== null, size: f.content === null ? null : bytes(f.content) };
  });
}

/** 打码：URL 里的口令、名字像口令 / 密钥 / token 的键的值（KEY=v、KEY: v、"key": v 都算） */
const mask = (text: string) => text
  .replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/g, "$1***@")
  .replace(/^(\s*["']?[\w.-]*(?:PASSWORD|SECRET|TOKEN|password|secret|token|AUTH_APP_CODE)[\w.-]*["']?\s*[=:]\s*)(?!\s*$)(?!.*os\.environ)(["']?).+?(\2,?)$/gm, "$1$2***$3");

export function readMasked(s: Service, env: string, path: string) {
  const c = entry(s, env, path);
  const f = fileOf(s, env, c.path);
  if (f.content === null) throw new ApiError(404, "not_found", `配置文件不存在：${c.path}`);
  return { path, content: mask(f.content) };
}

export function readRaw(s: Service, env: string, path: string): ConfigRaw {
  const c = entry(s, env, path);
  const f = fileOf(s, env, c.path);
  return {
    path: c.path, canonical: c.canonical, upstream: c.upstream || null, exists: f.content !== null, content: f.content ?? "",
    sha: f.content === null ? "" : sha(f.content), upstream_state: configStates(s, env).find((x) => x.path === c.path) ?? null,
  };
}

/** 已按上游核对过（保存过或确认不用改）：以当前上游为准 */
export function ackConfig(s: Service, env: string, path: string, by: string, at = Date.now()) {
  const c = entry(s, env, path);
  const repo = repoOf(s);
  const head = heads.get(`${s.name}@${env}`);
  if (!c.upstream || !repo || !head || !repo.files.includes(c.upstream)) return;
  acked.set(`${s.name}@${env}|${c.canonical}`, { commit: digestAt(repo, head, [c.upstream])!, at: isoAt(at), by });
}

export function writeConfig(s: Service, env: string, path: string, content: string, baseSha: string | null | undefined, by: string, at = Date.now()): ConfigSaved {
  const c = entry(s, env, path);
  const f = fileOf(s, env, c.path);
  if (baseSha !== null && baseSha !== undefined && baseSha !== (f.content === null ? "" : sha(f.content))) {
    throw new ApiError(409, "conflict", `${c.path} 在你打开之后被改过，刷新后再改`);
  }
  let backup: string | null = null;
  if (f.content !== null) {
    backup = `${stamp(at)}~${by}`;
    f.history = [{ id: backup, at: isoAt(at), replaced_by: by, size: bytes(f.content), content: f.content }, ...f.history].slice(0, 30);
  }
  f.content = content;
  ackConfig(s, env, c.path, by, at);
  const running = Object.keys(s.processes).length
    ? db.instances.filter((i) => i.service === s.name && i.env === env && (i.state === "running" || i.state === "starting")).map((i) => i.process) : [];
  return { path: c.path, sha: sha(content), backup, running };
}

export function configHistory(s: Service, env: string, path: string): ConfigVersion[] {
  const c = entry(s, env, path);
  return fileOf(s, env, c.path).history.map(({ content: _c, ...v }) => { void _c; return v; });
}

export function configVersion(s: Service, env: string, path: string, id: string) {
  const c = entry(s, env, path);
  const v = fileOf(s, env, c.path).history.find((x) => x.id === id);
  if (!v) throw new ApiError(404, "not_found", `备份 ${id} 不存在`);
  return { id, content: v.content };
}

// ———————— 种子：按时间回放 ————————

/** 某个环境已同步到 head：步骤都在 head 上成功过、配置上游都核对过（没有对应的运行） */
function baseline(s: Service, env: string, head: string, at: number) {
  const repo = repoOf(s)!;
  heads.set(`${s.name}@${env}`, head);
  for (const st of s.sync.steps) {
    const digest = digestAt(repo, head, st.when);
    if (digest !== null) stepState.set(stepKey(s, env, st), { digest, detail: { ok: true, at: isoAt(at), run_id: null, env, code: 0, message: "" } });
  }
  configStates(s, env, { at });
}

const svcOf = (name: string) => db.services.find((s) => s.name === name)!;
const WATCH: Run["trigger"] = { type: "watch", id: null, source: null, caller: "code-watch" };
const seeded: db.MockRun[] = [];
let seedRun = 0;
function replay(s: Service, env: string, at: number, o: { target?: string; fail?: string[]; fetchError?: string } = {}) {
  const runId = "c0de5c0de" + String(++seedRun).padStart(3, "0");
  const run = newRun(s, env, WATCH, at, runId);
  finish(run, sync(s, env, { at, runId, ...o }));
  seeded.push(run);
}

{
  const dagster = svcOf("vision-dagster"), board = svcOf("vision-board"), web = svcOf("vision-web");
  const envNames = db.envs.map((e) => e.name);
  for (const env of envNames) {
    baseline(dagster, env, D[1], NOW - 12 * DAY + 40 * MIN);
    baseline(board, env, B[1], NOW - 3 * DAY + 50 * MIN);
    baseline(web, env, W[1], NOW - 6 * DAY + 2 * HOUR);
  }
  // 9 天前 liyd 改过 test 的 settings（ClickHouse 账号换成只读的 board_ro）
  const testBoard = "/srv/svc/vision-board/conf/test/settings.py";
  const v0 = fileOf(board, "test", testBoard).content!;
  writeConfig(board, "test", testBoard, v0.replace('"user": "board_ro"', '"user": "board_ro"  # 只读账号'), undefined, "liyd", NOW - 9 * DAY);

  // vision-dagster：30 小时前 D2（.env.template 加 doris、pyproject 变了 → 共享的「安装项目」只装一次）
  const t2 = NOW - 30 * HOUR + 15 * MIN;
  envNames.forEach((env, i) => replay(dagster, env, t2 + i * 60_000, { target: D[2] }));
  // 20 小时前 D3：只改代码，步骤都不用跑
  const t3 = NOW - 20 * HOUR + 10 * MIN;
  envNames.forEach((env, i) => replay(dagster, env, t3 + i * 40_000));
  // 18 小时前 gaodl 按上游给 test 的 .env 补了 doris（保存即核对）；prod / dev 的还没处理
  const testEnv = "/srv/svc/vision-dagster/conf/test/.env";
  const cur = fileOf(dagster, "test", testEnv).content!;
  writeConfig(dagster, "test", testEnv, cur + "DORIS_HOST=172.24.24.88\nDORIS_PORT=9030\nDORIS_USER=dagster_ro\nDORIS_PASSWORD=mock-test-Dr19\n", undefined, "gaodl", NOW - 18 * HOUR);

  // vision-board：26 小时前 B2 升级依赖。安装依赖是共享步骤（三个环境共用 conda 环境），prod 装过，test / dev 就跳过；dev 收集静态资源失败
  const b2 = NOW - 26 * HOUR;
  replay(board, "prod", b2, { target: B[2] });
  replay(board, "test", b2 + 70_000, { target: B[2] });
  replay(board, "dev", b2 + 140_000, { target: B[2], fail: ["收集静态资源"] });
  // 约 1 小时前 B3 改了 vision_board/settings.py → prod / test 的 settings 待更新；dev 拉取失败，落后远端
  const b3 = NOW - 62 * MIN;
  replay(board, "prod", b3);
  replay(board, "test", b3 + 50_000);
  replay(board, "dev", b3 + 100_000, { fetchError: "ssh: connect to host gitlab.ipa.zs port 22: Connection timed out" });
  // 40 分钟前 liyd 按上游给 test 的 settings 加了 CHROME_BIN（保存即核对）；prod 的还没人处理
  const curBoard = fileOf(board, "test", testBoard).content!;
  writeConfig(board, "test", testBoard, curBoard + '\nCHROME_BIN = "/usr/bin/google-chrome"\n', undefined, "liyd", NOW - 40 * MIN);

  // 代码跟踪最近一次看远端：12 分钟前
  for (const s of [dagster, board, web]) for (const env of envNames) {
    const repo = repoOf(s)!;
    remotes.set(`${s.name}@${env}`, { commit: latest(repo), checked_at: db.iso(12 * MIN) });
  }

  db.runs.push(...seeded);
  db.runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}
