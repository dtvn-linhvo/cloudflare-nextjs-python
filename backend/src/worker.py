"""LogLens backend — Python Worker nắm cả tầng dữ liệu.

Kiến trúc (theo sơ đồ):

    user -> Worker frontend (Next.js)  -> Worker backend (Python) -> D1
                                                                 -> R2

Frontend chỉ còn là lớp proxy mỏng + UI; mọi truy cập R2/D1 và toàn bộ phần
phân tích nằm ở đây.

VÌ SAO KHÔNG DÙNG FASTAPI VÀ NUMPY

Bản đầu dùng cả hai, deploy fail: bundle 5.03MB nén, vượt giới hạn 3MiB của gói
Workers Free (pydantic_core 4MB + numpy .so 5MB). Bỏ cả hai thì:

  - bundle còn phần code của chính app, deploy được ở gói Free
  - cold start nhanh hơn hẳn vì không phải nạp hai thư viện WASM lớn
  - mỗi request tiết kiệm được phần CPU của cầu ASGI + validate pydantic, điều
    này quyết định khi gói Free chỉ cho 10ms CPU/request

Thay thế: routing bằng tay ở `Default.fetch` (6 endpoint, không cần framework),
và đếm theo phút bằng dict thay np.bincount — cũng nhẹ bộ nhớ hơn nhiều vì
không dựng hai list dài bằng số dòng log.

Ba điều khác hẳn so với chạy uvicorn:

  1. Không có `os.environ`. Var/secret là binding của Worker, lấy qua
     `workers.env`.
  2. Bindings R2/D1 là object JavaScript. Gọi được trực tiếp nhưng phải chuyển
     đổi hai đầu: dict Python -> object JS bằng `_js()`, buffer JS -> bytes
     bằng `.to_bytes()`.
  3. Worker chỉ có 128MB bộ nhớ, nên upload stream thẳng vào R2 và phần phân
     tích đọc R2 theo chunk — không bao giờ giữ cả file.
"""

from __future__ import annotations

import codecs
import json
import re
import secrets
import time
from collections.abc import AsyncIterator
from uuid import uuid4

from js import Object, URL, Uint8Array
from pyodide.ffi import to_js
from workers import Response, WorkerEntrypoint, env

# Mặc định nếu wrangler.jsonc không đặt: 25MB.
DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024

# 0 = không giới hạn. Đặt MAX_ANALYZE_LINES khi ở gói Free: 10ms CPU/request chỉ
# đủ cho khoảng 2-3 nghìn dòng (đo được: 1k dòng ~6ms, 5k ~16ms, 50k ~130ms).
# Vượt ngưỡng thì cắt và nói rõ là kết quả một phần, thay vì để Workers giết
# request bằng lỗi 1102 không giải thích gì.
DEFAULT_MAX_ANALYZE_LINES = 0

# Format log demo: 2026-08-19T08:12:33.123Z  ERROR  api.orders  message...
# Tách bằng split() thay vì regex: nhanh hơn nhiều trên hàng trăm nghìn dòng, và
# 10ms CPU của gói Free thì từng phần trăm milli-giây đều đáng.
LEVELS = ("INFO", "WARN", "ERROR")
LEVEL_SET = frozenset(LEVELS)
DIGITS = re.compile(r"\d+")

# Cửa sổ cho /lines: mỗi lần đọc 64KB từ R2 bất kể file to cỡ nào.
WINDOW = 64 * 1024
NEWLINE = 0x0A

JSON_HEADERS = {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}


# ---------------------------------------------------------------- helpers JS

def _js(value: object):
    """dict/list Python -> object JS thuần, để truyền làm options cho R2."""
    return to_js(value, dict_converter=Object.fromEntries)


def _var(name: str) -> str:
    """Đọc một var/secret của Worker (binding, không phải biến môi trường)."""
    value = getattr(env, name, None)
    return "" if value is None else str(value)


