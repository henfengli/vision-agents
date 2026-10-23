"""配置文件编辑（控制台）：读写服务在某个环境声明过的配置文件——configs.template 那一端，也就是代码目录外、
每环境一份的真实文件；进程、项目内核、同步步骤启动时它被 bind 到固定路径。路径来自定义，不来自请求。

- 读：原文（编辑用）+ 内容摘要 sha；保存时带回 sha，期间文件被别人改过就拒绝（409），不互相覆盖
- 写：原地写（不换 inode：已经 bind 进内核 / 进程的也看得到新内容）；写之前旧内容备份到数据目录
  config-history/，每个文件保留最近 30 份，可回看、恢复
- 备份目录和配置文件一样，在 agent 的沙箱里被遮蔽
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone

from ..domain import Rejected, ServiceView

KEEP = 30
MAX_BYTES = 1024 * 1024
_ID_RE = re.compile(r"^\d{8}-\d{6}-\d{6}~[^/\\]{1,60}$")


def entry(view: ServiceView, path: str) -> dict:
    c = next((c for c in view.config_files if path in (c["path"], c["canonical"])), None)
    if c is None:
        raise Rejected("not_found", f"{path} 不是服务 {view.service} 在 {view.env} 声明的配置文件", 404)
    return c


def digest(raw: bytes) -> str:
    return hashlib.sha1(raw).hexdigest()[:16]


def _raw(path: str) -> bytes | None:
    try:
        with open(path, "rb") as f:
            raw = f.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Rejected("not_found", f"配置文件不可读：{path}（{e.strerror}）", 404) from e
    if len(raw) > MAX_BYTES:
        raise Rejected("invalid_request", f"{path} 超过 1MB，不在控制台编辑", 422)
    return raw


def read(view: ServiceView, path: str) -> dict:
    c = entry(view, path)
    raw = _raw(c["path"])
    return {"path": c["path"], "canonical": c["canonical"], "upstream": c.get("upstream") or None,
            "exists": raw is not None, "content": (raw or b"").decode("utf-8", errors="replace"),
            "sha": digest(raw) if raw is not None else ""}


def _history_dir(root: str, view: ServiceView, c: dict) -> str:
    tag = hashlib.sha1(c["canonical"].encode()).hexdigest()[:10]
    return os.path.join(root, view.service, view.env, f"{tag}-{os.path.basename(c['path']) or 'config'}")


def write(view: ServiceView, path: str, content: str, base_sha: str | None, by: str, history_root: str) -> dict:
    """base_sha：打开编辑时读到的 sha（新建文件传空串）；不一致说明期间被改过。"""
    c = entry(view, path)
    current = _raw(c["path"])
    if base_sha is not None and (digest(current) if current is not None else "") != base_sha:
        raise Rejected("conflict", f"{c['path']} 在你打开之后被改过，刷新后再改", 409)
    backup = None
    if current is not None:
        hdir = _history_dir(history_root, view, c)
        os.makedirs(hdir, mode=0o700, exist_ok=True)
        who = re.sub(r"[^\w.-]", "_", by)[:40] or "unknown"
        backup = f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S-%f}~{who}"
        with open(os.path.join(hdir, backup), "wb") as f:
            f.write(current)
        os.chmod(os.path.join(hdir, backup), 0o600)
        for old in sorted(os.listdir(hdir))[:-KEEP]:
            os.remove(os.path.join(hdir, old))
    os.makedirs(os.path.dirname(c["path"]) or "/", exist_ok=True)
    data = content.encode("utf-8")
    with open(c["path"], "r+b" if current is not None else "wb") as f:   # 原地写：bind 进去的同一个文件
        f.seek(0)
        f.write(data)
        f.truncate()
    if current is None:
        os.chmod(c["path"], 0o640)
    return {"path": c["path"], "sha": digest(data), "backup": backup}


def history(view: ServiceView, path: str, history_root: str) -> list[dict]:
    """[{id, at, replaced_by, size}]，新的在前：每份是 replaced_by 在 at 保存之前的内容。"""
    hdir = _history_dir(history_root, view, entry(view, path))
    if not os.path.isdir(hdir):
        return []
    out = []
    for name in sorted(os.listdir(hdir), reverse=True):
        if not _ID_RE.match(name):
            continue
        stamp, _, who = name.partition("~")
        at = datetime.strptime(stamp, "%Y%m%d-%H%M%S-%f").replace(tzinfo=timezone.utc)
        out.append({"id": name, "at": at.isoformat(), "replaced_by": who,
                    "size": os.path.getsize(os.path.join(hdir, name))})
    return out


def history_content(view: ServiceView, path: str, version_id: str, history_root: str) -> str:
    if not _ID_RE.match(version_id):
        raise Rejected.not_found(f"备份 {version_id}")
    file = os.path.join(_history_dir(history_root, view, entry(view, path)), version_id)
    try:
        with open(file, "rb") as f:
            return f.read().decode("utf-8", errors="replace")
    except FileNotFoundError:
        raise Rejected.not_found(f"备份 {version_id}") from None
