"""存储层：PG 连接与各表存取。每个模块对应一组表，只做读写，不做业务判断。

- db           连接池与建表（全库唯一的 schema 定义点）
- definitions  服务 / 角色 / 任务 / 平台配置的版本化定义
- runs         运行台账与事件，同时是执行队列（认领 / 心跳 / 遗留）
- instances    服务进程实例状态
- api_keys     调用方密钥
- knowledge    记忆（事实 / 教训 / 交接摘要；检索 / 时序 / 历史 / 召回埋点）
- assets       方法（文本与文件）
- feedback     评价
- replays      回归重放（批次与逐条对比）
- retention    数据保留（过程事件、checkpoint、召回埋点按天数清理）
"""
