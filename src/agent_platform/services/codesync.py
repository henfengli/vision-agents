"""代码同步：把服务在某个环境的代码目录对齐到跟踪的分支（服务的 ref，比如 master），再按变更做后续步骤。
内建任务 code-sync 调它；代码跟踪（orchestration/codewatch.py）每小时看一眼远端，有新提交就提交一次 code-sync。

    目录不存在   → git clone
    否则         → git fetch；已跟踪文件的本地改动先备份成补丁（数据目录 sync-backups/），然后
                   git checkout -f -B <分支> origin/<分支>：本机副本不是开发用的，直接对齐远端
    步骤         → 服务定义 sync.steps：when 里的文件自这一步上次成功以来变了才跑（装依赖、collectstatic…），
                   失败了下次同步还会再跑；shared 的步骤（装依赖）在共用一个解释器的环境之间只做一次
    配置上游     → 配置文件的 upstream（仓库里的 .env.template、settings.py…）变了：标"配置待更新"、发通知，
                   在控制台对照上游 diff 改完保存（或点已核对）才算处理
    收尾         → 代码或依赖变了：该服务×环境的项目内核重启、在跑的进程重启

配置文件的真实内容在代码目录外（configs.template），进程 / 内核 / 步骤启动时 bind 到固定路径，同步碰不到它。
未跟踪的文件（.env、收集出来的静态资源）不动。git 用平台用户自己的 ssh 密钥，不弹交互提示。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import time
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from ..agent.tools.bash import build_safe_env
from ..agent.tools.sandbox import has_bwrap
from ..domain import Rejected, ServiceDef, ServiceView, SyncStep
from ..domain.services import render
from ..notify import Message
from ..store import codesync as state
from . import svcrun
from .control import ensure_mount_points

log = logging.getLogger(__name__)

GIT_TIMEOUT_S = 300.0
OUTPUT_TAIL = 6000
# 步骤里装依赖要用的网络 / 镜像设置：平台进程有就透传
_PASS_ENV = ("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST", "PIP_DEFAULT_TIMEOUT",
             "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")

_locks: dict[str, asyncio.Lock] = {}

Log = Callable[[str, dict], Awaitable[Any]]


def _lock(key: str) -> asyncio.Lock:
    return _locks.setdefault(key, asyncio.Lock())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _tail(text: str, n: int = OUTPUT_TAIL) -> str:
    return text if len(text) <= n else "…\n" + text[-n:]


class SyncError(RuntimeError):
    pass


# ———————— git ————————

async def _git(cwd: str | None, *args: str, timeout: float = GIT_TIMEOUT_S) -> str:
    argv = ["git", *(["-C", cwd] if cwd else []), *args]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        raise SyncError(f"git {args[0]} 超过 {int(timeout)}s") from None
    if proc.returncode != 0:
        detail = (err or out).decode(errors="replace").strip()[-800:]
        raise SyncError(f"git {' '.join(args[:2])} 失败：{detail}")
    return out.decode(errors="replace").rstrip("\n")


async def _try_git(cwd: str | None, *args: str, timeout: float = 30) -> str | None:
    try:
        return await _git(cwd, *args, timeout=timeout)
    except SyncError:
        return None


async def remote_head(repo: str, branch: str) -> str | None:
    """远端分支（空 = 远端默认分支）当前的提交。只读，不碰本地目录。"""
    out = await _git(None, "ls-remote", repo, f"refs/heads/{branch}" if branch else "HEAD", timeout=60)
    first = out.splitlines()[0] if out else ""
    return first.split()[0] if first else None


async def local_head(path: str) -> str | None:
    if not path or not os.path.isdir(os.path.join(path, ".git")):
        return None
    return await _try_git(path, "rev-parse", "HEAD", timeout=10)


async def _resolve(cwd: str, branch: str) -> str:
    candidates = [f"origin/{branch}", branch] if branch else ["origin/HEAD"]
    for c in candidates:
        if sha := await _try_git(cwd, "rev-parse", "--verify", "--quiet", f"{c}^{{commit}}"):
            return sha
    raise SyncError(f"仓库里找不到 {branch or '远端默认分支'}（试过 {'、'.join(candidates)}）")


def _status_paths(porcelain: str) -> list[str]:
    out = []
    for line in porcelain.splitlines():
        if len(line) > 3:
            path = line[3:]
            out.append(path.split(" -> ", 1)[1] if " -> " in path else path)
    return out


def _relative(path: str, root: str) -> str | None:
    base = root.rstrip("/") + "/"
    return path[len(base):] if path.startswith(base) else None


async def pull(view: ServiceView, ref: str | None, backup_dir: str) -> dict:
    """克隆或对齐到跟踪的分支。→ {dir, branch, before, after, changed, cloned, files, discarded, backup, adopted}"""
    if not view.repo:
        raise SyncError(f"服务 {view.service} 没有配置 repo（git 远端）")
    path = view.root
    if not path:
        raise SyncError(f"服务 {view.service} 没有配置部署目录 root")
    branch = (ref or view.ref or "").strip()
    before = None
    cloned = False
    discarded: list[str] = []
    backup = None
    adopted: list[str] = []
    if not os.path.isdir(os.path.join(path, ".git")):
        if os.path.isdir(path) and os.listdir(path):
            raise SyncError(f"{path} 已存在且不是 git 仓库，拒绝覆盖")
        os.makedirs(os.path.dirname(path.rstrip("/")) or "/", exist_ok=True)
        await _git(None, "clone", "--quiet", view.repo, path)
        cloned = True
    else:
        before = await _git(path, "rev-parse", "HEAD")
        await _git(path, "fetch", "--quiet", "--prune", "--tags", "origin")
        discarded = _status_paths(await _git(path, "status", "--porcelain", "--untracked-files=no"))
        if discarded:
            # 已跟踪文件的本地改动：先留一份补丁再丢弃。声明成配置文件、却直接改在代码目录里的
            # （比如改过的 settings.py），代码目录外还没有真实文件时先收编过去，免得同步把它冲掉
            adopted = _adopt(view, discarded)
            patch = await _git(path, "diff", "--binary", "HEAD")
            os.makedirs(backup_dir, exist_ok=True)
            backup = os.path.join(backup_dir, f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{before[:8]}.patch")
            with open(backup, "w", encoding="utf-8") as f:
                f.write(patch + "\n")
            os.chmod(backup, 0o600)
    commit = await _resolve(path, branch)
    if branch and await _try_git(path, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}"):
        await _git(path, "checkout", "--quiet", "-f", "-B", branch, commit)
        await _try_git(path, "branch", "--quiet", f"--set-upstream-to=origin/{branch}", branch)
    else:
        await _git(path, "checkout", "--quiet", "-f", "--detach", commit)
    files: list[str] = []
    if before and before != commit:
        files = (await _git(path, "diff", "--name-only", before, commit)).splitlines()
    return {"dir": path, "branch": branch or "（远端默认分支）", "before": before, "after": commit,
            "changed": cloned or before != commit, "cloned": cloned, "files": files,
            "discarded": discarded, "backup": backup, "adopted": adopted}


def _adopt(view: ServiceView, modified: list[str]) -> list[str]:
    out = []
    for c in view.config_files:
        rel = _relative(c["canonical"], view.root)
        if rel in modified and not os.path.exists(c["path"]):
            os.makedirs(os.path.dirname(c["path"]) or "/", exist_ok=True)
            shutil.copy2(os.path.join(view.root, rel), c["path"])
            out.append(c["path"])
    return out


async def files_digest(path: str, patterns: list[str]) -> str | None:
    """when 里的文件在当前提交的内容摘要；仓库里一个都没有返回 None。"""
    out = await _try_git(path, "ls-files", "-s", "--", *[f":(glob){p}" for p in patterns])
    return hashlib.sha1(out.encode()).hexdigest()[:16] if out else None


def step_key(step: SyncStep) -> str:
    raw = json.dumps({"run": step.run, "when": step.when}, ensure_ascii=False, sort_keys=True)
    return "step:" + hashlib.sha1(raw.encode()).hexdigest()[:12]


def config_key(canonical: str) -> str:
    return "config:" + canonical


async def upstream_blob(path: str, rel: str) -> str | None:
    return await _try_git(path, "rev-parse", "--verify", "--quiet", f"HEAD:{rel}", timeout=10)


async def blob_diff(path: str, old: str, new: str) -> str:
    out = await _try_git(path, "diff", "--no-color", old, new)
    return out if out is not None else "（取不到 diff）"


# ———————— 步骤 ————————

async def run_step(step: SyncStep, view: ServiceView, spec: dict) -> tuple[int, str, int]:
    """在和业务进程同一套隔离里跑一步（svcrun 的 bwrap 规格：本环境配置 bind 到固定路径、平台密钥遮蔽、
    其余照常可写可联网）。→ (退出码, 输出, 毫秒)"""
    argv = [render(a, view.env, python=view.python) for a in step.run]
    env = {**build_safe_env(), **{k: os.environ[k] for k in _PASS_ENV if k in os.environ}}
    if os.path.isabs(view.python):
        env["PATH"] = os.path.dirname(view.python) + os.pathsep + env.get("PATH", "")
    note = ""
    if has_bwrap():
        argv = svcrun.build_argv({"service": view.service, "env": view.env, "argv": argv, "workdir": view.root,
                                  "binds": spec["binds"], "masks": spec["masks"], "env_vars": spec["env_vars"]})
    else:
        env.update({**spec["env_vars"], "SVC_ENV": view.env, "SVC_NAME": view.service})
        note = "（没有 bwrap：直接在宿主上跑，配置文件没有按环境就位）\n"
    t0 = time.monotonic()
    proc = await asyncio.create_subprocess_exec(*argv, cwd=view.root or None, env=env,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), step.timeout_s)
        code = proc.returncode or 0
        text = out.decode(errors="replace")
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        await proc.wait()
        code, text = 124, f"超过 {step.timeout_s}s，已终止"
    return code, note + _tail(text), int((time.monotonic() - t0) * 1000)


# ———————— 一次同步 ————————

async def _nolog(kind: str, payload: dict) -> None:
    return None


class CodeSync:
    def __init__(self, settings: Any, registry: Any, controller: Any, kernels: Any, notifier: Any):
        self._s = settings
        self._reg = registry
        self._ctl = controller
        self._kernels = kernels
        self._notifier = notifier

    async def _service(self, service: str, env: str) -> tuple[ServiceDef, ServiceView]:
        view = await self._reg.service_view(service, env)        # 环境不存在抛 unknown_env
        if view is None:
            raise Rejected.not_found(f"服务 {service}")
        return (await self._reg.service(service)).spec, view

    async def sync(self, service: str, env: str, *, ref: str | None = None, run_id: str | None = None,
                   log: Log = _nolog, force: bool = False) -> dict:
        """force：不管 when 里的文件变没变，所有步骤都重跑（重建了 conda 环境之后用）。"""
        svc, view = await self._service(service, env)
        async with _lock(f"{service}@{env}"):
            try:
                pulled = await pull(view, ref, os.path.join(self._s.sync_backups_dir, service, env))
            except SyncError as e:
                raise Rejected("code_sync_failed", str(e)) from None
            await log("stage", {"stage": "pull", "title": _pull_title(pulled), "content": _pull_text(pulled)})
            report = {"service": service, "env": env, **pulled}
            report["steps"] = await self._steps(svc, view, run_id, log, force)
            report["configs"] = await self._configs(view, log, notify=True)
            ran = any(s["status"] in ("ok", "failed") for s in report["steps"])
            failed = [s for s in report["steps"] if s["status"] == "failed"]
            if pulled["changed"] or ran:
                report["kernels_closed"] = await self._kernels.drop(service, env)
                report["restarted"] = [] if failed else await self._restart(service, env, log)
        if failed:
            raise Rejected("sync_step_failed", "代码已对齐到 " + pulled["after"][:8] + "，但这些步骤失败了："
                           + "；".join(f"{s['title']}（退出码 {s['code']}）" for s in failed)
                           + "。修好后在控制台点同步会重跑失败的步骤")
        return report

    async def _steps(self, svc: ServiceDef, view: ServiceView, run_id: str | None, log: Log,
                     force: bool = False) -> list[dict]:
        out: list[dict] = []
        spec: dict | None = None
        for step in svc.sync.steps:
            digest = await files_digest(view.root, step.when)
            item: dict[str, Any] = {"title": step.label, "when": step.when, "shared": step.shared}
            if digest is None:
                out.append({**item, "status": "skipped", "note": "仓库里没有匹配的文件"})
                continue
            scope = f"python:{view.python}" if step.shared else view.env
            async with AsyncExitStack() as stack:
                if step.shared:                    # 共用一个解释器的环境串行装依赖，装过同样的就跳过
                    await stack.enter_async_context(_lock(scope))
                last = await state.get(view.service, scope, step_key(step))
                if last and last["digest"] == digest and not force:
                    out.append({**item, "status": "unchanged"})
                    continue
                if spec is None:
                    spec = await self._step_spec(svc, view.env)
                code, output, ms = await run_step(step, view, spec)
                ok = code == 0
                await state.put(view.service, scope, step_key(step), digest=digest if ok else None,
                                detail={"ok": ok, "at": _now(), "run_id": run_id, "env": view.env, "code": code,
                                        "message": output[-500:]})
            await log("stage", {"stage": "sync_step", "title": f"{step.label} · " + ("完成" if ok else f"失败（退出码 {code}）"),
                                "content": "$ " + " ".join(render(a, view.env, python=view.python) for a in step.run)
                                + "\n" + output, "duration_ms": ms})
            out.append({**item, "status": "ok" if ok else "failed", "code": code, "ms": ms})
        return out

    async def _step_spec(self, svc: ServiceDef, env: str) -> dict:
        """本环境的配置就位规格；缺了的配置文件跳过（装依赖用不到它，用得到的步骤会自己报错）。"""
        spec = await self._ctl.env_spec(svc, env)
        spec["binds"] = [[src, dst] for src, dst in spec["binds"] if os.path.exists(src)]
        ensure_mount_points([dst for _, dst in spec["binds"]])
        return spec

    async def _configs(self, view: ServiceView, log: Log | None, notify: bool) -> list[dict]:
        """每个声明了上游的配置文件：上游自上次核对以来变了没有。第一次见到时以当前为准（不算待更新）。"""
        out = []
        for c in view.config_files:
            rel = c.get("upstream")
            blob = await upstream_blob(view.root, rel) if rel else None
            if blob is None:
                continue
            key = config_key(c["canonical"])
            last = await state.get(view.service, view.env, key)
            item: dict[str, Any] = {"path": c["path"], "canonical": c["canonical"], "upstream": rel, "pending": False}
            if last is None or not last["digest"]:
                await state.put(view.service, view.env, key, digest=blob, detail={"acked_at": _now(), "by": "初次同步"})
            elif last["digest"] != blob:
                item["pending"] = True
                item["diff"] = (await blob_diff(view.root, last["digest"], blob))[:20000]
                item["since"] = last["detail"].get("acked_at")
                if notify and last["detail"].get("notified") != blob:
                    # 同一个上游版本只通知一次：几个环境都跟踪 master，先同步到的那个发，其余的只记事件
                    sent = await state.get(view.service, "*", f"notified:{rel}")
                    if not sent or sent["digest"] != blob:
                        await self._announce(view, item)
                        await state.put(view.service, "*", f"notified:{rel}", digest=blob, detail={"env": view.env})
                    await state.put(view.service, view.env, key, detail={**last["detail"], "notified": blob})
                    if log is not None:
                        await log("stage", {"stage": "config_outdated", "title": f"配置待更新 · {c['path']}",
                                            "content": f"仓库里的 {rel} 变了，本环境的 {c['path']} 可能要跟着改：\n{item['diff']}"})
            out.append(item)
        return out

    async def _announce(self, view: ServiceView, item: dict) -> None:
        await self._notifier.emit("config_outdated", Message(
            title=f"配置待更新：{view.service}",
            text=f"仓库里的 `{item['upstream']}` 变了（{view.env} 先同步到），各环境对应的配置（如 `{item['path']}`）"
                 f"可能要跟着改，在服务页逐个环境核对。\n\n```diff\n{item['diff'][:1500]}\n```",
            link=self._notifier.link(f"/services/{view.service}?env={view.env}&tab=config"), link_title="去改配置"),
            service=view.service, env=view.env)

    async def _restart(self, service: str, env: str, log: Log) -> list[str]:
        """在跑的本机副本进程重启，用上新代码 / 新依赖。"""
        if self._ctl.backend == "off":
            return []
        done = []
        for inst in await self._ctl.list(service):
            if inst["env"] != env or inst["state"] not in ("running", "starting"):
                continue
            try:
                await self._ctl.stop(service, env, inst["process"], by="code-sync")
                await self._ctl.start(service, env, inst["process"], by="code-sync")
                done.append(inst["process"])
            except Rejected as e:
                await log("stage", {"stage": "restart", "title": f"重启 {inst['process']} 失败", "content": e.message})
        if done:
            await log("stage", {"stage": "restart", "title": "已重启进程 · " + "、".join(done),
                                "content": "代码或依赖变了，在跑的进程已重启"})
        return done

    # —— 页面用 ——

    async def status(self, service: str, env: str) -> dict:
        """同步状态：当前提交、远端最近一次检查、各步骤是否待跑 / 上次结果、各配置文件是否待更新。"""
        svc, view = await self._service(service, env)
        head = None
        if await local_head(view.root):
            info = await _try_git(view.root, "log", "-1", "--format=%H%x00%h%x00%s%x00%an%x00%cI")
            if info:
                full, short, subject, author, at = (info.split("\x00") + [""] * 5)[:5]
                head = {"commit": full, "short": short, "subject": subject, "author": author, "committed_at": at}
        remote = await state.get(service, env, "remote")
        steps = []
        for step in svc.sync.steps:
            scope = f"python:{view.python}" if step.shared else env
            last = await state.get(service, scope, step_key(step))
            digest = await files_digest(view.root, step.when) if head else None
            steps.append({"title": step.label, "when": step.when, "shared": step.shared,
                          "pending": digest is not None and (last is None or last["digest"] != digest),
                          "last": last["detail"] if last else None})
        return {"service": service, "env": env, "enabled": view.enabled, "auto": svc.sync.auto, "repo": view.repo,
                "dir": view.root, "branch": view.ref or "（远端默认分支）", "head": head,
                "remote": {"commit": remote["digest"], **remote["detail"]} if remote else None,
                "behind": bool(remote and head and remote["digest"] and remote["digest"] != head["commit"]),
                "steps": steps, "configs": await self._configs(view, None, notify=False)}

    async def config_state(self, view: ServiceView, path: str) -> dict | None:
        """单个配置文件的上游状态（配置编辑页用）。"""
        for item in await self._configs(view, None, notify=False):
            if path in (item["path"], item["canonical"]):
                return item
        return None

    async def ack_config(self, view: ServiceView, path: str, by: str) -> None:
        """配置文件已按上游核对过（保存过或确认不用改）：以当前上游为准，不再算待更新。"""
        c = next((c for c in view.config_files if path in (c["path"], c["canonical"])), None)
        if c is None or not c.get("upstream"):
            return
        blob = await upstream_blob(view.root, c["upstream"])
        if blob is not None:
            await state.put(view.service, view.env, config_key(c["canonical"]), digest=blob,
                            detail={"acked_at": _now(), "by": by})


def _pull_title(p: dict) -> str:
    if p["cloned"]:
        return f"克隆 · {p['branch']} @ {p['after'][:8]}"
    if p["changed"]:
        return f"拉取 · {p['branch']} {p['before'][:8]} → {p['after'][:8]}（{len(p['files'])} 个文件）"
    return f"拉取 · {p['branch']} 已是最新（{p['after'][:8]}）"


def _pull_text(p: dict) -> str:
    lines = [f"目录 {p['dir']}"]
    if p["files"]:
        lines.append("变更文件：\n" + "\n".join(p["files"][:80]) + (f"\n…共 {len(p['files'])} 个" if len(p["files"]) > 80 else ""))
    if p["discarded"]:
        lines.append("丢弃的本地改动：" + "、".join(p["discarded"][:20]) + f"（补丁已备份到 {p['backup']}）")
    if p["adopted"]:
        lines.append("直接改在代码目录里的配置文件已收编到：" + "、".join(p["adopted"]))
    return "\n".join(lines)
