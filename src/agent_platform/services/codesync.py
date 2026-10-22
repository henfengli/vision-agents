"""代码同步：把服务在某个环境的代码目录切到指定版本（内建任务 code-sync）。

每个环境一个 git 工作目录（root 写成 /srv/code/board/{env}），各环境可以停在不同的提交上——
复现生产问题时读到的就是生产在跑的那份代码。

    目录不存在      → git clone <repo>
    已是 git 仓库   → 有未提交改动就拒绝（不替人丢改动），否则 git fetch
    然后            → git checkout --detach <目标>（ref 参数 > envs[env].ref > ref > 远端默认分支）

平台用户要能写代码目录、能读远端（部署密钥 / 只读 token）。git 不会弹交互提示（GIT_TERMINAL_PROMPT=0）。
"""

from __future__ import annotations

import asyncio
import os

from ..domain import ServiceView

GIT_TIMEOUT_S = 300.0


class SyncError(RuntimeError):
    pass


async def _git(cwd: str | None, *args: str) -> str:
    argv = ["git", *(["-C", cwd] if cwd else []), *args]
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    try:
        out, err = await asyncio.wait_for(proc.communicate(), GIT_TIMEOUT_S)
    except (TimeoutError, asyncio.TimeoutError):
        proc.kill()
        raise SyncError(f"git {args[0]} 超过 {int(GIT_TIMEOUT_S)}s") from None
    if proc.returncode != 0:
        detail = (err or out).decode(errors="replace").strip()[-800:]
        raise SyncError(f"git {' '.join(args[:2])} 失败：{detail}")
    return out.decode(errors="replace").strip()


async def _resolve(cwd: str, target: str) -> str:
    candidates = [f"origin/{target}", target] if target else ["origin/HEAD"]
    for c in candidates:
        try:
            return await _git(cwd, "rev-parse", "--verify", "--quiet", f"{c}^{{commit}}")
        except SyncError:
            continue
    raise SyncError(f"仓库里找不到 {target or '远端默认分支'}（试过 {'、'.join(candidates)}）")


async def sync(view: ServiceView, ref: str | None = None) -> dict:
    if not view.repo:
        raise SyncError(f"服务 {view.service} 没有配置 repo（git 远端）")
    path = view.root
    if not path:
        raise SyncError(f"服务 {view.service} 没有配置部署目录 root")
    target = (ref or view.ref or "").strip()
    cloned = False
    before = None
    if not os.path.isdir(os.path.join(path, ".git")):
        if os.path.isdir(path) and os.listdir(path):
            raise SyncError(f"{path} 已存在且不是 git 仓库，拒绝覆盖")
        os.makedirs(os.path.dirname(path.rstrip("/")) or "/", exist_ok=True)
        await _git(None, "clone", "--quiet", view.repo, path)
        cloned = True
    else:
        before = await _git(path, "rev-parse", "HEAD")
        if dirty := await _git(path, "status", "--porcelain", "--untracked-files=no"):
            raise SyncError(f"{path} 有未提交改动，拒绝切换（先处理掉）：\n{dirty[:500]}")
        await _git(path, "fetch", "--quiet", "--prune", "--tags", "origin")
    commit = await _resolve(path, target)
    await _git(path, "checkout", "--quiet", "--detach", commit)
    out = {"service": view.service, "env": view.env, "dir": path, "ref": target or "（远端默认分支）",
           "before": before, "after": commit, "changed": before != commit, "cloned": cloned}
    if before and before != commit:
        out["note"] = "代码已切换；正在运行的进程要重启才会用上新代码"
    return out
