"""设置：平台配置（对所有人生效、带版本历史）与 API 密钥。个人偏好存在浏览器里，不经过后端。

    GET  /v1/settings                               全部配置节
    GET  /v1/settings/{section}                     section ∈ envs notifications memory processes prompts
    PUT  /v1/settings/{section}                     整节替换（通知渠道的 token 传 "***" 表示不改）
    GET  /v1/settings/{section}/versions
    POST /v1/settings/{section}/versions/{v}/restore
    GET  /v1/settings/prompts/version-stats         平台提示词每个版本的运行效果
    POST /v1/settings/notifications/test            {channel} 发一条测试消息

    GET    /v1/api-keys
    POST   /v1/api-keys                             返回里的 token 只出现这一次
    PATCH  /v1/api-keys/{id}                        改备注 / 过期时间
    DELETE /v1/api-keys/{id}                        吊销
"""

from __future__ import annotations

from fastapi import APIRouter

from ...domain import CONFIG_SECTIONS, Rejected
from ...notify import Message
from ...store import api_keys, runs
from ..deps import RT, WHO, Caller, Runtime
from ..schemas import ApiKeyCreate, ApiKeyPatch, ChannelTest

router = APIRouter(prefix="/v1")

MASK = "***"


def _section(section: str) -> str:
    if section not in CONFIG_SECTIONS:
        raise Rejected.not_found(f"配置节 {section}（可选：{'、'.join(CONFIG_SECTIONS)}）")
    return section


async def _shown(rt: Runtime, section: str) -> dict:
    """渠道 token 不回显。"""
    return _masked(section, await rt.registry.config_entry(section))


def _masked(section: str, body: dict) -> dict:
    if section == "notifications":
        for ch in (body.get("channels") or {}).values():
            if ch.get("token"):
                ch["token"] = MASK
    return body


@router.get("/settings")
async def all_settings(rt: Runtime = RT, _: Caller = WHO):
    return {s: await _shown(rt, s) for s in CONFIG_SECTIONS}


@router.get("/settings/{section}")
async def get_section(section: str, rt: Runtime = RT, _: Caller = WHO):
    return await _shown(rt, _section(section))


@router.put("/settings/{section}")
async def put_section(section: str, body: dict, rt: Runtime = RT, who: Caller = WHO):
    _section(section)
    body = {k: v for k, v in body.items() if k not in ("section", "version", "updated_by", "updated_at")}
    if section == "notifications":
        previous = await rt.registry.config("notifications")
        for name, ch in (body.get("channels") or {}).items():
            if ch.get("token") == MASK:
                ch["token"] = previous.channels[name].token if name in previous.channels else ""
    await rt.registry.put_config(section, body, who.name)
    return await _shown(rt, section)


@router.get("/settings/{section}/versions")
async def section_versions(section: str, rt: Runtime = RT, _: Caller = WHO):
    history = await rt.registry.store.history("config", _section(section))
    return [{**h, "definition": _masked(section, h["definition"])} for h in history]


@router.get("/settings/prompts/version-stats")
async def prompts_version_stats(_: Caller = WHO):
    """平台提示词每个版本跑出来的效果（按运行配方里记的版本聚合）。"""
    return await runs.version_stats("prompts", "prompts")


@router.post("/settings/{section}/versions/{version}/restore")
async def restore_section(section: str, version: int, rt: Runtime = RT, who: Caller = WHO):
    old = await rt.registry.store.version("config", _section(section), version)
    if old is None:
        raise Rejected.not_found(f"{section} 的版本 {version}")
    await rt.registry.put_config(section, old, f"{who.name}（恢复 v{version}）")
    return await _shown(rt, section)


@router.post("/settings/notifications/test")
async def test_channel(body: ChannelTest, rt: Runtime = RT, who: Caller = WHO):
    try:
        await rt.notifier.send(body.channel, Message(title="agent-platform 测试消息",
                                                     text=f"{who.name} 在设置页发送的测试消息，收到即渠道可用。"))
    except Rejected:
        raise
    except Exception as e:  # noqa: BLE001 —— 把渠道侧的错误原样告诉操作人
        raise Rejected("channel_failed", f"发送失败：{type(e).__name__}: {str(e)[:300]}", 502) from e
    return {"ok": True}


# ———————— API 密钥 ————————

@router.get("/api-keys")
async def list_keys(_: Caller = WHO):
    return await api_keys.listing()


@router.post("/api-keys", status_code=201)
async def create_key(body: ApiKeyCreate, who: Caller = WHO):
    if any(k["name"] == body.name for k in await api_keys.listing()):
        raise Rejected.conflict(f"已有名为 {body.name} 的密钥")
    key, token = await api_keys.create(name=body.name, note=body.note, by=who.name, expires_at=body.expires_at)
    return {**key, "token": token}


@router.patch("/api-keys/{key_id}")
async def patch_key(key_id: int, body: ApiKeyPatch, _: Caller = WHO):
    current = next((k for k in await api_keys.listing() if k["id"] == key_id), None)
    if current is None:
        raise Rejected.not_found(f"密钥 {key_id}")
    merged = {**current, **body.model_dump(exclude_unset=True)}
    return await api_keys.update(key_id, note=merged["note"], expires_at=merged["expires_at"])


@router.delete("/api-keys/{key_id}")
async def revoke_key(key_id: int, _: Caller = WHO):
    key = await api_keys.revoke(key_id)
    if key is None:
        raise Rejected.not_found(f"密钥 {key_id}")
    return key
