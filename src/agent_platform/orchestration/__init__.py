"""编排层：一次运行从提交到结束的全部流程。

- submitter    提交端：一切发起运行的唯一入口（新提交 / 重跑 / 续跑 / 纠正 / 取消 / 审批放行）
- gates        闸门链：能不能办，拒绝带原因码
- spec         RunSpec：一次运行的完整规格（workflow 与 activity 之间传的就是它）
- workflows    RunWorkflow（所有任务形态共用）+ ScheduleWorkflow（定时触发的落点）
- activities   各个步骤：prepare / run_agent / run_builtin / 任务图节点 / finalize / fail / deliver
- artgraph     任务图解释器（纯逻辑）
- scheduler    定时触发 ↔ Temporal Schedule 同步；下次触发时间
- maintenance  后台维护：审批过期、进程租约到期、定时对账、遗留运行收尾
- worker       Temporal Worker 装配
"""
