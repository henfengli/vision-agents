"""编排层：一次运行从提交到结束的全部流程。不依赖外部编排服务：runs 表就是队列。

- submitter    提交端：一切发起运行的唯一入口（新提交 / 重跑 / 续跑 / 纠正 / 重放 / 取消）
- gates        闸门链：能不能办，拒绝带原因码
- spec         RunSpec：一次运行的完整规格
- pipeline     一次运行的各个步骤：prepare / agent / 内建 / finalize / fail / deliver
- executor     执行队列的消费端：认领、限并发、心跳、取消
- scheduler    定时触发（进程内按 cron）；下次触发时间
- replay       回归重放：被 👎 的运行用当前定义重跑并判定
- maintenance  后台维护：遗留运行收尾、数据保留
"""
