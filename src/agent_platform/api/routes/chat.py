"""对话：多轮问答，一个会话 = 一个 LangGraph thread。

    POST /v1/chat            发一条消息。默认 SSE 推流；stream=false 时等结束返回 JSON
    GET  /v1/sessions        会话列表：service env task q
    GET  /v1/sessions/{id}   会话详情（每一轮的问题、答案、过程）

SSE 事件（每条 data 一个 JSON，type 区分）：
    run       {run_id, session_id}             已受理
    stage / model_call / tool_call / tool_result   过程（与运行事件同形；旧运行里还有 thought）
    final     {status, output}                 结束
    error     {code, message}                  受理失败
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ...domain import Rejected, RunRequest, RunTrigger
from ...store import feedback as feedback_store
from ...store import runs
from .. import views
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import ChatBody
from ..streaming import sse, tail

router = APIRouter(prefix="/v1")

PROCESS_KINDS = {"stage", "thought", "model_call", "tool_call", "tool_result"}


async def _accept(body: ChatBody, rt: Runtime, who: Caller):
    task = body.task
    if not task:
        if body.session_id and (last := await runs.latest_of_session(body.session_id)):
            task = last["task"]                                   # 续会话：沿用上一轮的任务
        else:
            task = await rt.registry.chat_task_for(body.service)
        if not task:
            raise Rejected("unknown_task", f"服务 {body.service or '—'} 没有可对话的任务（任务需声明 chat 触发）", 404)
    req = RunRequest(task=task, subtask=body.subtask, service=body.service, env=body.env,
                     input={**body.input, "question": body.message}, session_id=body.session_id, memory=body.memory)
    return await rt.submitter.submit(req, trigger=RunTrigger(type="chat", caller=who.name), caller=who)


@router.post("/chat")
async def chat(body: ChatBody, rt: Runtime = RT, who: Caller = WHO):
    if not body.stream:
        accepted = await _accept(body, rt, who)
        run = await rt.submitter.wait(accepted.run_id, 300)
        output = run.get("output") or {}
        return {"run_id": run["run_id"], "session_id": run["session_id"], "status": run["status"],
                "answer": output.get("answer"), "error": output.get("error")}

    async def stream():
        try:
            accepted = await _accept(body, rt, who)
        except Rejected as e:
            yield sse({"type": "error", "code": e.code, "message": e.message})
            return
        yield sse({"type": "run", "run_id": accepted.run_id, "session_id": accepted.session_id,
                   "subtask_created": accepted.subtask_created})
        async for item in tail(accepted.run_id):
            if item["kind"] == "event" and item["event"]["kind"] in PROCESS_KINDS:
                e = item["event"]
                yield sse({"type": e["kind"], "seq": e["seq"], **e["payload"]})
            elif item["kind"] == "done":
                run = item["run"] or {}
                yield sse({"type": "final", "status": run.get("status"), "output": run.get("output") or {}})
            elif item["kind"] == "keepalive":
                yield ": keepalive\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/sessions")
async def sessions(service: str | None = None, env: str | None = None, task: str | None = None,
                   q: str | None = None, _: Caller = WHO):
    return await runs.sessions(service=service, env=env, task=task, q=q)


@router.get("/sessions/{session_id}")
async def session(session_id: str, who: Caller = WHO):
    turns = await runs.of_session(session_id)
    if not turns:
        raise Rejected.not_found(f"会话 {session_id}")
    run_ids = [t["run_id"] for t in turns]
    events = await runs.events_of(run_ids)
    my_feedback = await feedback_store.mine(run_ids, who.name)
    last = turns[-1]
    return {"session_id": session_id, "title": turns[0]["summary"][:60], "service": last["service"], "env": last["env"],
            "task": last["task"], "runs": len(turns), "last_at": last["created_at"],
            "turns": [views.chat_turn(t, events.get(t["run_id"], []), my_feedback.get(t["run_id"])) for t in turns]}
