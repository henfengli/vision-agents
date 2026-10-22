"""回归重放：改完提示词 / 任务定义 / 档案，拿被 👎 的运行用当前定义重跑，逐条看问题改好没有。

    GET  /v1/replays                列表（新的在前），带 fixed / same / worse / unclear / pending 计数
    POST /v1/replays                发起：{task?, service?, env?, hours?, limit?, run_ids?, title?, note?}
                                    不给 run_ids 就按条件选被 👎 的 agent 运行
    GET  /v1/replays/{id}           详情：每条的原答案、新答案、两边的任务 / 角色版本、判定与理由
    POST /v1/replays/{id}/judge     把还没判定 / 判不了的条目重判一遍
"""

from __future__ import annotations

from fastapi import APIRouter

from ...store import replays as replays_store
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import ReplayBody

router = APIRouter(prefix="/v1/replays")


@router.get("")
async def list_replays(limit: int = 50, _: Caller = WHO):
    return await replays_store.listing(limit)


@router.post("", status_code=201)
async def start_replay(body: ReplayBody, rt: Runtime = RT, who: Caller = WHO):
    return await rt.replayer.start(caller=who, **body.model_dump())


@router.get("/{replay_id}")
async def get_replay(replay_id: int, rt: Runtime = RT, _: Caller = WHO):
    return await rt.replayer.get(replay_id)


@router.post("/{replay_id}/judge")
async def rejudge(replay_id: int, rt: Runtime = RT, _: Caller = WHO):
    return await rt.replayer.rejudge(replay_id)
