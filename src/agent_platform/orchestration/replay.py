"""回归重放：改了角色提示词 / 任务定义 / 档案之后，拿被 👎 过的运行用当前定义重跑，看问题改好没有。

为什么只看 👎：没人会闲着点 👍，但被指出问题的运行自带"错在哪"（问题类型 + 说明 + 哪一步），
正好当判卷标准——不需要另外维护一套带标准答案的评测集。

一次重放 = 一批：
1. 选样：默认是一段时间内被 👎 的 agent 运行（可按任务 / 服务 / 环境筛），也可以直接点名运行
2. 每条原运行用同样的输入开一个重放运行（trigger=replay：新会话、不沉淀记忆、不投递）
3. 重放运行结束后，一次模型调用对照"原答案 + 人指出的问题 + 新答案"判定：
   fixed（问题解决了）/ same（问题还在）/ worse（更糟或引入新错）/ unclear（判断不了）
4. 页面上并排看原答案与新答案、判定理由，以及两边的任务 / 角色版本
"""

from __future__ import annotations

import json
import logging

from ..domain import FEEDBACK_REASONS, Caller, Rejected
from ..store import feedback as feedback_store
from ..store import replays as replays_store
from ..store import runs
from .spec import RunSpec
from .submitter import Submitter

log = logging.getLogger(__name__)

VERDICTS = ("fixed", "same", "worse", "unclear")

_JUDGE_PROMPT = """你在做回归评审。同一个问题，旧答案被人点了 👎；现在用新版本的提示词 / 定义重答了一次。
判断新答案有没有解决人指出的问题。

任务：{task}（{where}）
输入：
{input}

旧答案（被 👎）：
{old}

人指出的问题：
{issues}

新答案：
{new}

只输出 JSON，不要别的内容：{{"verdict": "fixed|same|worse|unclear", "reason": "一两句：新答案在被指出的问题上怎么样"}}
- fixed：被指出的问题解决了，且没有引入明显的新错误
- same：被指出的问题还在
- worse：问题还在且更糟，或引入了明显的新错误
- unclear：信息不够判断（比如要看实际数据才能确认）"""


class Replayer:
    def __init__(self, submitter: Submitter, model_pool):
        self._submitter = submitter
        self._pool = model_pool

    async def start(self, *, caller: Caller, run_ids: list[str] | None = None, task: str | None = None,
                    service: str | None = None, env: str | None = None, hours: int | None = None,
                    limit: int = 20, title: str = "", note: str = "") -> dict:
        filter_ = {k: v for k, v in {"run_ids": run_ids, "task": task, "service": service, "env": env,
                                     "hours": hours, "limit": limit}.items() if v}
        sources = list(dict.fromkeys(run_ids)) if run_ids else await feedback_store.negative_runs(
            task=task, service=service, env=env, hours=hours, limit=limit)
        if not sources:
            raise Rejected("nothing_to_replay", "没有符合条件的被 👎 的运行")
        replay_id = await replays_store.create(title=title or _title(task, service, env, len(sources)),
                                               filter_=filter_, note=note, by=caller.name, source_runs=sources)
        for run_id in sources:
            try:
                accepted = await self._submitter.replay(run_id, caller)
                await replays_store.set_new_run(replay_id, run_id, accepted.run_id)
            except Rejected as e:
                await replays_store.set_new_run(replay_id, run_id, None, verdict="error", reason=e.message)
        return await self.get(replay_id)

    async def get(self, replay_id: int) -> dict:
        summary = await replays_store.get(replay_id)
        if summary is None:
            raise Rejected.not_found(f"回归重放 {replay_id}")
        return {**summary, "items": await replays_store.items(replay_id)}

    async def on_finished(self, spec: RunSpec) -> None:
        """pipeline 在每次运行结束后调用；只处理重放运行。"""
        if spec.trigger.type == "replay":
            await self.judge(spec.run_id)

    async def rejudge(self, replay_id: int) -> dict:
        """把还没判定（或判定失败）、重放已结束的条目重判一遍。"""
        for item in await replays_store.items(replay_id):
            if item["new_run"] and item["verdict"] in (None, "unclear"):
                await self.judge(item["new_run"], force=True)
        return await self.get(replay_id)

    async def judge(self, new_run_id: str, force: bool = False) -> None:
        item = await replays_store.item_of_new_run(new_run_id)
        if item is None or (item["verdict"] and not force):
            return
        new, old = await runs.get(new_run_id), await runs.get(item["source_run"])
        if new is None or old is None or new["status"] not in ("success", "failed", "cancelled"):
            return
        if new["status"] != "success":
            why = (new.get("output") or {}).get("error") or new["status"]
            await replays_store.judge(item["id"], "worse" if old["status"] == "success" else "same",
                                      f"重放没有成功结束：{why}"[:500])
            return
        issues = await feedback_store.negatives_of(old["run_id"])
        prompt = _JUDGE_PROMPT.format(
            task=old["task"], where=f"{old['service'] or '平台'} · {old['env']}",
            input=json.dumps(old["input"], ensure_ascii=False, indent=1)[:3000],
            old=_answer(old)[:6000], issues=_issues(issues), new=_answer(new)[:6000])
        try:
            resp = await self._pool.chat([{"role": "user", "content": prompt}])
            verdict, reason = _parse(resp.choices[0].message.content or "")
        except Exception as e:  # noqa: BLE001 —— 判不了就标 unclear，页面上可以重判
            log.exception("回归判定失败（%s）", new_run_id)
            verdict, reason = "unclear", f"判定调用失败：{type(e).__name__}"
        await replays_store.judge(item["id"], verdict, reason)


def _title(task: str | None, service: str | None, env: str | None, n: int) -> str:
    scope = " · ".join(x for x in (task, service, env) if x) or "全部"
    return f"{scope} · {n} 条 👎"


def _answer(run: dict) -> str:
    out = run.get("output") or {}
    return str(out.get("answer") or out.get("error") or json.dumps(out, ensure_ascii=False))


def _issues(items: list[dict]) -> str:
    if not items:
        return "（没有具体说明，只知道被 👎）"
    lines = []
    for f in items:
        where = "整次回答" if f["step_seq"] == 0 else f"第 {f['step_seq']} 步（{f['step_kind'] or '?'}：{_step(f['step'])}）"
        reasons = "、".join(FEEDBACK_REASONS.get(r, r) for r in f["reasons"]) or "未选问题类型"
        lines.append(f"- {where}：{reasons}" + (f"；说明：{f['comment']}" if f["comment"] else ""))
    return "\n".join(lines)


def _step(payload: dict | None) -> str:
    if not payload:
        return ""
    text = json.dumps({k: v for k, v in payload.items() if k in ("tool", "args", "output", "content")},
                      ensure_ascii=False)
    return text[:400]


def _parse(text: str) -> tuple[str, str]:
    raw = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except (json.JSONDecodeError, ValueError):
        return "unclear", f"判定输出无法解析：{text[:200]}"
    verdict = str(data.get("verdict", "")).strip().lower()
    return (verdict if verdict in VERDICTS else "unclear"), str(data.get("reason", ""))[:1000]
