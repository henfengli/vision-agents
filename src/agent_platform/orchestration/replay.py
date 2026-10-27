"""回归重放：改了提示词 / 任务定义 / 档案 / 记忆（包括 👎 带来的扣分）之后，拿过去的运行用现在的一切重跑，
看问题改好没有、别的有没有退步。

样本两种：
- 被 👎 的（默认）：自带"错在哪"（问题类型 + 说明 + 哪一步），正好当判卷标准，不用另外维护评测集
- 最近的 agent 运行（negative_only=false）或直接点名的任意运行：没人指出问题的，把原答案当参照，看有没有退步

一次重放 = 一批：
1. 选样：按任务 / 服务 / 环境 / 时间筛，也可以直接点名运行
2. 每条原运行用同样的输入开一个重放运行（trigger=replay：新会话、不投递）
3. 记忆隔离（pipeline / recall / 工具里按 RunSpec.replay_of 处理）：
   - 召回用现在的记忆，但去掉原运行自己沉淀的（事实、教训、交接摘要、方法）——不然等于把原答案抄回来
   - 交接摘要按原运行的会话找"前序会话"，只要原运行之前就有的、不含原会话自己的（和原运行当时看到的一致）
   - 只读：不沉淀、不记召回命中、不记方法复用、不标过期；save_asset / notify 不执行
4. 重放运行结束后，一次模型调用对照"原答案 + 人指出的问题 + 新答案"判定：
   fixed（问题解决了 / 明显更好）/ same（问题还在 / 没有退步）/ worse（更糟或引入新错）/ unclear（判断不了）
5. 页面上并排看原答案与新答案、判定理由，以及两边的配方（任务 / 角色 / 子代理 / 服务 / 平台提示词各是第几版）
"""

from __future__ import annotations

import json
import logging

from ..domain import FEEDBACK_REASONS, Caller, Rejected
from ..domain.prompts import REPLAY_JUDGE, REPLAY_JUDGE_V1
from ..registry import Registry
from ..store import feedback as feedback_store
from ..store import replays as replays_store
from ..store import runs
from .spec import RunSpec
from .submitter import Submitter

log = logging.getLogger(__name__)

VERDICTS = ("fixed", "same", "worse", "unclear")

# 判定提示词是平台配置（设置 → 提示词：replay_judge），默认文本在 domain/prompts.py


class Replayer:
    def __init__(self, submitter: Submitter, model_pool, registry: Registry):
        self._submitter = submitter
        self._pool = model_pool
        self._registry = registry

    async def start(self, *, caller: Caller, run_ids: list[str] | None = None, task: str | None = None,
                    service: str | None = None, env: str | None = None, hours: int | None = None,
                    negative_only: bool = True, limit: int = 20, title: str = "", note: str = "") -> dict:
        filter_ = {k: v for k, v in {"run_ids": run_ids, "task": task, "service": service, "env": env,
                                     "hours": hours, "limit": limit}.items() if v}
        if not run_ids and not negative_only:
            filter_["negative_only"] = False
        pick = feedback_store.negative_runs if negative_only else feedback_store.recent_agent_runs
        sources = list(dict.fromkeys(run_ids)) if run_ids else await pick(
            task=task, service=service, env=env, hours=hours, limit=limit)
        if not sources:
            raise Rejected("nothing_to_replay", "没有符合条件的" + ("被 👎 的运行" if negative_only else " agent 运行"))
        auto = (f"指定的 {len(sources)} 条运行" if run_ids
                else _title(task, service, env, len(sources), "👎" if negative_only else "最近运行"))
        replay_id = await replays_store.create(title=title or auto,
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
        template = (await self._registry.config("prompts")).replay_judge
        if template.strip() == REPLAY_JUDGE_V1.strip():
            template = REPLAY_JUDGE          # 存着的还是旧版默认（只会判 👎 的）：换成现在的默认
        prompt = template.format(
            task=old["task"], where=f"{old['service'] or '平台'} · {old['env']}",
            input=json.dumps(old["input"], ensure_ascii=False, indent=1)[:3000],
            old=_answer(old)[:6000], issues=_issues(issues), new=_answer(new)[:6000])
        try:
            resp = await self._pool.chat([{"role": "user", "content": prompt}], run_id=new_run_id, purpose="回归判定")
            verdict, reason = _parse(resp.choices[0].message.content or "")
        except Exception as e:  # noqa: BLE001 —— 判不了就标 unclear，页面上可以重判
            log.exception("回归判定失败（%s）", new_run_id)
            verdict, reason = "unclear", f"判定调用失败：{type(e).__name__}"
        await replays_store.judge(item["id"], verdict, reason)


def _title(task: str | None, service: str | None, env: str | None, n: int, what: str) -> str:
    scope = " · ".join(x for x in (task, service, env) if x) or "全部"
    return f"{scope} · {n} 条{what}"


def _answer(run: dict) -> str:
    out = run.get("output") or {}
    return str(out.get("answer") or out.get("error") or json.dumps(out, ensure_ascii=False))


def _issues(items: list[dict]) -> str:
    if not items:
        return "（无：这次运行没人指出问题。把旧答案当参照，看新答案有没有退步）"
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
