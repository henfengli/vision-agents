"""agent-platform：给同机部署的业务项目提供 agent 能力——被项目通过 API 调用，也按定时与事件自己跑。

分层（依赖单向向下）：
- domain         对象模型：服务 / 角色 / 任务 / 策略 / 运行 / 平台配置（纯 pydantic）
- store          PG 存取：定义、运行台账、审批、进程实例、记忆、密钥
- registry       定义读写面：校验、引用检查、子任务合并、播种
- services       服务进程：按环境启停（systemd / 本地）、bwrap 配置隔离、只读观察
- memory         召回 / 沉淀 / 园丁
- agent          按角色装配 agent；RunScope；人工门；工具目录
- orchestration  提交端、闸门链、Temporal workflow 与 activity、定时、维护
- triggers       事件入口与各系统回调解析
- notify         通知路由（钉钉 / Webhook）
- api            /v1 接口；webui 托管控制台
- runtime        把以上装配成一个可运行的整体；main 是命令行入口
"""

__version__ = "6.0.0"
