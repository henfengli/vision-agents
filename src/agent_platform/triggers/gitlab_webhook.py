"""GitLab webhook 触发端：部署完成 → readiness 探针 → frontend-smoke 任务。"""

from __future__ import annotations

import asyncio

import httpx


async def readiness_probe(base_url: str, timeout: float = 5.0,
                          retries: int = 6, interval_s: float = 10.0) -> bool:
    """部署后服务预热期不直接测：健康检查过了才放行，避免误报。"""
    for _ in range(retries):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                if (await client.get(f"{base_url}/health")).status_code == 200:
                    return True
        except httpx.HTTPError:
            pass
        await asyncio.sleep(interval_s)
    return False


def make_router(submitter, auth=None, smoke_task: str = "frontend-smoke"):
    from fastapi import APIRouter, Depends

    router = APIRouter(dependencies=[Depends(auth)] if auth else [])

    @router.post("/v1/hooks/gitlab")
    async def gitlab_hook(payload: dict):
        # 只响应 deployment 成功事件；push/MR 与"部署完成"是两回事
        if payload.get("object_kind") != "deployment" or \
           payload.get("status") != "success":
            return {"status": "ignored"}
        service = payload.get("project", {}).get("name", "")
        env = payload.get("environment", "")
        version = payload.get("ref", "")
        health_url = payload.get("health_url")
        if health_url and not await readiness_probe(health_url):
            return {"status": "readiness_failed", "note": "健康检查未通过，未触发测试"}
        # 冒烟任务名是域知识（种子在 board 域包 tasks.yaml），由装配侧注入；
        # GitLab deployment 的 environment 即目标业务环境（命名需与
        # target_envs 一致，如 prod/test/dev）
        return await submitter.submit(
            smoke_task,
            {"service": service, "version": version, "env": env},
            trigger_source="webhook", caller=service,
            target_env=env or None)

    return router
