"""LogLens backend — Python Worker nắm cả tầng dữ liệu.

Kiến trúc (theo sơ đồ):

    user -> Worker frontend (Next.js)  -> Worker backend (Python) -> D1
                                                                 -> R2

Frontend chỉ còn là lớp proxy mỏng + UI; mọi truy cập R2/D1 và toàn bộ phần
phân tích nằm ở đây. Chạy trên Pyodide, request vào app FastAPI qua cầu ASGI.

Ba điều khác hẳn so với chạy uvicorn, đều là nguồn gốc của các chỗ lạ mắt
trong file này:

  1. Không có `os.environ`. Var/secret là binding của Worker, lấy qua
     `workers.env`.
  2. Bindings R2/D1 là object JavaScript. Gọi được trực tiếp nhưng phải
     chuyển đổi hai đầu: dict Python -> object JS bằng `_js()`, buffer JS ->
     bytes bằng `.to_bytes()`, mảng kết quả D1 -> list bằng `.to_py()`.
  3. Cầu ASGI nạp cả body vào RAM trước khi gọi app. Worker chỉ có 128MB, nên
     upload được xử lý ngay ở `Default.fetch` (stream thẳng vào R2, không qua
     Python) chứ không đi qua FastAPI.
"""

from __future__ import annotations

import codecs
import json
import re
import secrets
import time
from collections import Counter
from collections.abc import AsyncIterator
from uuid import uuid4

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from js import Object, URL, Uint8Array
from pyodide.ffi import to_js
from workers import WorkerEntrypoint, env

# Mặc định nếu wrangler.jsonc không đặt: 25MB. Đừng nâng quá 30MB — Worker chỉ
# có 128MB bộ nhớ cho cả body lẫn kết quả trung gian.
DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024

# Format log demo: 2026-08-19T08:12:33.123Z  ERROR  api.orders  message...
LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):\d{2}\S*\s+"
    r"(?P<level>[A-Z]{4,5})\s+(?P<source>\S+)\s+(?P<message>.*)$"
)
LEVELS = ("INFO", "WARN", "ERROR")
ERROR = LEVELS.index("ERROR")

# Cửa sổ cho /lines: mỗi lần đọc 64KB từ R2 bất kể file to cỡ nào.
WINDOW = 64 * 1024
NEWLINE = 0x0A

app = FastAPI(title="LogLens backend", version="3.0.0")

# MỌI route và dependency phải là `async def`. FastAPI đẩy callable đồng bộ sang
# threadpool, còn Workers không có thread -> "RuntimeError: can't start new thread".


# ---------------------------------------------------------------- helpers JS

def _js(value: object):
    """dict/list Python -> object JS thuần, để truyền làm options cho R2."""
    return to_js(value, dict_converter=Object.fromEntries)


def _var(name: str) -> str:
    """Đọc một var/secret của Worker (binding, không phải biến môi trường)."""
    value = getattr(env, name, None)
    return "" if value is None else str(value)


