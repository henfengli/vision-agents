"""运行后沉淀：run 成功结束后，一次轻量模型调用提炼可复用结论入库（记忆：事实 / 教训 / 交接摘要）。

事实带 code_ref（文件路径 + 当前 commit），供召回时失效校验。
session 交接摘要用四节模板（Compaction Cliff 的教训——散文摘要最先丢
被否方案和约束，而故障分析里"排除了哪些方向"最值钱）。
"""

from __future__ import annotations

import asyncio
import json
import logging

from ..domain import PromptsConfig
from ..model import ModelPool
from ..store import knowledge as knowledge_store

log = logging.getLogger(__name__)

# 两段提示词是平台配置（设置 → 提示词：distill / handoff_summary），默认文本在 domain/prompts.py


def _parse_items(raw: str | None, run_id: str) -> list:
    """模型输出 → 条目列表。模型常给 ```json 围栏，先剥再解析；
    解析失败记 warning（静默 return 会让记忆层悄悄漏沉淀，无从排查）。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.removeprefix("```json").removeprefix("```")
        text = text.removesuffix("```").strip()
    try:
        items = json.loads(text)
    except json.JSONDecodeError:
        log.warning("run %s 沉淀输出解析失败，跳过（原文 %d 字符）",
                    run_id, len(text))
        return []
    return items if isinstance(items, list) else []


async def distill(pool: ModelPool, *, env: str, service: str, run_id: str, task: str, run_input: dict,
                  run_output: dict, code_paths: list[str], session_id: str | None = None,
                  handoff_summary: bool = True, prompts: PromptsConfig | None = None) -> None:
    """提炼本次运行的事实与教训入库；session_id 与 run_id 不同（真的在一个会话里）时再写交接摘要。
    默认记成所有环境通用（env=''），模型判断只在本环境成立的才记在本环境下。"""
    prompts = prompts or PromptsConfig()
    embedder = pool.embed  # 没配嵌入模型时它返回 None，检索退化为关键词
    resp = await pool.chat(messages=[{
        "role": "user",
        "content": prompts.distill.format(
            task=task, service=service, env=env,
            input=json.dumps(run_input, ensure_ascii=False)[:2000],
            output=json.dumps(run_output, ensure_ascii=False)[:4000]),
    }], run_id=run_id, purpose="记忆沉淀")
    try:
        raw = resp.choices[0].message.content
    except (AttributeError, IndexError, TypeError):
        raw = None
    items = _parse_items(raw, run_id)

    for item in items:
        scope = env if item.get("env_specific") is True else ""
        if item.get("kind") in ("fact", "knowledge") and item.get("key") and item.get("content"):
            code_ref = None
            if item.get("code_path"):
                # commit 必须记在 path 实际所属的代码目录上（多代码目录的服务，
                # 记错仓库的 HEAD 会让召回侧 is_entry_fresh 误判漂移）；
                # 选目录与校验共用 code_base（唯一出处）
                base = knowledge_store.code_base(item["code_path"], code_paths)
                # current_commit 跑 git subprocess，to_thread 避免阻塞事件循环
                commit = (await asyncio.to_thread(
                    knowledge_store.current_commit, base)
                    if base else None)
                code_ref = {"path": item["code_path"], "commit": commit}
            await knowledge_store.upsert(scope, service, item["key"], item["content"],
                                         source_run=run_id, code_ref=code_ref,
                                         task=task, embedder=embedder)
        elif item.get("kind") in ("lesson", "case") and item.get("conclusion"):
            error = str(run_input.get("error", ""))
            if error:
                await knowledge_store.lessons.add(scope, service, error, item.get("category", "code"),
                                                  item["conclusion"], run_id, task=task, embedder=embedder)

    # session 交接摘要：key 按 session 维度 upsert，下次同资产新 episode 召回置顶。
    if handoff_summary and session_id and session_id != run_id:
        summary = await _handoff_summary(pool, prompts.handoff_summary, run_id, task, run_input, run_output)
        if summary:
            await knowledge_store.upsert(
                env, service, f"session:{session_id}:summary", summary,
                source_run=run_id, task=task, kind="handoff")


async def _handoff_summary(pool: ModelPool, template: str, run_id: str, task: str,
                           run_input: dict, run_output: dict) -> str | None:
    try:
        resp = await pool.chat(messages=[{
            "role": "user",
            "content": template.format(
                task=task,
                input=json.dumps(run_input, ensure_ascii=False)[:2000],
                output=json.dumps(run_output, ensure_ascii=False)[:4000]),
        }], run_id=run_id, purpose="交接摘要")
        text = (resp.choices[0].message.content or "").strip()
        return text if text.startswith("##") else None
    except Exception:  # noqa: BLE001 —— 摘要失败不影响主流程，但留痕
        log.exception("session 交接摘要生成失败（%s）", task)
        return None
