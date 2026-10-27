"""对象模型：服务 / 角色 / 任务 / 运行 / 平台配置。

纯 pydantic + 纯函数，不依赖存储、编排或框架——全平台对"一个对象长什么样、
合不合法、怎么合并"的唯一定义。关系规则见 docs/设计文档.md §2.2。
"""

from .errors import Rejected
from .feedback import FEEDBACK_REASONS, WHOLE_RUN, Feedback
from .platform import CONFIG_SECTIONS, Channel, EnvDef, EnvsConfig, MemoryConfig, NotificationsConfig, NotifyRule
from .prompts import PromptsConfig
from .roles import ResolvedRole, RoleDef, RoleError, resolve_role
from .runs import ACTIVE, RESOLUTIONS, RUN_STATUSES, SYSTEM, TERMINAL, Caller, RunRequest, RunTrigger
from .services import EnvOverride, ServiceDef, ServiceView
from .tasks import (BUILTIN_HANDLERS, ApiTrigger, ChatTrigger, Dedup, Deliver, EventTrigger, InputField,
                    MemoryOverride, ScheduleTrigger, TaskDef, Trigger, TriggerRule, compose_profile, consistency_error,
                    merge_task, object_value, profile_lines, question_text, split_subtask_name)

__all__ = [
    "ACTIVE", "ApiTrigger", "CONFIG_SECTIONS", "Channel", "ChatTrigger", "Dedup",
    "Deliver", "EnvDef", "EnvOverride", "EnvsConfig", "EventTrigger", "FEEDBACK_REASONS", "Feedback", "InputField",
    "MemoryConfig", "MemoryOverride", "NotificationsConfig", "NotifyRule",
    "PromptsConfig",
    "RESOLUTIONS", "RUN_STATUSES", "Caller", "SYSTEM", "Rejected", "ResolvedRole", "RoleDef", "RoleError",
    "RunRequest", "RunTrigger", "ScheduleTrigger", "ServiceDef", "ServiceView", "TERMINAL",
    "TaskDef", "Trigger",
    "TriggerRule", "WHOLE_RUN", "compose_profile", "merge_task", "profile_lines", "question_text", "resolve_role",
    "split_subtask_name", "BUILTIN_HANDLERS", "consistency_error", "object_value",
]
