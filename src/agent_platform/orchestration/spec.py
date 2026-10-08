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
    target_env: str = ""            # 目标业务环境：本 run 操作哪套环境的服务
    timeout_s: int = 300
    trigger: str = "sdk"
    correction: bool = False        # 纠正式反馈触发的重判
    resume: bool = False            # 断点续跑（空输入从 checkpoint 继续）
    # —— 任务形态（三选一，空 = 单 agent 问答） ——
    artifacts: dict | None = None   # 资产化任务图快照（提交时从任务定义固化）
    handler: str | None = None      # 内建任务处理器（如 memory-gardener）
    # —— prepare_run 回填 ——
    prompt: str = ""                # 召回块 + question 拼好的最终 prompt
    domain: str | None = None
    code_paths: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> "RunSpec":
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in d.items() if k in known})

    def to_dict(self) -> dict:
        return asdict(self)

    def effective_env(self, instance_env: str) -> str:
        """本 run 实际生效的目标环境；未指定时退化为实例标签（单环境部署）。

        执行期所有按环境取值的点（记忆分区/域连接/产物复用/trace 属性）
        统一走这里，不各自写 target_env or settings.env。
        """
        return self.target_env or instance_env
