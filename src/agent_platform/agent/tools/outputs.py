"""工具输出太长时：全文存进会话工作目录的 outputs/，给模型的是预览 + 路径（用 read / grep 看要的部分）。

参照 Kilo Code 的 truncate：截掉的部分不是丢掉，而是放在模型够得着的地方。
文件跟着工作目录按 retention.scratch_days 清理。
"""

from __future__ import annotations

import os
import time
import uuid

HEAD_SHARE = 1 / 3          # 预览里开头占多少（其余给结尾：报错、汇总通常在最后）


def new_path(work: str, tool: str) -> str:
    return os.path.join(work, "outputs", f"{tool}-{time.strftime('%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.txt")


def write(path: str, text: str) -> str | None:
    """写不进去（磁盘满、目录没权限）返回 None，调用方照常截断。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        return None
    return path


def spill(work: str, tool: str, text: str) -> str | None:
    """全文写进 <work>/outputs/<工具>-<时间>-<随机>.txt。"""
    return write(new_path(work, tool), text)


def note(path: str | None, total: int, unit: str = "字") -> str:
    if not path:
        return f"[输出共 {total} {unit}，中间截掉了；要看全部，把输出重定向到文件再用 read / grep]"
    return f"[输出共 {total} {unit}，全文在 {path}：用 read(path, offset=行号) 翻看，或 grep 搜，不要整份读]"


def clip(text: str, limit: int, path: str | None) -> str:
    """开头 1/3 + 结尾 2/3，中间换成说明（含全文路径）。"""
    if len(text) <= limit:
        return text
    head = int(limit * HEAD_SHARE)
    return f"{text[:head]}\n\n…{note(path, len(text))}…\n\n{text[-(limit - head):]}"
