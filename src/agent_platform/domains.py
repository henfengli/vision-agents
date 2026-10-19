"""业务域（服务）运行期注册表：域配置的 DB 事实源 + 全局启停闸门。

存储：definitions kind="domain"（版本化、服务页可编辑、5s 热生效、
可回滚），conf/domains/ 域包只是首次启动的种子——与规则库同一条路子。
启停三级中的两级在这里收口：

- 服务级：域定义的 enabled 字段。停用 = 拒绝响应（submit/webhook 拒收）
  + 暂停调度（调度前检查、prepare_run 兜底）。
- 环境级：definitions kind="env"（name=目标环境名，definition=
  {"enabled": bool}）。未配置的环境默认启用——启停是显式操作，
  不配不挡路。
"""

from __future__ import annotations

import logging

from .config import DomainConfig
from .store.definitions import DefinitionStore, seed_drifted

log = logging.getLogger(__name__)


class DomainProvider:
    """域配置与环境开关的运行期读取面。

    同步读（get/all/names）吃 5s 快照——sql_dsn/host_resolver 这类同步
    消费方不改为 async 也能热生效；异步入口（submit/页面/调度）先
    await refresh()，快照过期自动重取。
    """

    def __init__(self, defs: DefinitionStore, env: str,
                 fallback: dict[str, DomainConfig]):
        self._defs = defs
        self._env = env
        self._fallback = fallback          # conf/domains 文件种子（兜底）
        self._snap: dict[str, DomainConfig] | None = None

    async def seed_from_packs(self) -> int:
        """文件域包播种进 definitions；已有定义不覆盖（编辑版本为准）。

        已播种过的服务若文件自播种后又改过，打警告——文件改动不生效，
        要改去服务页（避免"改了文件怎么没用"的排查死角）。"""
        n = 0
        for name, cfg in self._fallback.items():
            file_def = cfg.model_dump(mode="json")
            if await self._defs.get_active("domain", self._env, name) is None:
                await self._defs.put("domain", self._env, name, file_def,
                                     updated_by="seed")
                n += 1
            elif await seed_drifted(self._defs, "domain", self._env, name,
                                    file_def):
                log.warning("域包 conf/domains/%s 自播种后有改动，但服务配置"
                            "以定义库为准，文件改动未生效——请到 /services/%s 编辑",
                            name, name)
        return n

    async def refresh(self) -> dict[str, DomainConfig]:
        rows = await self._defs.list_active("domain", self._env)
        snap = {}
        for r in rows:
            fields = {k: v for k, v in r.items() if k in
                      DomainConfig.model_fields}
            try:
                snap[r["name"]] = DomainConfig.model_validate(fields)
            except Exception:  # noqa: BLE001 — 一条脏定义不拖垮全部
                log.exception("域定义 %s 解析失败，跳过", r["name"])
        for name, cfg in self._fallback.items():
            snap.setdefault(name, cfg)
        self._snap = snap
        return snap

    def all(self) -> dict[str, DomainConfig]:
        return self._snap if self._snap is not None else self._fallback

    def get(self, name: str | None) -> DomainConfig | None:
        if not name:
            return None
        return self.all().get(name)

    def names(self, enabled_only: bool = False) -> list[str]:
        return sorted(n for n, c in self.all().items()
                      if c.enabled or not enabled_only)

    def enabled(self, name: str | None) -> bool:
        cfg = self.get(name)
        return cfg.enabled if cfg is not None else True




class Switches:
    """启停开关的唯一读取面（policies.check_switches 的数据源）。

    服务级读 DomainProvider（先 refresh，5s 快照），环境级读 EnvGate；
    任务级在 TaskDef 自身。判断逻辑只在 policies.check_switches 一处。
    """

    def __init__(self, domains: "DomainProvider | None",
                 envs: "EnvGate | None"):
        self._domains = domains
        self._envs = envs

    async def env_enabled(self, target_env: str) -> bool:
        return True if self._envs is None else await self._envs.enabled(
            target_env)

    async def domain_enabled(self, domain: str) -> bool:
        if self._domains is None:
            return True
        await self._domains.refresh()
        return self._domains.enabled(domain)


class EnvGate:
    """目标环境启停：未配置的环境默认启用。"""

    def __init__(self, defs: DefinitionStore, env: str):
        self._defs = defs
        self._env = env

    async def enabled(self, target_env: str) -> bool:
        if not target_env:
            return True
        d = await self._defs.get_active("env", self._env, target_env)
        return True if d is None else bool(d.get("enabled", True))

    async def states(self, known: list[str]) -> dict[str, bool]:
        """管理页用：已知环境（conf target_envs + 已有定义）→ 启用与否。"""
        rows = await self._defs.list_active("env", self._env)
        declared = {r["name"]: bool(r.get("enabled", True)) for r in rows}
        return {e: declared.get(e, True)
                for e in sorted({*known, *declared})}
