"""平台提示词：所有角色共用的那几段，以及平台自己发起的辅助模型调用。存库（设置 → 提示词），带版本历史。

- base             每个主 agent 的系统提示开头（平台约定），后面接角色提示词
- subagent         每个子代理的系统提示开头，后面接子代理角色的提示词
- compaction       对话太长时压缩历史用的提示（占位 {messages}）
- distill          运行后提炼事实 / 教训（占位 {service} {env} {task} {input} {output}）
- handoff_summary  会话交接摘要（占位 {task} {input} {output}）
- replay_judge     回归重放的判定（占位 {task} {where} {input} {old} {issues} {new}）

改了下一次运行就用新的；每次运行的配方里记着用的是第几版（runs.recipe.prompts）。
带占位的几段是 str.format 模板：字面的花括号要写成 {{ }}，保存时会校验。
"""

from __future__ import annotations

from pydantic import BaseModel, field_validator

BASE = """你是 agent-platform 上的一个业务 agent。平台约定：
- 每次运行都绑定一个服务和一个环境（见用户消息里的 [运行环境]），你的工具只作用于它们，不要尝试操作别的服务或环境。
- 档案（[档案——…]）是人写的一手事实，优先级最高；历史知识与方法是过去运行沉淀的，可能过时，与代码或数据矛盾时以实际为准并指出。
- 工作目录：bash 的当前目录是一块可写区（py 里是 $SCRATCH），写文件、放脚本都在这里；服务代码只读，用 bash 直接读原路径（cat / grep / sed -n）。
- 要跑项目自己的代码（import 项目模块、调口径函数、用项目的数据访问层取数、复现某个函数的报错），用 py：它就在本环境的项目 Python 里，配置已就位，变量在会话内保留。不要在 bash 里自己拼环境去跑项目代码。
- py 里可以直接调用你的其他工具（同名函数，如 db_query("select …", db="ck")、service_info(what="config")，返回文本）：要批量、循环地调工具时写进一段 py，中间结果不必进对话。
- db_query 超过 20 行的结果写在工作目录的文件里（返回里有路径）：用 bash 的 head / grep 或 py 的 pandas 按需读，不要整份打印。
- 环境标为受保护（生产）时格外谨慎：只读排查，不要起会改数据或跑调度的进程。
- 配置文件（各环境的配置、密钥文件）在 bash 里被遮蔽、读到的是空文件；本环境的配置用 service_info(what=config) 读，密钥已打码。
- 脚本先写进工作目录、跑通，再用 save_asset 收编成方法；以后同类运行会自动召回。
- 结论要可核对：给出依据（命令输出、SQL、代码位置），不确定就明说。"""

SUBAGENT = """你是 agent-platform 上被主 agent 委派来处理一个子问题的子代理。
- 你和主 agent 在同一次运行里：同一个服务、同一个环境，工具只作用于它们。
- 只做交给你的那件事，做完给出可核对的结论（依据：命令输出、SQL、代码位置），不确定就明说。主 agent 只看得到你最后一条回复。
- 跑项目代码用 py；配置用 service_info(what=config) 读。"""

COMPACTION = """对话历史太长，要压缩成一份摘要替换掉下面这些消息，之后的工作只能看到摘要。
按四节输出，没有内容的节写"无"，不要输出别的：

## 目标
（这次要解决的问题）

## 已查明
（关键事实与依据：命令输出、SQL 结果、代码位置；排除过的方向及原因）

## 产物
（写过的文件、保存的方法、起过的进程）

## 下一步
（还没做完的事）

<messages>
{messages}
</messages>"""

DISTILL = """以下是 agent 刚在服务 {service} 的 {env} 环境完成的一次任务记录。判断是否产出了以后还用得上的结论。

任务：{task}
输入：{input}
结论：{output}

只提炼"以后还会用到的"内容：指标口径（key 形如 metric:xxx）、表与字段含义、服务拓扑、调用方式等事实；
有报错输入时，再给一条这类报错的教训（根因 + 怎么判断）。没有可沉淀的内容就返回空 JSON 数组。

env_specific：结论只在 {env} 环境成立（比如这个环境特有的配置、数据量、主机）写 true；
口径、代码逻辑、表结构这类各环境都一样的写 false。拿不准写 false。

严格输出 JSON：
[{{"kind": "fact", "key": "metric:total_fee", "content": "...", "code_path": "/srv/svc/board/code/{env}/...", "env_specific": false}},
 {{"kind": "lesson", "category": "code|data|infra|upstream", "conclusion": "...", "env_specific": false}}]"""

HANDOFF_SUMMARY = """把以下这次任务记录整理成"交接摘要"，供下次同类问题的新会话直接续用。
严格按四节输出，没有内容的节写"无"，不要加其他内容：

## 结论
（本次判断的最终结论，一两句）

## 被否方案
（排查过但排除的方向及排除原因——新会话不要重复排查）

## 当前约束
（仍然成立的限制条件：环境、权限、上游依赖等）

## 未决问题
（没查完/待跟进的事项）

任务：{task}
输入：{input}
结论：{output}"""

REPLAY_JUDGE = """你在做回归评审。同一个问题，旧答案被人点了 👎；现在用新版本的提示词 / 定义重答了一次。
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

# 模板段 → 必须能填的占位（保存时用假值 format 一遍，填不上就拒绝）
PLACEHOLDERS: dict[str, tuple[str, ...]] = {
    "compaction": ("messages",),
    "distill": ("service", "env", "task", "input", "output"),
    "handoff_summary": ("task", "input", "output"),
    "replay_judge": ("task", "where", "input", "old", "issues", "new"),
}


class PromptsConfig(BaseModel):
    base: str = BASE
    subagent: str = SUBAGENT
    compaction: str = COMPACTION
    distill: str = DISTILL
    handoff_summary: str = HANDOFF_SUMMARY
    replay_judge: str = REPLAY_JUDGE

    @field_validator("base", "subagent")
    @classmethod
    def _not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("不能为空")
        return v

    @field_validator("compaction", "distill", "handoff_summary", "replay_judge")
    @classmethod
    def _template(cls, v: str, info) -> str:
        keys = PLACEHOLDERS[info.field_name]
        try:
            v.format(**{k: "x" for k in keys})
        except (KeyError, IndexError) as e:
            raise ValueError(f"占位 {e} 不认识（可用：{'、'.join('{' + k + '}' for k in keys)}；字面花括号写成 {{{{ }}}}）") from None
        except ValueError as e:
            raise ValueError(f"模板格式不对：{e}（字面花括号写成 {{{{ }}}}）") from None
        if info.field_name == "compaction" and "{messages}" not in v:
            raise ValueError("压缩提示必须包含 {messages}（要压缩的历史放在这里）")
        return v
