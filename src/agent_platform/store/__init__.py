"""存储层：PG 连接（db）+ 各表存取模块。

- db           连接池与 schema（全库唯一建表点）
- runs         执行台账与事件流
- definitions  角色/任务的版本化定义
- knowledge    知识库（含检索/时序化/档案）
- cases        案例库（报错指纹）
- feedback     反馈闭环
"""
