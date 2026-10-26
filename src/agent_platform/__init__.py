"""agent-platform：和业务项目同机、同用户部署，给项目提供 agent 能力——被项目通过 API 调用，也按定时与事件自己跑。
多个节点（生产机、测试机）共用一套 PG 与控制台，运行按服务环境所在节点领取。

分层（依赖单向向下）：
- domain         对象模型：服务 / 角色 / 任务 / 运行 / 平台配置与平台提示词（纯 pydantic）
- store          PG 存取：定义、运行台账（兼执行队列）、节点心跳、agent 只读配置、记忆、密钥、回归重放
- registry       定义读写面：校验、引用检查、子任务合并、播种
- services       服务环境：运行规格与只读配置落地、项目内核、bwrap 隔离、日志与主机状况、只读观察
- memory         召回 / 沉淀 / 园丁
- agent          按角色装配 agent；RunScope；工具目录
- orchestration  提交端、闸门链、执行队列与步骤、定时、回归重放、维护
- triggers       事件入口与各系统回调解析
- notify         通知路由（钉钉 / Webhook）
- api            /v1 接口；webui 托管控制台
- runtime        把以上装配成一个可运行的整体；main 是命令行入口
"""

__version__ = "9.0.0"
