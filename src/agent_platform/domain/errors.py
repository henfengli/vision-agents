"""拒绝：一切"这个请求不能办"的统一出口，带机器可读原因码。"""

from __future__ import annotations


class Rejected(ValueError):
    """请求被拒。code 是稳定的原因码（API 的 error.code），status 是 HTTP 状态。

    原因码清单（对外契约，见 docs/外部接口文档.md）：
    - 闸门：service_disabled / service_env_disabled / task_disabled / env_not_allowed /
      trigger_not_allowed / policy
    - 解析：unknown_task / unknown_service / unknown_env / service_required /
      service_not_allowed / invalid_subtask / invalid_input / invalid_definition
    - 权限：unauthorized / forbidden
    - 状态：not_found / conflict / in_use / already_finished / already_decided / not_running
    """

    def __init__(self, code: str, message: str, status: int = 400, detail: object = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail

    @classmethod
    def not_found(cls, what: str) -> "Rejected":
        return cls("not_found", f"{what} 不存在", 404)

    @classmethod
    def conflict(cls, message: str) -> "Rejected":
        return cls("conflict", message, 409)
