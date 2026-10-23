"""代码跟踪：每隔 code_sync.interval_minutes（默认 60 分钟）看一眼各服务的远端分支，本地落后才提交 code-sync 运行。

- 只看有 repo、服务启用、sync.auto 没关的服务；每个启用的环境比一次（各环境都跟踪服务的 ref，可按环境覆盖）
- 看远端用 git ls-remote：只读、不碰本地目录，同一个仓库同一个分支一轮只问一次
- 没有新提交不建运行；有新提交按 服务×环境×远端提交 带幂等键提交（trigger=watch），同一个提交只同步一次，
  失败的运行会释放这个键，下一轮再试
- 手动同步（控制台按钮 / POST /v1/services/{s}/sync）不经过这里，随时可以点
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from ..domain import Rejected, RunRequest, RunTrigger
from ..registry import Registry
from ..services import codesync
from ..store import codesync as sync_state

log = logging.getLogger(__name__)

FIRST_CHECK_S = 120          # 启动后先等一会儿再看第一次


class CodeWatcher:
    def __init__(self, registry: Registry, submitter, interval_minutes: float):
        self._reg = registry
        self._submitter = submitter
        self._interval_s = interval_minutes * 60

    async def run_forever(self) -> None:
        if self._interval_s <= 0:
            return
        await asyncio.sleep(FIRST_CHECK_S)
        while True:
            try:
                n = await self.check()
                if n:
                    log.info("代码跟踪：%d 个服务×环境有新提交，已提交同步", n)
            except Exception:  # noqa: BLE001 —— 下一轮再来
                log.exception("代码跟踪检查失败")
            await asyncio.sleep(self._interval_s)

    async def check(self) -> int:
        """看一轮，返回提交的同步数。"""
        envs = (await self._reg.envs()).names
        remotes: dict[tuple[str, str], str | None] = {}
        submitted = 0
        for s in await self._reg.services():
            if not s.spec.repo or not s.spec.enabled or not s.spec.sync.auto:
                continue
            for env in envs:
                view = s.spec.view(s.name, env)
                if not view.enabled:
                    continue
                key = (view.repo, view.ref)
                if key not in remotes:
                    try:
                        remotes[key] = await codesync.remote_head(view.repo, view.ref)
                    except codesync.SyncError as e:
                        log.warning("代码跟踪：%s 的远端 %s 看不了：%s", s.name, view.ref or "默认分支", e)
                        remotes[key] = None
                remote = remotes[key]
                if remote is None:
                    continue
                await sync_state.put(s.name, env, "remote", digest=remote,
                                     detail={"checked_at": datetime.now(timezone.utc).isoformat()})
                if await codesync.local_head(view.root) == remote:
                    continue
                submitted += await self._submit(s.name, env, remote)
        return submitted

    async def _submit(self, service: str, env: str, remote: str) -> int:
        try:
            accepted = await self._submitter.submit(
                RunRequest(task="code-sync", service=service, env=env),
                trigger=RunTrigger(type="watch", caller="code-watch"),
                idempotency_key=f"watch:{service}:{env}:{remote}")
        except Rejected as e:
            log.warning("代码跟踪：%s@%s 的同步被拒：%s（%s）", service, env, e.message, e.code)
            return 0
        return 0 if accepted.dedup else 1
