"""RunSpec：一次 run 的完整规格——编排层唯一的数据结构。

Temporal 线上传输用 dict（JSON 可序列化），边界处 RunSpec.from_dict/to_dict
转换；activities 内部只碰 RunSpec，字段一目了然。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class RunSpec:
    run_id: str = ""                # 空 = 由 prepare_run 生成（调度触发）
    task_type: str = ""
    role: str = ""
    question: str = ""
    input: dict = field(default_factory=dict)
    error_text: str | None = None
    session_id: str | None = None   # 会话标识；无会话时 = run_id
    timeout_s: int = 300
    trigger: str = "sdk"
    correction: bool = False        # 纠正式反馈触发的重判
    resume: bool = False            # 断点续跑（空输入从 checkpoint 继续）
    # —— prepare_run 回填 ——
    prompt: str = ""                # 召回块 + question 拼好的最终 prompt
    domain: str | None = None
    code_paths: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> "RunSpec":
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})

    def to_dict(self) -> dict:
        return asdict(self)