def _int_var(name: str, default: int) -> int:
    raw = _var(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _max_body_bytes() -> int:
    return _int_var("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)


def _rows(result) -> list[dict]:
    """Kết quả D1 -> list dict.

    Tuỳ phiên bản runtime mà `.results` đã là list Python hay còn là mảng JS,
    nên phải thử cả hai thay vì gọi thẳng `.to_py()`.
    """
    rows = result.results
    if hasattr(rows, "to_py"):
        rows = rows.to_py()
    return [row if isinstance(row, dict) else row.to_py() for row in rows]


# Key R2: log thô và JSON kết quả của mỗi dataset.
def _raw_key(dataset_id: str) -> str:
    return f"raw/{dataset_id}.log"


def _analysis_key(dataset_id: str) -> str:
    return f"analysis/{dataset_id}.json"


async def require_token(request: Request) -> None:
    """So sánh theo thời gian hằng để không rò rỉ token qua timing.

    Worker này giữ toàn bộ dữ liệu nên MỌI route trừ /health đều phải qua đây.
    Bỏ trống ANALYZER_TOKEN thì không kiểm tra — chỉ nên vậy ở local.
    """
    _check_token(request.headers.get("x-analyzer-token"))


def _check_token(got: str | None) -> None:
    expected = _var("ANALYZER_TOKEN").strip()
    if not expected:
        return
    if got is None or not secrets.compare_digest(got, expected):
        raise HTTPException(status_code=401, detail="Thiếu hoặc sai X-Analyzer-Token")


AUTH = Depends(require_token)


# ------------------------------------------------------------------- routes

@app.get("/health")
async def health():
    """Không yêu cầu token — để uptime check và trang cấu hình gọi được."""
    return {
        "status": "ok",
        "auth_required": bool(_var("ANALYZER_TOKEN").strip()),
        "runtime": "python-worker",
        "bindings": {
            "r2": getattr(env, "LOGS", None) is not None,
            "d1": getattr(env, "DB", None) is not None,
        },
    }


@app.get("/datasets", dependencies=[AUTH])
async def list_datasets():
    """NHẸ — một câu SELECT trên D1, không chạm vào log thô."""
    res = await env.DB.prepare(
        "SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC LIMIT 50"
    ).all()
    return {
        "datasets": _rows(res),
        "_note": "1 câu SELECT trên D1 — không đọc log thô",
    }


@app.delete("/datasets/{dataset_id}", dependencies=[AUTH])
async def delete_dataset(dataset_id: str):
    """NHẸ — xoá 2 object R2 + 1 row D1."""
    await env.LOGS.delete(_raw_key(dataset_id))
    await env.LOGS.delete(_analysis_key(dataset_id))
    await env.DB.prepare("DELETE FROM datasets WHERE id = ?").bind(dataset_id).run()
    return {"deleted": dataset_id, "_note": "xoá 2 object R2 + 1 row D1"}


@app.get("/datasets/{dataset_id}/analysis", dependencies=[AUTH])
async def get_analysis(dataset_id: str):
    """NHẸ — đọc JSON kết quả đã cache trong R2, không phân tích lại."""
    obj = await env.LOGS.get(_analysis_key(dataset_id))
    if obj is None:
        raise HTTPException(status_code=404, detail="Chưa phân tích dataset này")
    cached = await obj.text()
    # Nối chuỗi thay vì json.loads rồi dumps lại: kết quả có thể vài trăm KB.
    body = '{"analysis":' + cached + ',"_note":"đọc JSON đã cache từ R2 — không phân tích lại"}'
    return Response(content=body, media_type="application/json")


@app.get("/datasets/{dataset_id}/lines", dependencies=[AUTH])
async def read_lines(dataset_id: str, offset: int = Query(0, ge=0)):
    """NHẸ — xem log thô mà KHÔNG tải cả file.

    R2 range read: mỗi lần chỉ lấy một cửa sổ 64KB tại byte offset yêu cầu, nên
    file 17MB hay 17GB thì thời gian như nhau.

    Offset tính trên byte, không trên độ dài string: log có ký tự non-ASCII thì
    hai con số lệch nhau và trang sau sẽ nhảy sai chỗ.
    """
    obj = await env.LOGS.get(
        _raw_key(dataset_id), _js({"range": {"offset": offset, "length": WINDOW}})
    )
    if obj is None:
        raise HTTPException(status_code=404, detail="Không đọc được log thô từ R2")

    data = Uint8Array.new(await obj.arrayBuffer()).to_bytes()
    total = int(obj.size)
    eof = offset + len(data) >= total

    # Cắt hai đầu về ranh giới dòng.
    start = data.find(NEWLINE) + 1 if offset > 0 else 0
    last_newline = data.rfind(NEWLINE)
    end = len(data) if eof else last_newline
    if end <= start:
        raise HTTPException(
            status_code=422, detail="Cửa sổ 64 KB không chứa dòng trọn vẹn nào"
        )

    lines = [
        line
        for line in data[start:end].decode("utf-8", errors="replace").split("\n")
        if line
    ]
    return {
        "lines": lines[:200],
        "read_bytes": len(data),
        "total_bytes": total,
        "next_offset": None if eof else offset + last_newline + 1,
        "_note": f"R2 range read {len(data) / 1024:.0f} KB trên file {total / 1e6:.1f} MB",
    }


@app.post("/datasets/{dataset_id}/analyze", dependencies=[AUTH])
async def analyze(dataset_id: str, top: int = Query(8, ge=1, le=50)):
    """NẶNG — quét toàn bộ log thô từ R2, gom bucket, cache kết quả lại R2 + D1."""
    obj = await env.LOGS.get(_raw_key(dataset_id))
    if obj is None:
        await _mark_failed(dataset_id)
        raise HTTPException(status_code=404, detail="Không tìm thấy log thô trong R2")

    try:
        # Đọc theo stream từ R2: không bao giờ giữ cả file trong bộ nhớ.
        result = await _analyze_lines(_lines(_chunks(obj.body)), top)
    except HTTPException:
        await _mark_failed(dataset_id)
        raise

    await env.LOGS.put(
        _analysis_key(dataset_id),
        json.dumps(result, ensure_ascii=False),
        _js({"httpMetadata": {"contentType": "application/json; charset=utf-8"}}),
    )
    await env.DB.prepare(
        "UPDATE datasets SET status = 'analyzed', line_count = ?, error_rate = ?, "
        "compute_ms = ? WHERE id = ?"
    ).bind(
        result["lines_parsed"], result["error_rate"], result["compute_ms"], dataset_id
    ).run()

    parsed = f"{result['lines_parsed']:,}".replace(",", ".")
    return {
        "analysis": result,
        "_note": f"Python quét {parsed} dòng trong {result['compute_ms']} ms",
    }


async def _mark_failed(dataset_id: str) -> None:
    await env.DB.prepare("UPDATE datasets SET status = 'failed' WHERE id = ?").bind(
        dataset_id
    ).run()


# ------------------------------------------------------------------ analyze

async def _analyze_lines(lines: AsyncIterator[str], top: int) -> dict:
    """Phần việc thật: regex từng dòng, gom bucket theo phút bằng numpy."""
    started = time.perf_counter()

    minute_index: dict[str, int] = {}
    minutes: list[int] = []
    levels: list[int] = []
    errors: Counter[str] = Counter()
    skipped = 0
    total = 0

    async for line in lines:
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
        if level == ERROR:
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
    error_per_min = np.bincount(mins[lvls == ERROR], minlength=n)

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
        # workerd đóng băng đồng hồ giữa hai lần I/O (chống Spectre), nên con số
        # này chỉ tính tới lần đọc cuối từ R2 — phần compute thuần có thể ra 0.
        "compute_ms": round((time.perf_counter() - started) * 1000, 1),
        "handled_by": "python-worker",
    }


async def _chunks(stream) -> AsyncIterator[bytes]:
    """ReadableStream của JS -> từng chunk bytes. Chunk cũ được giải phóng ngay."""
    async for chunk in stream:
        yield chunk.to_bytes()


async def _lines(chunks: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Ghép chunk thành dòng, chặn sớm nếu vượt ngưỡng.

    Decode tăng dần vì ranh giới chunk có thể cắt ngang một ký tự UTF-8 nhiều byte.
    """
    limit = _max_body_bytes()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    carry = ""
    size = 0

    async for chunk in chunks:
        if not chunk:
            continue
        size += len(chunk)
        if size > limit:
            raise HTTPException(
                status_code=413,
                detail=f"Log quá lớn (> {limit // (1024 * 1024)} MB)",
            )
        parts = (carry + decoder.decode(chunk)).split("\n")
        carry = parts.pop()  # dòng cuối có thể chưa trọn, để lại cho chunk sau
        for line in parts:
            yield line.rstrip("\r")

    if not size:
        raise HTTPException(status_code=400, detail="Body rỗng — cần nội dung log thô")

    carry += decoder.decode(b"", final=True)
    if carry:
        yield carry.rstrip("\r")


# ------------------------------------------------------------------- upload

async def _upload(js_req, worker_env):
    """NHẸ — đổ body vào R2 + một INSERT. Không parse dòng nào.

    Không đi qua FastAPI: cầu ASGI nạp cả body vào RAM trước khi gọi app, còn ở
    đây stream JavaScript chảy thẳng từ request vào R2, Python không giữ byte nào.
    """
    from js import FixedLengthStream, Response as JsResponse

    def reply(payload: dict, status: int = 200):
        return JsResponse.json(
            _js(payload),
            _js({"status": status, "headers": {"Cache-Control": "no-store"}}),
        )

    try:
        _check_token(js_req.headers.get("x-analyzer-token"))
    except HTTPException as exc:
        return reply({"detail": exc.detail}, exc.status_code)

    # Frontend gửi độ dài qua header riêng: fetch() với body dạng stream không
    # mang theo content-length, mà R2.put() cần biết trước độ dài để nhận stream.
    declared = 0
    for header in ("x-log-bytes", "content-length"):
        raw = js_req.headers.get(header)
        if raw:
            try:
                declared = int(raw)
            except ValueError:
                declared = 0
            if declared:
                break

    limit = _max_body_bytes()
    if declared > limit:
        return reply(
            {"detail": f"Log quá lớn (> {limit // (1024 * 1024)} MB)"}, 413
        )
    if js_req.body is None:
        return reply({"detail": "Thiếu nội dung file"}, 400)

    dataset_id = str(uuid4())
    name = (js_req.headers.get("x-file-name") or "upload.log")[:120]
    opts = _js({"httpMetadata": {"contentType": "text/plain; charset=utf-8"}})

    if declared:
        # FixedLengthStream cho R2 biết độ dài -> dữ liệu chảy thẳng, không buffer.
        fixed = FixedLengthStream.new(declared)
        piped = js_req.body.pipeTo(fixed.writable)
        obj = await worker_env.LOGS.put(_raw_key(dataset_id), fixed.readable, opts)
        await piped
    else:
        # Không biết độ dài (client không gửi header) -> buộc phải buffer.
        buffered = bytearray()
        async for chunk in js_req.body:
            buffered += chunk.to_bytes()
            if len(buffered) > limit:
                return reply(
                    {"detail": f"Log quá lớn (> {limit // (1024 * 1024)} MB)"}, 413
                )
        if not buffered:
            return reply({"detail": "Thiếu nội dung file"}, 400)
        declared = len(buffered)
        obj = await worker_env.LOGS.put(
            _raw_key(dataset_id), _js(Uint8Array.new(buffered)), opts
        )

    size = int(obj.size) if obj is not None else declared
    await worker_env.DB.prepare(
        "INSERT INTO datasets (id, name, size_bytes) VALUES (?, ?, ?)"
    ).bind(dataset_id, name, size).run()

    return reply(
        {
            "id": dataset_id,
            "name": name,
            "_note": "upload -> R2 + 1 INSERT D1, không parse dòng nào",
        },
        201,
    )


class Default(WorkerEntrypoint):
    """Entrypoint của Worker."""

    async def fetch(self, request):
        import asgi

        js_req = request.js_object
        if js_req.method == "POST" and URL.new(js_req.url).pathname == "/datasets":
            return await _upload(js_req, self.env)
        return await asgi.fetch(app, js_req, self.env)
