"""运行。

    POST /v1/runs                         发起（请求头 Idempotency-Key 可选；wait 秒内结束则直接带结果返回）
    GET  /v1/runs                         列表：status service env task trigger caller session_id q hours since until cursor limit
    GET  /v1/runs/{id}                    详情
    GET  /v1/runs/{id}/events?after=      事件（时间线）
    GET  /v1/runs/{id}/stream?after=      事件推流（SSE），运行结束即关闭
    POST /v1/runs/{id}/cancel | rerun | resume
    POST /v1/runs/{id}/correct            纠正：同会话开新一轮 {text}

反馈（评价）的端点在 feedback.py。
"""

from __future__ import annotations

from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse

from ...domain import Rejected, RunRequest, RunTrigger
from ...store import runs
from .. import views
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import CorrectBody, RunBody
from ..streaming import sse, tail

router = APIRouter(prefix="/v1/runs")


async def task_titles(rt: Runtime) -> dict[str, str]:
    return {t.name: t.spec.title for t in await rt.registry.tasks() if t.spec.title}


async def _run(run_id: str) -> dict:
    run = await runs.get(run_id)
    if run is None:
        raise Rejected.not_found(f"运行 {run_id}")
    return run


@router.post("", status_code=202)
async def submit(body: RunBody, idempotency_key: str | None = Header(None, max_length=200), rt: Runtime = RT,
                 who: Caller = WHO):
    """控制台发起的记为 web（不受任务的触发声明约束）；其余调用方记为 api。"""
    req = RunRequest(**body.model_dump(exclude={"wait"}))
    trigger = RunTrigger(type="web" if who.kind == "user" else "api", caller=who.name)
    accepted = await rt.submitter.submit(req, trigger=trigger, caller=who, idempotency_key=idempotency_key)
    if body.wait:
        run = await rt.submitter.wait(accepted.run_id, body.wait)
        accepted.status, accepted.output = run["status"], run.get("output")
    return accepted.dump()


@router.get("")
async def list_runs(status: str | None = None, service: str | None = None, env: str | None = None,
                    task: str | None = None, trigger: str | None = None, caller: str | None = None,
                    session_id: str | None = None, q: str | None = None, hours: int | None = None,
                    since: str | None = None, until: str | None = None,
                    cursor: str | None = None, limit: int = 30, rt: Runtime = RT, _: Caller = WHO):
    try:
        page = await runs.list_filtered(status=status, env=env, service=service, task=task, trigger=trigger,
                                        caller=caller, session=session_id, q=q, hours=hours, since=since, until=until,
                                        cursor=cursor, limit=limit)
    except ValueError as e:
        raise Rejected("invalid_request", str(e), 422) from e
    titles = await task_titles(rt)
    return {**page, "items": [views.list_item(r, titles) for r in page["items"]]}


@router.get("/{run_id}")
async def get_run(run_id: str, rt: Runtime = RT, _: Caller = WHO):
    return await views.run_detail(await _run(run_id), await task_titles(rt))


@router.get("/{run_id}/events")
async def run_events(run_id: str, after: int = 0, _: Caller = WHO):
    await _run(run_id)
    return await runs.events(run_id, after_seq=after)


@router.get("/{run_id}/stream")
async def run_stream(run_id: str, after: int = 0, _: Caller = WHO):
    """SSE：每条 data 是一个 RunEvent；最后一条 {"done": true, "status": …}。"""
    await _run(run_id)

    async def body():
        async for item in tail(run_id, after):
            if item["kind"] == "event":
                yield sse(item["event"])
            elif item["kind"] == "done":
                yield sse({"done": True, "status": item["run"]["status"] if item["run"] else None})
            else:
                yield ": keepalive\n\n"
    return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.post("/{run_id}/cancel")
async def cancel(run_id: str, rt: Runtime = RT, who: Caller = WHO):
    await rt.submitter.cancel(run_id, who)
    return await views.run_detail(await _run(run_id), await task_titles(rt))


@router.post("/{run_id}/rerun", status_code=202)
async def rerun(run_id: str, rt: Runtime = RT, who: Caller = WHO):
    return (await rt.submitter.rerun(run_id, who)).dump()


@router.post("/{run_id}/resume", status_code=202)
async def resume(run_id: str, rt: Runtime = RT, who: Caller = WHO):
    return (await rt.submitter.resume(run_id, who)).dump()


@router.post("/{run_id}/correct", status_code=202)
async def correct(run_id: str, body: CorrectBody, rt: Runtime = RT, who: Caller = WHO):
    """纠正本身就是一次运行（trigger=correction，输入里带纠正原文），不另外留档。"""
    await _run(run_id)
    return (await rt.submitter.correct(run_id, body.text, who)).dump()