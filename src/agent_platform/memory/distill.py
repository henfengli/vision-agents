"""运行后沉淀：run 成功结束后，一次轻量模型调用提炼可复用结论入库。

知识条目带 code_ref（文件路径 + 当前 commit），供召回时失效校验。
session 交接摘要用四节模板（Compaction Cliff 的教训——散文摘要最先丢
被否方案和约束，而故障分析里"排除了哪些方向"最值钱）。
"""

from __future__ import annotations

import json

from ..model import ModelPool
from ..store import cases as cases_store
from ..store import knowledge as knowledge_store

_DISTILL_PROMPT = """以下是 agent 刚完成的一次任务记录。判断是否产出了可复用结论。

任务类型：{task_type}
输入：{input}
结论：{output}

只提炼"以后还会用到的"内容：指标口径（key 形如 metric:xxx）、服务拓扑、报错根因模式等。
没有可沉淀的内容就返回空 JSON 数组。

严格输出 JSON：
[{{"kind": "knowledge", "key": "metric:total_fee", "content": "...", "code_path": "/srv/board/..."}},
 {{"kind": "case", "category": "code|data|infra|upstream", "conclusion": "..."}}]"""

_SUMMARY_PROMPT = """把以下这次任务记录整理成"交接摘要"，供下次同类问题的新会话直接续用。
严格按四节输出，没有内容的节写"无"，不要加其他内容：

## 结论
（本次判断的最终结论，一两句）

## 被否方案
（排查过但排除的方向及排除原因——新会话不要重复排查）

## 当前约束
（仍然成立的限制条件：环境、权限、上游依赖等）

## 未决问题
（没查完/待跟进的事项）

任务类型：{task_type}
输入：{input}
结论：{output}"""


async def distill(pool: ModelPool, env: str, domain: str | None, run_id: str,
                  task_type: str, run_input: dict, run_output: dict,
                  code_paths: list[str], session_id: str | None = None) -> None:
    embedder = pool.embed  # ModelPool.embed：未配置嵌入模型时为 None
    resp = await pool.chat(messages=[{
        "role": "user",
        "content": _DISTILL_PROMPT.format(
            task_type=task_type,
            input=json.dumps(run_input, ensure_ascii=False)[:2000],
            output=json.dumps(run_output, ensure_ascii=False)[:4000]),
    }])
    try:
        items = json.loads(resp.choices[0].message.content)
    except (json.JSONDecodeError, AttributeError, IndexError):
        return  # 沉淀失败不影响主流程

    for item in items if isinstance(items, list) else []:
        if item.get("kind") == "knowledge" and domain:
            code_ref = None
            if item.get("code_path"):
                code_ref = {"path": item["code_path"],
                            "commit": knowledge_store.current_commit(code_paths[0])
                            if code_paths else None}
            await knowledge_store.upsert(env, domain, item["key"], item["content"],
                                         source_run=run_id, code_ref=code_ref,
                                         embedder=embedder)
        elif item.get("kind") == "case":
            error = str(run_input.get("error", ""))
            if error:
                await cases_store.add(env, domain, error,
                                      item.get("category", "code"),
                                      item.get("conclusion", ""), run_id)

    # session 交接摘要：key 按 session 维度 upsert，下次同资产新 episode 召回置顶。
    if session_id and domain:
        summary = await _handoff_summary(pool, task_type, run_input, run_output)
        if summary:
            await knowledge_store.upsert(
                env, domain, f"session:{session_id}:summary", summary,
                source_run=run_id, embedder=embedder)


async def _handoff_summary(pool: ModelPool, task_type: str,
                           run_input: dict, run_output: dict) -> str | None:
    try:
        resp = await pool.chat(messages=[{
            "role": "user",
            "content": _SUMMARY_PROMPT.format(
                task_type=task_type,
                input=json.dumps(run_input, ensure_ascii=False)[:2000],
                output=json.dumps(run_output, ensure_ascii=False)[:4000]),
        }])
        text = (resp.choices[0].message.content or "").strip()
        return text if text.startswith("##") else None
    except Exception:  # noqa: BLE001 —— 摘要失败不影响主流程
        return None
