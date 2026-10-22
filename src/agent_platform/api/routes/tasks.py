"""任务的附属资源：子任务、定时。

    GET  /v1/tasks/{name}/subtasks         子任务列表（带统计）
    POST /v1/tasks/{name}/subtasks         新建子任务：{object, 以及要覆盖的字段}
    GET  /v1/tasks/{name}/schedule         接下来的定时触发
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import Rejected
from ..deps import ADMIN, RT, WHO, Caller, Runtime
from ..schemas import SubtaskBody
from .definitions import task_summaries

router = APIRouter(prefix="/v1/tasks")


@router.get("/{name}/subtasks")
async def list_subtasks(name: str, rt: Runtime = RT, _: Caller = WHO):
    children = {s.name for s in await rt.registry.subtasks(name)}
    return await task_summaries(rt, children) if children else []


@router.post("/{name}/subtasks", status_code=201)
async def create_subtask(name: str, body: SubtaskBody, rt: Runtime = RT, who: Caller = ADMIN):
    parent = await rt.registry.task_raw(name)
    if parent is None:
        raise Rejected.not_found(f"任务 {name}")
    if parent.spec.extends:
        raise Rejected("invalid_subtask", f"{name} 本身是子任务，不能再派生")
    child = f"{name}:{body.object.strip()}"
    overrides = body.model_dump(exclude={"object"}, exclude_none=True)
    await rt.registry.create("task", child, {**overrides, "extends": name}, who.name)
    return (await task_summaries(rt, {child}))[0]


@router.get("/{name}/schedule")
async def task_schedule(name: str, rt: Runtime = RT, _: Caller = WHO):
    if await rt.registry.task_raw(name) is None:
        raise Rejected.not_found(f"任务 {name}")
    return [f for f in await rt.scheduler.upcoming() if f["task"] == name or f["task"].startswith(name + ":")]
