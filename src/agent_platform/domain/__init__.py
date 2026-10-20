"""对象模型：服务 / 角色 / 任务 / 策略 / 运行 / 平台配置。

纯 pydantic + 纯函数，不依赖存储、编排或框架——全平台对"一个对象长什么样、
合不合法、怎么合并"的唯一定义。关系规则见 docs/设计文档.md §2.2。
"""

from .errors import Rejected
from .platform import (CONFIG_SECTIONS, ApprovalsConfig, Channel, EnvDef, EnvsConfig, MemoryConfig,
                       NotificationsConfig, NotifyRule, ProcessesConfig)
from .policies import PolicyDef, PolicyScope
from .roles import ResolvedRole, RoleDef, RoleError, resolve_role
from .runs import RESOLUTIONS, RUN_STATUSES, SYSTEM, TERMINAL, Caller, RunRequest, RunTrigger
from .services import ConfigFile, EnvOverride, ProcessDef, ServiceDef, ServiceView
from .tasks import (ApiTrigger, ChatTrigger, Dedup, Deliver, EventTrigger, InputField, MemoryOverride,
                    ScheduleTrigger, TaskDef, Trigger, TriggerRule, compose_profile, merge_task, profile_lines,
                    question_text, split_subtask_name)

__all__ = [
    "ApiTrigger", "ApprovalsConfig", "CONFIG_SECTIONS", "Channel", "ChatTrigger", "ConfigFile", "Dedup", "Deliver",
    "EnvDef", "EnvOverride", "EnvsConfig", "EventTrigger", "InputField", "MemoryConfig", "MemoryOverride",
    "NotificationsConfig", "NotifyRule", "PolicyDef", "PolicyScope", "ProcessDef", "ProcessesConfig", "RESOLUTIONS",
    "RUN_STATUSES", "Caller", "SYSTEM", "Rejected", "ResolvedRole", "RoleDef", "RoleError", "RunRequest", "RunTrigger",
    "ScheduleTrigger", "ServiceDef", "ServiceView", "TERMINAL", "TaskDef", "Trigger", "TriggerRule",
    "compose_profile", "merge_task", "profile_lines", "question_text", "resolve_role", "split_subtask_name",
]
