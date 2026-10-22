"""5 段 cron（分 时 日 月 周）：校验 + 计算下次触发时间。

保存时把写错的表达式挡住；定时循环（orchestration/scheduler.py）与控制台的"下次触发"都用它算。
语义与 Vixie cron 一致：
日与周都受限时二者满足其一即可；周 0 和 7 都是周日；支持 * , - / 与 @daily 等别名。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ALIASES = {"@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
           "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *"}
_BOUNDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))
_NAMES = ("分", "时", "日", "月", "周")


class CronError(ValueError):
    pass


def _field(text: str, lo: int, hi: int, label: str) -> set[int]:
    out: set[int] = set()
    for part in text.split(","):
        rng, _, step_s = part.partition("/")
        step = int(step_s) if step_s else 1
        if step_s and (not step_s.isdigit() or step < 1):
            raise CronError(f"{label}字段步长不合法：{part}")
        if rng == "*":
            a, b = lo, hi
        elif "-" in rng:
            a_s, _, b_s = rng.partition("-")
            if not (a_s.isdigit() and b_s.isdigit()):
                raise CronError(f"{label}字段不合法：{part}")
            a, b = int(a_s), int(b_s)
        elif rng.isdigit():
            a = int(rng)
            b = hi if step_s else a
        else:
            raise CronError(f"{label}字段不合法：{part}")
        if not (lo <= a <= hi and lo <= b <= hi and a <= b):
            raise CronError(f"{label}字段越界：{part}（{lo}~{hi}）")
        out.update(range(a, b + 1, step))
    return out


class Cron:
    def __init__(self, expr: str):
        expr = ALIASES.get(expr.strip(), expr.strip())
        parts = expr.split()
        if len(parts) != 5:
            raise CronError("cron 需要 5 段：分 时 日 月 周")
        fields = [_field(p, lo, hi, n) for p, (lo, hi), n in zip(parts, _BOUNDS, _NAMES)]
        self.minutes, self.hours, self.days, self.months, dows = fields
        self.dows = {d % 7 for d in dows}
        self.dom_any = parts[2] == "*"
        self.dow_any = parts[4] == "*"
        self.expr = expr

    def _day_ok(self, t: datetime) -> bool:
        dom = t.day in self.days
        dow = (t.isoweekday() % 7) in self.dows
        if self.dom_any and self.dow_any:
            return True
        if self.dom_any:
            return dow
        if self.dow_any:
            return dom
        return dom or dow

    def next_after(self, after: datetime) -> datetime | None:
        """after 之后（不含）的第一个触发时刻；after 需带时区。最多向前找 4 年。"""
        t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
        limit = after + timedelta(days=366 * 4)
        while t < limit:
            if t.month not in self.months:
                t = (t.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
                continue
            if not self._day_ok(t):
                t = t.replace(hour=0, minute=0) + timedelta(days=1)
                continue
            if t.hour not in self.hours:
                t = t.replace(minute=0) + timedelta(hours=1)
                continue
            if t.minute not in self.minutes:
                t += timedelta(minutes=1)
                continue
            return t
        return None


def validate(expr: str) -> str:
    Cron(expr)
    return expr


def next_fire(expr: str, timezone: str, after: datetime | None = None) -> datetime | None:
    tz = ZoneInfo(timezone)
    base = (after or datetime.now(tz)).astimezone(tz)
    return Cron(expr).next_after(base)
