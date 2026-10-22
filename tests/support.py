"""测试替身：内存版定义库（接口同 store.definitions.DefinitionStore），不需要 Postgres。"""

from __future__ import annotations

import asyncio
import copy
import os
import subprocess
from pathlib import Path

from agent_platform.config import ModelConfig, Settings
from agent_platform.registry import Registry

REPO = Path(__file__).resolve().parents[1]
SEEDS = REPO / "conf" / "seeds"


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], list[dict]] = {}

    async def get(self, kind, name):
        versions = self.rows.get((kind, name))
        if not versions or versions[-1]["deleted"]:
            return None
        v = versions[-1]
        return {"name": name, "version": v["version"], "definition": copy.deepcopy(v["definition"]),
                "updated_by": v["by"], "updated_at": "2026-01-01T00:00:00+00:00"}

    async def list(self, kind):
        out = [await self.get(k, n) for (k, n) in sorted(self.rows) if k == kind]
        return [x for x in out if x]

    async def history(self, kind, name):
        return [{"version": v["version"], "definition": copy.deepcopy(v["definition"]), "deleted": v["deleted"],
                 "updated_by": v["by"], "created_at": "2026-01-01T00:00:00+00:00"}
                for v in reversed(self.rows.get((kind, name), []))]

    async def version(self, kind, name, version):
        v = next((v for v in self.rows.get((kind, name), []) if v["version"] == version), None)
        return copy.deepcopy(v["definition"]) if v else None

    async def put(self, kind, name, definition, by, *, deleted=False):
        versions = self.rows.setdefault((kind, name), [])
        versions.append({"version": len(versions) + 1, "definition": copy.deepcopy(definition),
                         "deleted": deleted, "by": by})
        return len(versions)

    async def delete(self, kind, name, by):
        current = await self.get(kind, name)
        return await self.put(kind, name, current["definition"] if current else {}, by, deleted=True)

    async def seeded_version(self, kind, name):
        versions = self.rows.get((kind, name))
        if not versions:
            return None
        return {"seed": next((copy.deepcopy(v["definition"]) for v in versions if v["by"] == "seed"), None)}


def seeded_registry() -> Registry:
    reg = Registry(MemoryStore())
    asyncio.run(reg.seed(SEEDS))
    return reg


def settings(data_dir: str, **kw) -> Settings:
    return Settings(profile="test", db_dsn="postgresql://unused", root_token="root",
                    model=ModelConfig(url="http://model", name="m", tokens=["t"]), data_dir=data_dir, **kw)


def git(cwd, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=True,
                       env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                            "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1"})
    return r.stdout.strip()


def commit(repo, files: dict[str, str], message: str = "c") -> str:
    for rel, text in files.items():
        p = Path(repo) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")
