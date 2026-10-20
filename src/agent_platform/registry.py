"""定义的读写面：库里的 JSON ⇄ 类型化对象（domain 模型）。

全平台读写服务 / 角色 / 任务 / 策略 / 平台配置都经过这里：校验、跨对象引用检查、
子任务合并、默认值只在这一处。API、播种、编排共用。
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generic, TypeVar

import yaml
from pydantic import BaseModel, ValidationError

from .domain import (CONFIG_SECTIONS, EnvDef, EnvsConfig, PolicyDef, Rejected, ResolvedRole, RoleDef, RoleError,
                     ServiceDef, TaskDef, merge_task, resolve_role)
from .domain.services import check_service_name
from .domain.tasks import check_task_name, split_subtask_name
from .store.definitions import DefinitionStore, Kind

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

MODELS: dict[str, type[BaseModel]] = {"service": ServiceDef, "role": RoleDef, "task": TaskDef, "policy": PolicyDef}
LABELS = {"service": "服务", "role": "角色", "task": "任务", "policy": "策略", "config": "配置"}


@dataclass
class Entry(Generic[T]):
    """一条生效定义：名字 + 类型化内容 + 版本台账。"""

    name: str
    spec: T
    version: int
    updated_by: str
    updated_at: str

    def dump(self) -> dict[str, Any]:
        """API 形状：定义字段平铺，加上 name 与台账字段。"""
        return {"name": self.name, **self.spec.model_dump(mode="json"),
                "version": self.version, "updated_by": self.updated_by, "updated_at": self.updated_at}


def _validation_message(e: ValidationError) -> str:
    parts = []
    for err in e.errors()[:5]:
        loc = ".".join(str(x) for x in err["loc"])
        msg = err["msg"].removeprefix("Value error, ")
        parts.append(f"{loc}：{msg}" if loc else msg)
    return "；".join(parts)


class Registry:
    def __init__(self, store: DefinitionStore):
        self.store = store

    # ———————— 平台配置 ————————

    async def config(self, section: str) -> Any:
        """某节平台配置；从没保存过就是默认值。"""
        model = CONFIG_SECTIONS[section]
        row = await self.store.get("config", section)
        if row is None:
            return model()
        try:
            return model.model_validate(row["definition"])
        except ValidationError:
            log.exception("平台配置 %s v%s 不合法，按默认值处理", section, row["version"])
            return model()

    async def config_entry(self, section: str) -> dict:
        row = await self.store.get("config", section)
        spec = await self.config(section)
        return {"section": section, **spec.model_dump(mode="json"), "version": row["version"] if row else 0,
                "updated_by": row["updated_by"] if row else "", "updated_at": row["updated_at"] if row else None}

    async def put_config(self, section: str, body: dict, by: str) -> dict:
        if section not in CONFIG_SECTIONS:
            raise Rejected.not_found(f"配置节 {section}")
        spec = self._validate(CONFIG_SECTIONS[section], body)
        await self.store.put("config", section, spec.model_dump(mode="json"), by)
        return await self.config_entry(section)

    async def envs(self) -> EnvsConfig:
        return await self.config("envs")

    async def env(self, name: str | None) -> EnvDef:
        """请求里的环境 → 环境定义。不给用默认环境；给了必须存在（拼错环境名 = 打错环境）。"""
        envs = await self.envs()
        env = envs.get(name or envs.default)
        if env is None:
            raise Rejected("unknown_env", f"未知环境 {name}（可选：{'、'.join(envs.names)}）")
        return env

    # ———————— 定义：读 ————————

    async def entries(self, kind: Kind) -> list[Entry]:
        out = []
        for row in await self.store.list(kind):
            try:
                spec = MODELS[kind].model_validate(row["definition"])
            except ValidationError as e:
                log.error("%s %s v%s 不合法，已跳过：%s", LABELS[kind], row["name"], row["version"], _validation_message(e))
                continue
            out.append(Entry(row["name"], spec, row["version"], row["updated_by"], row["updated_at"]))
        return out

    async def entry(self, kind: Kind, name: str) -> Entry | None:
        row = await self.store.get(kind, name)
        if row is None:
            return None
        try:
            spec = MODELS[kind].model_validate(row["definition"])
        except ValidationError as e:
            raise Rejected("invalid_definition", f"{LABELS[kind]} {name} 的当前版本不合法：{_validation_message(e)}", 500) from e
        return Entry(name, spec, row["version"], row["updated_by"], row["updated_at"])

    async def services(self) -> list[Entry[ServiceDef]]:
        return await self.entries("service")

    async def service(self, name: str) -> Entry[ServiceDef] | None:
        return await self.entry("service", name)

    async def roles(self) -> list[Entry[RoleDef]]:
        return await self.entries("role")

    async def role(self, name: str) -> Entry[RoleDef] | None:
        return await self.entry("role", name)

    async def resolved_role(self, name: str) -> tuple[ResolvedRole, tuple[int, ...]]:
        """角色继承合并后的生效结果 + 继承链上每一层的版本号（agent 缓存键）。"""
        entries = {e.name: e for e in await self.roles()}
        try:
            role = resolve_role(name, {n: e.spec for n, e in entries.items()})
        except RoleError as e:
            raise Rejected("invalid_definition", str(e), 500) from e
        return role, tuple(entries[n].version for n in role.lineage)

    async def policies(self) -> list[Entry[PolicyDef]]:
        return sorted(await self.entries("policy"), key=lambda e: (e.spec.order, e.name))

    async def tasks(self) -> list[Entry[TaskDef]]:
        """全部任务（含子任务），存的是原样（子任务只有差异）。"""
        return await self.entries("task")

    async def task_raw(self, name: str) -> Entry[TaskDef] | None:
        return await self.entry("task", name)

    async def task(self, name: str) -> Entry[TaskDef] | None:
        """生效定义：子任务合并父任务；版本号仍是子任务自己的。"""
        own = await self.entry("task", name)
        if own is None or not own.spec.extends:
            return own
        parent = await self.entry("task", own.spec.extends)
        if parent is None:
            return own
        return Entry(name, merge_task(parent.spec, own.spec), own.version, own.updated_by, own.updated_at)

    async def subtasks(self, parent: str) -> list[Entry[TaskDef]]:
        return [e for e in await self.tasks() if e.spec.extends == parent]

    async def chat_task_for(self, service: str | None) -> str | None:
        """对话没指定任务时用哪个：该服务专属的对话任务优先，其次通用对话任务。"""
        candidates = [t for t in await self.tasks()
                      if not t.spec.extends and t.spec.enabled and t.spec.triggers_of("chat")]
        for wanted in (service, "*"):
            hit = next((t.name for t in candidates if t.spec.service == wanted), None)
            if hit:
                return hit
        return None

    # ———————— 定义：写 ————————

    def _validate(self, model: type[T], body: dict) -> T:
        try:
            return model.model_validate(body)
        except ValidationError as e:
            raise Rejected("invalid_definition", _validation_message(e), 422) from e

    @staticmethod
    def _stored(kind: str, spec: BaseModel) -> dict:
        """入库形状。子任务只存显式写过的字段，其余继续跟随父任务。"""
        diff_only = kind == "task" and bool(getattr(spec, "extends", None))
        return spec.model_dump(mode="json", exclude_unset=diff_only)

    async def create(self, kind: Kind, name: str, body: dict, by: str) -> Entry:
        if await self.store.get(kind, name) is not None:
            raise Rejected.conflict(f"{LABELS[kind]} {name} 已存在")
        spec = self._validate(MODELS[kind], _strip(body))
        await self._check(kind, name, spec)
        await self.store.put(kind, name, self._stored(kind, spec), by)
        return await self.entry(kind, name)  # type: ignore[return-value]

    async def update(self, kind: Kind, name: str, patch: dict, by: str) -> Entry:
        """局部更新：patch 里出现的顶层字段整体替换，没出现的保持不变。"""
        current = await self.store.get(kind, name)
        if current is None:
            raise Rejected.not_found(f"{LABELS[kind]} {name}")
        spec = self._validate(MODELS[kind], {**current["definition"], **_strip(patch)})
        await self._check(kind, name, spec)
        await self.store.put(kind, name, self._stored(kind, spec), by)
        return await self.entry(kind, name)  # type: ignore[return-value]

    async def delete(self, kind: Kind, name: str, by: str) -> list[str]:
        """删除；被引用的不能删（in_use）。删父任务连带删除它的子任务。返回实际删除的名字。"""
        if await self.store.get(kind, name) is None:
            raise Rejected.not_found(f"{LABELS[kind]} {name}")
        users = await self._users_of(kind, name)
        if users:
            raise Rejected("in_use", f"{LABELS[kind]} {name} 正被使用：{'、'.join(users[:8])}", 409, detail={"used_by": users})
        removed = [name]
        if kind == "task":
            removed += [s.name for s in await self.subtasks(name)]
        for n in removed:
            await self.store.delete(kind, n, by)
        return removed

    async def restore(self, kind: Kind, name: str, version: int, by: str) -> Entry:
        old = await self.store.version(kind, name, version)
        if old is None:
            raise Rejected.not_found(f"{LABELS[kind]} {name} 的版本 {version}")
        spec = self._validate(MODELS[kind], old)
        await self._check(kind, name, spec)
        await self.store.put(kind, name, self._stored(kind, spec), f"{by}（恢复 v{version}）")
        return await self.entry(kind, name)  # type: ignore[return-value]

    async def _users_of(self, kind: str, name: str) -> list[str]:
        if kind == "role":
            tasks = [f"任务 {t.name}" for t in await self.tasks() if name in {t.spec.role, *t.spec.graph_roles()}]
            roles = [f"角色 {r.name}" for r in await self.roles() if r.spec.extends == name]
            return tasks + roles
        if kind == "service":
            return [f"任务 {t.name}" for t in await self.tasks() if t.spec.service == name]
        return []

    async def _check(self, kind: str, name: str, spec: BaseModel) -> None:
        """跨对象检查：名字合法、引用的角色/服务/父任务/环境存在。"""
        try:
            if kind == "service":
                check_service_name(name)
            elif kind == "task":
                check_task_name(name)
        except ValueError as e:
            raise Rejected("invalid_definition", str(e), 422) from e

        if isinstance(spec, ServiceDef):
            await self._check_envs(list(spec.envs))
        elif isinstance(spec, RoleDef) and spec.extends:
            defs = {e.name: e.spec for e in await self.roles()} | {name: spec}
            try:
                resolve_role(name, defs)
            except RoleError as e:
                raise Rejected("invalid_definition", str(e), 422) from e
        elif isinstance(spec, TaskDef):
            await self._check_task(name, spec)

    async def _check_task(self, name: str, spec: TaskDef) -> None:
        base, obj = split_subtask_name(name)
        if obj:
            if spec.extends != base:
                raise Rejected("invalid_definition", f"子任务 {name} 的 extends 必须是 {base}", 422)
            parent = await self.entry("task", base)
            if parent is None:
                raise Rejected("invalid_definition", f"父任务 {base} 不存在", 422)
        elif spec.extends:
            raise Rejected("invalid_definition", "只有子任务（名字形如 父任务:对象）才能声明 extends", 422)
        for role in {spec.role, *spec.graph_roles()} - {None}:
            if await self.entry("role", role) is None:
                raise Rejected("invalid_definition", f"角色 {role} 不存在", 422)
        if spec.service and spec.service != "*" and await self.entry("service", spec.service) is None:
            raise Rejected("invalid_definition", f"服务 {spec.service} 不存在", 422)
        envs = list(spec.envs)
        for t in spec.triggers:
            envs += getattr(t, "envs", [])
            if t.type == "schedule" and spec.service == "*" and not t.service:
                raise Rejected("invalid_definition", f"通用任务的定时触发 {t.id} 需要指定服务", 422)
            target = getattr(t, "service", None)
            if target and await self.entry("service", target) is None:
                raise Rejected("invalid_definition", f"触发器 {t.id} 指定的服务 {target} 不存在", 422)
        await self._check_envs(envs)

    async def _check_envs(self, names: list[str]) -> None:
        known = (await self.envs()).names
        unknown = sorted(set(names) - set(known))
        if unknown:
            raise Rejected("invalid_definition", f"未知环境：{'、'.join(unknown)}（可选：{'、'.join(known)}）", 422)

    # ———————— 播种 ————————

    async def seed(self, seeds_dir: Path) -> None:
        """把 conf/seeds 里的对象写进库——只写库里从没出现过的名字（删掉的不会复活）。
        种子文件在播种之后又改过的，启动时提示一次：库内版本才是生效版本，去控制台改。

        目录：settings.yaml（平台配置各节）/ services/*.yaml（一个文件一个服务）/
              roles.yaml / tasks.yaml / policies.yaml（{名字: 定义}）。值里可用 ${环境变量}。
        """
        if not seeds_dir.is_dir():
            return

        def load(path: Path) -> dict:
            """读种子文件；值里的 ${VAR} 取环境变量，取不到为空串。"""
            if not path.is_file():
                return {}
            text = re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), ""), path.read_text())
            return yaml.safe_load(text) or {}

        for section, body in load(seeds_dir / "settings.yaml").items():
            if section in CONFIG_SECTIONS and await self.store.seeded_version("config", section) is None:
                await self.put_config(section, body or {}, "seed")
        plan: list[tuple[Kind, dict]] = [
            ("service", {p.stem: load(p) for p in sorted((seeds_dir / "services").glob("*.yaml"))}),
            ("role", load(seeds_dir / "roles.yaml")),
            ("task", load(seeds_dir / "tasks.yaml")),
            ("policy", load(seeds_dir / "policies.yaml")),
        ]
        for kind, items in plan:
            pending: dict[str, str] = {}
            for name, body in items.items():
                seen = await self.store.seeded_version(kind, name)
                if seen is None:
                    pending[name] = ""
                elif seen["seed"] is not None and seen["seed"] != self._normalized(kind, body or {}):
                    log.warning("种子 %s %s 在播种后改过；库内版本才生效，请在控制台修改", LABELS[kind], name)
            # 父角色、父任务要先于引用它的写入：一轮轮写，直到没有进展
            while pending:
                progressed = False
                for name in sorted(pending):
                    try:
                        await self.create(kind, name, items[name] or {}, "seed")
                        log.info("已播种 %s %s", LABELS[kind], name)
                        pending.pop(name)
                        progressed = True
                    except Rejected as e:
                        pending[name] = e.message
                if not progressed:
                    for name, why in pending.items():
                        log.error("种子 %s %s 不合法，跳过：%s", LABELS[kind], name, why)
                    break

    def _normalized(self, kind: str, body: dict) -> dict | None:
        try:
            return self._stored(kind, self._validate(MODELS[kind], body))
        except Rejected:
            return None


def _strip(body: dict) -> dict:
    """请求体里的台账字段不是定义的一部分。"""
    return {k: v for k, v in body.items() if k not in ("name", "version", "updated_by", "updated_at")}
