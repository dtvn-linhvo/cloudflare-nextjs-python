"""Analyzer — phần việc nặng của demo.

Chạy như service Python thường (uvicorn), được Next.js Worker gọi qua HTTP.
Stateless: nhận log thô ở body, trả JSON. Mọi dữ liệu bền vững nằm ở R2/D1
phía Worker.

Vì sao không làm ở Worker: quét hàng trăm nghìn dòng bằng regex rồi gom nhóm
là CPU-bound, dễ đụng giới hạn CPU của Workers; và numpy làm phần đếm theo
bucket nhanh hơn hẳn vòng lặp JS.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from collections import Counter

import numpy as np
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request

load_dotenv()

# Đặt ANALYZER_TOKEN khi service mở ra internet — /analyze tốn CPU, để trần là
# mời người khác đốt CPU hộ. Bỏ trống thì không kiểm tra (chỉ nên vậy ở local).
ANALYZER_TOKEN = os.getenv("ANALYZER_TOKEN", "").strip()
MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", 64 * 1024 * 1024))

# Format log demo: 2026-08-19T08:12:33.123Z  ERROR  api.orders  message...
LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}\S*\s+"
    r"(?P<level>[A-Z]{4,5})\s+(?P<source>\S+)\s+(?P<message>.*)$"
)
LEVELS = ("INFO", "WARN", "ERROR")

app = FastAPI(title="LogLens analyzer", version="1.0.0")


def require_token(x_analyzer_token: str | None = Header(default=None)) -> None:
    """So sánh theo thời gian hằng để không rò rỉ token qua timing."""
    if not ANALYZER_TOKEN:
        return
    if x_analyzer_token is None or not secrets.compare_digest(
        x_analyzer_token, ANALYZER_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Thiếu hoặc sai X-Analyzer-Token")


@app.get("/health")
def health():
    """Không yêu cầu token — để uptime check gọi được."""
    return {"status": "ok", "auth_required": bool(ANALYZER_TOKEN)}


@app.post("/analyze", dependencies=[Depends(require_token)])
async def analyze(request: Request, top: int = Query(8, ge=1, le=50)):
    raw = await _read_body(request)
    started = time.perf_counter()

    minute_index: dict[str, int] = {}
    minutes: list[int] = []
    levels: list[int] = []
    errors: Counter[str] = Counter()
    skipped = 0
    total = 0

    for line in raw.splitlines():
        if not line.strip():
            continue
        total += 1
        m = LINE_RE.match(line)
        if m is None or m.group("level") not in LEVELS:
            skipped += 1
            continue
        # Bucket theo phút = 16 ký tự đầu của timestamp, không cần parse datetime.
        minutes.append(minute_index.setdefault(m.group("ts"), len(minute_index)))
        level = LEVELS.index(m.group("level"))
        levels.append(level)
        if level == LEVELS.index("ERROR"):
            # Chuẩn hoá số thành <N> để cùng một lỗi không đếm thành nghìn dòng khác nhau.
            errors[re.sub(r"\d+", "<N>", m.group("message"))[:160]] += 1

    if not minutes:
        raise HTTPException(
            status_code=422,
            detail=f"Không parse được dòng nào trong {total} dòng. "
            "Format mong đợi: '<ISO timestamp> <LEVEL> <source> <message>'",
        )

    # Phần vectorised: đếm theo bucket bằng numpy thay vì vòng lặp Python.
    mins = np.asarray(minutes, dtype=np.int64)
    lvls = np.asarray(levels, dtype=np.int8)
    n = len(minute_index)
    total_per_min = np.bincount(mins, minlength=n)
    error_per_min = np.bincount(mins[lvls == LEVELS.index("ERROR")], minlength=n)

    parsed = int(mins.size)
    order = sorted(minute_index, key=minute_index.get)  # type: ignore[arg-type]
    buckets = [
        {
            "t": order[i],
            "total": int(total_per_min[i]),
            "error": int(error_per_min[i]),
        }
        for i in range(n)
    ]

    return {
        "lines_total": total,
        "lines_parsed": parsed,
        "lines_skipped": skipped,
        "levels": {lv: int((lvls == i).sum()) for i, lv in enumerate(LEVELS)},
        "error_rate": round(float(error_per_min.sum() / parsed), 4),
        "buckets": buckets,
        "busiest": sorted(buckets, key=lambda b: -b["error"])[:top],
        "top_errors": [{"message": m, "count": c} for m, c in errors.most_common(top)],
        "compute_ms": round((time.perf_counter() - started) * 1000, 1),
        "handled_by": "python-service",
    }


async def _read_body(request: Request) -> str:
    """Đọc body theo stream, chặn sớm nếu vượt ngưỡng."""
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Log quá lớn (> {MAX_BODY_BYTES // (1024 * 1024)} MB)",
            )
        chunks.append(chunk)
    if not size:
        raise HTTPException(status_code=400, detail="Body rỗng — cần nội dung log thô")
    return b"".join(chunks).decode("utf-8", errors="replace")
