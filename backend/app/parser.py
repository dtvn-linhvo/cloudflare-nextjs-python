"""Parse log thô thành mảng có cấu trúc.

Đây là phần "nặng" đầu tiên: quét từng dòng bằng regex đã compile, tự nhận
dạng format. Chạy trên hàng trăm nghìn dòng nên mọi thứ trong vòng lặp đều
được giữ ở mức tối thiểu.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterator, NamedTuple

# 2026-08-19T08:12:33.123Z  ERROR  api.orders  message... latency_ms=1420
APP_LOG_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)"
    r"(?P<tz>Z|[+-]\d{2}:?\d{2})?\s+"
    r"(?P<level>[A-Z]{4,8})\s+"
    r"(?P<logger>[\w.\-]+)\s+"
    r"(?P<message>.*)$"
)

# 10.1.2.3 - - [19/Aug/2026:08:12:33 +0000] "GET /api/orders HTTP/1.1" 500 812 "-" "curl/8.4" 1.420
ACCESS_LOG_RE = re.compile(
    r"^(?P<ip>[\d.:a-fA-F]+)\s+\S+\s+\S+\s+"
    r"\[(?P<ts>[^\]]+)\]\s+"
    r'"(?P<method>[A-Z]+)\s+(?P<path>[^\s"]*)(?:\s+HTTP/[\d.]+)?"\s+'
    r"(?P<status>\d{3})\s+(?P<bytes>\d+|-)"
    r"(?:\s+\"[^\"]*\"\s+\"[^\"]*\")?"
    r"(?:\s+(?P<duration>[\d.]+))?"
)

LATENCY_RE = re.compile(r"\b(?:latency_ms|duration_ms|took_ms|elapsed_ms)=(\d+(?:\.\d+)?)")
STATUS_RE = re.compile(r"\bstatus(?:_code)?=(\d{3})\b")

ACCESS_TS_FMT = "%d/%b/%Y:%H:%M:%S %z"

# Chuẩn hoá mọi biến thể tên level về 4 nhóm dùng cho thống kê.
LEVEL_ALIASES = {
    "TRACE": "DEBUG",
    "DEBUG": "DEBUG",
    "INFO": "INFO",
    "NOTICE": "INFO",
    "WARN": "WARN",
    "WARNING": "WARN",
    "ERROR": "ERROR",
    "ERR": "ERROR",
    "CRIT": "ERROR",
    "CRITICAL": "ERROR",
    "FATAL": "ERROR",
    "ALERT": "ERROR",
    "EMERG": "ERROR",
}
LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")


class Record(NamedTuple):
    ts: float            # epoch seconds (UTC)
    level: str           # DEBUG | INFO | WARN | ERROR
    source: str          # logger name hoặc "METHOD /path"
    message: str
    status: int          # 0 nếu không có
    latency_ms: float    # -1.0 nếu không có


def _parse_iso(ts: str, tz: str | None) -> float | None:
    raw = ts.replace(" ", "T")
    if tz in (None, "", "Z"):
        raw += "+00:00"
    elif len(tz) == 5:                     # +0700 -> +07:00
        raw += f"{tz[:3]}:{tz[3:]}"
    else:
        raw += tz
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return None


def _parse_access_ts(ts: str) -> float | None:
    try:
        return datetime.strptime(ts, ACCESS_TS_FMT).timestamp()
    except ValueError:
        try:
            return datetime.strptime(ts, "%d/%b/%Y:%H:%M:%S").replace(
                tzinfo=timezone.utc
            ).timestamp()
        except ValueError:
            return None


def _level_from_status(status: int) -> str:
    if status >= 500:
        return "ERROR"
    if status >= 400:
        return "WARN"
    return "INFO"


def detect_format(lines: list[str]) -> str:
    """Đoán format từ tối đa 200 dòng đầu không rỗng."""
    app = access = 0
    for line in lines[:200]:
        if not line.strip():
            continue
        if ACCESS_LOG_RE.match(line):
            access += 1
        elif APP_LOG_RE.match(line):
            app += 1
    if access == 0 and app == 0:
        return "unknown"
    return "access" if access >= app else "app"


def parse_lines(lines: list[str]) -> tuple[list[Record], int, str, list[str]]:
    """Trả về (records, số dòng không parse được, format, ví dụ dòng lỗi)."""
    fmt = detect_format(lines)
    records: list[Record] = []
    unparsed = 0
    samples: list[str] = []

    for line in lines:
        if not line.strip():
            continue
        rec = _parse_one(line, fmt)
        if rec is None:
            unparsed += 1
            if len(samples) < 5:
                samples.append(line[:200])
        else:
            records.append(rec)

    records.sort(key=lambda r: r.ts)
    return records, unparsed, fmt, samples


def _parse_one(line: str, fmt: str) -> Record | None:
    # Thử format đã đoán trước, nếu trượt thì thử format còn lại — log thật
    # thường bị trộn (vd. access log lẫn dòng stacktrace của app).
    order = (fmt, "app" if fmt == "access" else "access")
    for candidate in order:
        rec = _ACCESS if candidate == "access" else _APP
        out = rec(line)
        if out is not None:
            return out
    return None


def _APP(line: str) -> Record | None:
    m = APP_LOG_RE.match(line)
    if m is None:
        return None
    ts = _parse_iso(m.group("ts"), m.group("tz"))
    if ts is None:
        return None
    message = m.group("message")
    level = LEVEL_ALIASES.get(m.group("level").upper())
    if level is None:
        return None

    lat = LATENCY_RE.search(message)
    st = STATUS_RE.search(message)
    return Record(
        ts=ts,
        level=level,
        source=m.group("logger"),
        message=message,
        status=int(st.group(1)) if st else 0,
        latency_ms=float(lat.group(1)) if lat else -1.0,
    )


def _ACCESS(line: str) -> Record | None:
    m = ACCESS_LOG_RE.match(line)
    if m is None:
        return None
    ts = _parse_access_ts(m.group("ts"))
    if ts is None:
        return None
    status = int(m.group("status"))
    duration = m.group("duration")
    return Record(
        ts=ts,
        level=_level_from_status(status),
        source=f"{m.group('method')} {m.group('path').split('?')[0]}",
        message=f"{m.group('method')} {m.group('path')} -> {status}",
        status=status,
        latency_ms=float(duration) * 1000.0 if duration else -1.0,
    )


def iter_lines(text: str) -> Iterator[str]:
    return iter(text.splitlines())