def _max_body_bytes() -> int:
    return _int_var("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES)


def _max_analyze_lines() -> int:
    return _int_var("MAX_ANALYZE_LINES", DEFAULT_MAX_ANALYZE_LINES)


def _int_var(name: str, default: int) -> int:
    raw = _var(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


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


def _json(payload: dict, status: int = 200) -> Response:
    return Response(json.dumps(payload, ensure_ascii=False), status=status, headers=JSON_HEADERS)


def _error(detail: str, status: int) -> Response:
    """Cùng dạng lỗi như trước (khoá `detail`) để frontend không phải sửa."""
    return _json({"detail": detail}, status)


class HttpError(Exception):
    """Lỗi có mã HTTP, để hàm ở sâu bên trong dừng được request."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _check_token(got: str | None) -> None:
    """So sánh theo thời gian hằng để không rò rỉ token qua timing.

    Worker này giữ toàn bộ dữ liệu nên MỌI route trừ /health đều phải qua đây.
    Bỏ trống ANALYZER_TOKEN thì không kiểm tra — chỉ nên vậy ở local.
    """
    expected = _var("ANALYZER_TOKEN").strip()
    if not expected:
        return
    if got is None or not secrets.compare_digest(got, expected):
        raise HttpError(401, "Thiếu hoặc sai X-Analyzer-Token")


# ------------------------------------------------------------------- routes

async def _health() -> Response:
    """Không yêu cầu token — để uptime check và trang cấu hình gọi được."""
    return _json(
        {
            "status": "ok",
            "auth_required": bool(_var("ANALYZER_TOKEN").strip()),
            "runtime": "python-worker",
            "bindings": {
                "r2": getattr(env, "LOGS", None) is not None,
                "d1": getattr(env, "DB", None) is not None,
            },
        }
    )


async def _list_datasets() -> Response:
    """NHẸ — một câu SELECT trên D1, không chạm vào log thô."""
    res = await env.DB.prepare(
        "SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC LIMIT 50"
    ).all()
    return _json(
        {"datasets": _rows(res), "_note": "1 câu SELECT trên D1 — không đọc log thô"}
    )


async def _delete_dataset(dataset_id: str) -> Response:
    """NHẸ — xoá 2 object R2 + 1 row D1."""
    await env.LOGS.delete(_raw_key(dataset_id))
    await env.LOGS.delete(_analysis_key(dataset_id))
    await env.DB.prepare("DELETE FROM datasets WHERE id = ?").bind(dataset_id).run()
    return _json({"deleted": dataset_id, "_note": "xoá 2 object R2 + 1 row D1"})


async def _get_analysis(dataset_id: str) -> Response:
    """NHẸ — đọc JSON kết quả đã cache trong R2, không phân tích lại."""
    obj = await env.LOGS.get(_analysis_key(dataset_id))
    if obj is None:
        raise HttpError(404, "Chưa phân tích dataset này")
    cached = await obj.text()
    # Nối chuỗi thay vì parse rồi serialize lại: kết quả có thể vài trăm KB.
    body = (
        '{"analysis":'
        + cached
        + ',"_note":"đọc JSON đã cache từ R2 — không phân tích lại"}'
    )
    return Response(body, headers=JSON_HEADERS)


async def _read_lines(dataset_id: str, offset: int) -> Response:
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
        raise HttpError(404, "Không đọc được log thô từ R2")

    data = Uint8Array.new(await obj.arrayBuffer()).to_bytes()
    total = int(obj.size)
    eof = offset + len(data) >= total

    # Cắt hai đầu về ranh giới dòng.
    start = data.find(NEWLINE) + 1 if offset > 0 else 0
    last_newline = data.rfind(NEWLINE)
    end = len(data) if eof else last_newline
    if end <= start:
        raise HttpError(422, "Cửa sổ 64 KB không chứa dòng trọn vẹn nào")

    lines = [
        line
        for line in data[start:end].decode("utf-8", errors="replace").split("\n")
        if line
    ]
    return _json(
        {
            "lines": lines[:200],
            "read_bytes": len(data),
            "total_bytes": total,
            "next_offset": None if eof else offset + last_newline + 1,
            "_note": f"R2 range read {len(data) / 1024:.0f} KB trên file {total / 1e6:.1f} MB",
        }
    )


async def _analyze(dataset_id: str, top: int) -> Response:
    """NẶNG — quét toàn bộ log thô từ R2, gom bucket, cache kết quả lại R2 + D1."""
    obj = await env.LOGS.get(_raw_key(dataset_id))
    if obj is None:
        await _mark_failed(dataset_id)
        raise HttpError(404, "Không tìm thấy log thô trong R2")

    try:
        # Đọc theo stream từ R2: không bao giờ giữ cả file trong bộ nhớ.
        result = await _summarize(_lines(_chunks(obj.body)), top)
    except HttpError:
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
    note = f"Python quét {parsed} dòng trong {result['compute_ms']} ms"
    if result["truncated"]:
        note += " — cắt ở MAX_ANALYZE_LINES, kết quả là một phần đầu file"
    return _json({"analysis": result, "_note": note})


async def _mark_failed(dataset_id: str) -> None:
    await env.DB.prepare("UPDATE datasets SET status = 'failed' WHERE id = ?").bind(
        dataset_id
    ).run()


# ------------------------------------------------------------------ analyze

async def _summarize(lines: AsyncIterator[str], top: int) -> dict:
    """Phần việc thật: tách từng dòng, gom bucket theo phút.

    Vòng lặp này là toàn bộ chi phí CPU của app, nên viết theo kiểu tiết kiệm:
    split có giới hạn thay vì regex, dict.get thay Counter, và chỉ giữ một dict
    240 phần tử thay vì hai list dài bằng số dòng.
    """
    started = time.perf_counter()
    max_lines = _max_analyze_lines()

    buckets: dict[str, list[int]] = {}  # phút -> [tổng, số lỗi]
    level_counts = dict.fromkeys(LEVELS, 0)
    errors: dict[str, int] = {}
    skipped = 0
    total = 0
    truncated = False

    async for line in lines:
        if not line or line.isspace():
            continue
        if max_lines and total >= max_lines:
            truncated = True
            break
        total += 1

        parts = line.split(None, 3)
        if len(parts) == 3:
            parts.append("")  # message rỗng vẫn là dòng hợp lệ
        elif len(parts) != 4:
            skipped += 1
            continue

        ts, level, _source, message = parts
        # Kiểm tra rẻ nhất có thể: đúng level và timestamp có chữ T ở vị trí ISO.
        if level not in LEVEL_SET or len(ts) < 16 or ts[10] != "T":
            skipped += 1
            continue

        level_counts[level] += 1
        # Bucket theo phút = 16 ký tự đầu của timestamp, không cần parse datetime.
        bucket = buckets.get(ts[:16])
        if bucket is None:
            bucket = buckets[ts[:16]] = [0, 0]
        bucket[0] += 1

        if level == "ERROR":
            bucket[1] += 1
            # Chuẩn hoá số thành <N> để cùng một lỗi không đếm thành nghìn dòng khác nhau.
            key = DIGITS.sub("<N>", message)[:160]
            errors[key] = errors.get(key, 0) + 1

    if not buckets:
        raise HttpError(
            422,
            f"Không parse được dòng nào trong {total} dòng. "
            "Format mong đợi: '<ISO timestamp> <LEVEL> <source> <message>'",
        )

    # Khoá là timestamp cắt tới phút nên sắp theo chuỗi cũng là sắp theo thời gian.
    series = [
        {"t": minute, "total": counts[0], "error": counts[1]}
        for minute, counts in sorted(buckets.items())
    ]
    parsed = sum(level_counts.values())
    error_total = level_counts["ERROR"]

    return {
        "lines_total": total,
        "lines_parsed": parsed,
        "lines_skipped": skipped,
        "levels": level_counts,
        "error_rate": round(error_total / parsed, 4),
        "buckets": series,
        "busiest": sorted(series, key=lambda b: -b["error"])[:top],
        "top_errors": [
            {"message": message, "count": count}
            for message, count in sorted(errors.items(), key=lambda kv: -kv[1])[:top]
        ],
        # workerd đóng băng đồng hồ giữa hai lần I/O (chống Spectre), nên con số
        # này chỉ tính tới lần đọc cuối từ R2 — phần compute thuần có thể ra 0.
        "compute_ms": round((time.perf_counter() - started) * 1000, 1),
        "handled_by": "python-worker",
        "truncated": truncated,
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
            raise HttpError(413, f"Log quá lớn (> {limit // (1024 * 1024)} MB)")
        parts = (carry + decoder.decode(chunk)).split("\n")
        carry = parts.pop()  # dòng cuối có thể chưa trọn, để lại cho chunk sau
        for line in parts:
            yield line

    if not size:
        raise HttpError(400, "Body rỗng — cần nội dung log thô")

    carry += decoder.decode(b"", final=True)
    if carry:
        yield carry


# ------------------------------------------------------------------- upload

async def _upload(js_req, worker_env) -> Response:
    """NHẸ — đổ body vào R2 + một INSERT. Không parse dòng nào.

    Stream JavaScript chảy thẳng từ request vào R2, Python không giữ byte nào.
    """
    from js import FixedLengthStream

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
        raise HttpError(413, f"Log quá lớn (> {limit // (1024 * 1024)} MB)")
    if js_req.body is None:
        raise HttpError(400, "Thiếu nội dung file")

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
                raise HttpError(413, f"Log quá lớn (> {limit // (1024 * 1024)} MB)")
        if not buffered:
            raise HttpError(400, "Thiếu nội dung file")
        declared = len(buffered)
        obj = await worker_env.LOGS.put(
            _raw_key(dataset_id), _js(Uint8Array.new(buffered)), opts
        )

    size = int(obj.size) if obj is not None else declared
    await worker_env.DB.prepare(
        "INSERT INTO datasets (id, name, size_bytes) VALUES (?, ?, ?)"
    ).bind(dataset_id, name, size).run()

    return _json(
        {
            "id": dataset_id,
            "name": name,
            "_note": "upload -> R2 + 1 INSERT D1, không parse dòng nào",
        },
        201,
    )


# ------------------------------------------------------------------- router

async def _route(js_req) -> Response:
    """Routing bằng tay — 6 endpoint thì không cần framework.

    Đường dẫn: /health | /datasets | /datasets/{id}[/analyze|/analysis|/lines]
    """
    url = URL.new(js_req.url)
    method = js_req.method
    parts = [segment for segment in url.pathname.split("/") if segment]

    if parts == ["health"]:
        return await _health()

    _check_token(js_req.headers.get("x-analyzer-token"))

    if parts == ["datasets"]:
        if method == "GET":
            return await _list_datasets()
        if method == "POST":
            return await _upload(js_req, env)
        raise HttpError(405, f"{method} không dùng được ở /datasets")

    if len(parts) >= 2 and parts[0] == "datasets":
        dataset_id = parts[1]
        tail = parts[2] if len(parts) > 2 else ""

        if not tail and method == "DELETE":
            return await _delete_dataset(dataset_id)
        if tail == "analyze" and method == "POST":
            top = _clamp(url.searchParams.get("top"), default=8, low=1, high=50)
            return await _analyze(dataset_id, top)
        if tail == "analysis" and method == "GET":
            return await _get_analysis(dataset_id)
        if tail == "lines" and method == "GET":
            offset = _clamp(url.searchParams.get("offset"), default=0, low=0, high=None)
            return await _read_lines(dataset_id, offset)

    raise HttpError(404, f"Không có route {method} {url.pathname}")


def _clamp(raw, default: int, low: int, high: int | None) -> int:
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise HttpError(400, f"Tham số không phải số: {raw}") from None
    if value < low:
        value = low
    if high is not None and value > high:
        value = high
    return value


class Default(WorkerEntrypoint):
    """Entrypoint của Worker."""

    async def fetch(self, request):
        try:
            return await _route(request.js_object)
        except HttpError as exc:
            return _error(exc.detail, exc.status)
