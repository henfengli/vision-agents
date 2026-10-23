"""定义里的口令：存占位、用时取值、对外不回显。

- 定义（服务的只读库、通知渠道、进程环境变量）里写 ${VAR}，真实值放在 secrets.env。
  库里与接口里只有占位；expand() 在真正连库 / 发送 / 起进程的那一刻取环境变量。
- 直接写了明文的（控制台里手填），接口回显时把口令换成 ***；保存时原样传回 *** 表示不改，
  restore_*() 用库里的当前值换回去——和通知渠道 token 的约定一致。
"""

from __future__ import annotations

import copy
import os
import re

MASK = "***"
_VAR = re.compile(r"\$\{(\w+)\}")
_DSN = re.compile(r"^(?P<head>[a-z][\w+.-]*://[^:/@]*:)(?P<password>.*)(?P<tail>@[^@]*)$", re.IGNORECASE | re.DOTALL)


class MissingSecret(KeyError):
    """占位引用的环境变量没设置。"""

    def __str__(self) -> str:
        return f"环境变量 {self.args[0]} 未设置（放进 secrets.env 后重启平台）"


def expand(text: str) -> str:
    """${VAR} → 环境变量的值；没设置抛 MissingSecret。"""
    def sub(m: re.Match) -> str:
        if m.group(1) not in os.environ:
            raise MissingSecret(m.group(1))
        return os.environ[m.group(1)]
    return _VAR.sub(sub, text)


def is_placeholder(value: str) -> bool:
    return bool(_VAR.fullmatch(value.strip()))


def redact_dsn(dsn: str | None) -> str | None:
    """口令是占位就原样显示（不是秘密），明文口令换成 ***。"""
    if not dsn:
        return dsn
    m = _DSN.match(dsn)
    if m is None or not m["password"] or is_placeholder(m["password"]) or m["password"] == MASK:
        return dsn
    return f"{m['head']}{MASK}{m['tail']}"


def restore_dsn(new: str | None, current: str | None) -> str | None:
    """保存时：口令是 *** 且其余部分与当前值一致 → 换回当前值（没改口令）。"""
    if not new or not current:
        return new
    m = _DSN.match(new)
    if m is None or m["password"] != MASK:
        return new
    return current if redact_dsn(current) == new else new


def _db_maps(body: dict):
    """服务定义里放只读库连接串的位置：顶层 databases + 各环境覆盖的 databases，各是 {库名: 连接串}。"""
    if isinstance(body.get("databases"), dict):
        yield None, body["databases"]
    for env, override in (body.get("envs") or {}).items():
        if isinstance(override, dict) and isinstance(override.get("databases"), dict):
            yield env, override["databases"]


def redact_service(body: dict) -> dict:
    out = copy.deepcopy(body)
    for _env, dbs in _db_maps(out):
        for name, url in dbs.items():
            if url:
                dbs[name] = redact_dsn(url)
    return out


def restore_service(body: dict, current: dict) -> dict:
    """body 是请求体（可能只含部分顶层字段），current 是库里的当前定义。"""
    out = copy.deepcopy(body)
    for env, dbs in _db_maps(out):
        holder = current if env is None else (current.get("envs") or {}).get(env) or {}
        old = holder.get("databases") or {}
        for name, url in dbs.items():
            dbs[name] = restore_dsn(url, old.get(name))
    return out


def unresolved_mask(body: dict) -> str | None:
    """还残留 *** 的位置（对不上原值）：返回提示，调用方拒绝保存。"""
    for env, dbs in _db_maps(body):
        for name, url in dbs.items():
            m = _DSN.match(url or "")
            if m and m["password"] == MASK:
                where = f"环境 {env} 的" if env else ""
                return (f"{where}库 {name} 的口令显示为 *** 却对不上原值，请重新填写口令"
                        "（建议写成 ${VAR}，真实值放 secrets.env）")
    return None
