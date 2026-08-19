"""LogLens analyzer service — chỉ làm việc nặng, không giữ state.

Chạy như một service Python thường (uvicorn), được Next.js Worker gọi qua HTTP.
Stateless nên scale ngang thoải mái; mọi dữ liệu bền vững nằm ở R2/D1 phía
Worker.
"""

from __future__ import annotations

import os
import secrets
import time

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from .analyzer import DEFAULT_Z_THRESHOLD, analyze
from .generator import generate

# Đọc backend/.env nếu có. Khi chạy bằng systemd thì dùng EnvironmentFile= cũng được.
load_dotenv()

MAX_BODY_BYTES = int(os.getenv("MAX_BODY_BYTES", 64 * 1024 * 1024))

# Đặt ANALYZER_TOKEN khi service mở ra internet. /analyze và /generate đều tốn
# CPU nên để trần là mời người ta đốt CPU hộ. Bỏ trống thì không kiểm tra —
# chỉ dùng cho local dev hoặc khi đã chặn ở tầng mạng.
ANALYZER_TOKEN = os.getenv("ANALYZER_TOKEN", "").strip()

app = FastAPI(
    title="LogLens Analyzer",
    description="Tác vụ nặng: parse log, tổng hợp chuỗi thời gian, phát hiện bất thường",
    version="1.0.0",
)

# Chỉ mở CORS khi cần gọi trực tiếp từ browser lúc dev. Trên production, request
# đi qua Next.js Worker nên không cần CORS.
allowed = os.getenv("ALLOWED_ORIGINS", "").strip()
if allowed:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o.strip() for o in allowed.split(",") if o.strip()],
        allow_methods=["*"],
        allow_headers=["*"],
    )


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
    """Không yêu cầu token — để load balancer / uptime check gọi được."""
    return {
        "status": "ok",
        "service": "loglens-analyzer",
        "auth_required": bool(ANALYZER_TOKEN),
    }


async def _read_body(request: Request) -> str:
    """Đọc body theo stream, chặn sớm nếu vượt ngưỡng."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Log quá lớn (> {MAX_BODY_BYTES // (1024 * 1024)} MB)",
            )
        chunks.append(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail="Body rỗng — cần nội dung log thô")
    return b"".join(chunks).decode("utf-8", errors="replace")


@app.post("/analyze", dependencies=[Depends(require_token)])
async def analyze_endpoint(
    request: Request,
    bucket_seconds: int = Query(60, ge=1, le=3600),
    z_threshold: float = Query(DEFAULT_Z_THRESHOLD, ge=1.0, le=20.0),
):
    """Nhận log thô ở request body, trả về kết quả phân tích đầy đủ."""
    received = time.perf_counter()
    text = await _read_body(request)
    result = analyze(text, bucket_seconds=bucket_seconds, z_threshold=z_threshold)
    result["bytes_in"] = len(text.encode())
    result["read_ms"] = round((time.perf_counter() - received) * 1000 - result["compute_ms"], 1)
    result["handled_by"] = "python-service"
    return result


@app.post("/generate", dependencies=[Depends(require_token)])
def generate_endpoint(
    lines: int = Query(120_000, ge=500, le=2_000_000),
    seed: int = Query(7),
    minutes: int = Query(240, ge=5, le=1440),
):
    """Sinh log mẫu có cài sẵn 3 sự cố. Trả về text/plain để Worker đổ vào R2."""
    text, meta = generate(lines=lines, seed=seed, minutes=minutes)
    headers = {
        "X-Generated-Lines": str(meta["lines"]),
        "X-Generated-Ms": str(meta["generate_ms"]),
        "X-Handled-By": "python-service",
    }
    return Response(content=text, media_type="text/plain; charset=utf-8", headers=headers)
