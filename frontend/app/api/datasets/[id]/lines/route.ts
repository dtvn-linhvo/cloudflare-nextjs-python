/**
 * NHẸ — xem log thô mà KHÔNG tải cả file.
 *
 * Dùng R2 range read: chỉ lấy một cửa sổ vài chục KB tại byte offset yêu cầu.
 * Với file 22 MB, mỗi lần lật trang vẫn chỉ đọc ~64 KB. Đây chính là loại việc
 * nên để Worker làm — không cần gọi Python.
 *
 * Mọi phép tính offset làm trên byte (Uint8Array), không phải trên độ dài
 * string: log có ký tự non-ASCII thì hai con số đó lệch nhau và trang sau sẽ
 * bị nhảy sai chỗ.
 */
import { env, rawKey } from "@/lib/cf";
import { getDataset } from "@/lib/db";
import { errorJson, jsonHandledByWorker } from "@/lib/http";

export const dynamic = "force-dynamic";

const NEWLINE = 0x0a;
const DEFAULT_WINDOW = 64 * 1024;
const MAX_WINDOW = 512 * 1024;
const MAX_LINES = 300;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const started = performance.now();
  const { id } = await params;
  const url = new URL(request.url);

  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const window = Math.min(
    MAX_WINDOW,
    Math.max(4096, Number(url.searchParams.get("bytes") ?? DEFAULT_WINDOW) || DEFAULT_WINDOW),
  );
  const level = (url.searchParams.get("level") ?? "").toUpperCase();
  const q = (url.searchParams.get("q") ?? "").toLowerCase();

  const e = await env();
  const dataset = await getDataset(e.DB, id);
  if (!dataset) return errorJson("Không tìm thấy dataset", 404);
  if (offset >= dataset.size_bytes && dataset.size_bytes > 0) {
    return errorJson("Offset vượt quá kích thước file", 416);
  }

  const object = await e.LOGS.get(rawKey(id), { range: { offset, length: window } });
  if (!object) return errorJson("Không đọc được log thô từ R2", 404);

  const bytes = new Uint8Array(await object.arrayBuffer());
  const total = dataset.size_bytes;
  const reachedEnd = offset + bytes.length >= total;

  // Cắt hai đầu về ranh giới dòng, tính bằng byte.
  let start = 0;
  if (offset > 0) {
    const first = bytes.indexOf(NEWLINE);
    if (first === -1) {
      // Cửa sổ này không chứa dòng nào trọn vẹn — nhảy tiếp.
      return jsonHandledByWorker(
        {
          lines: [],
          matched: 0,
          scanned_bytes: bytes.length,
          next_offset: reachedEnd ? null : offset + bytes.length,
          eof: reachedEnd,
          total_bytes: total,
        },
        started,
        { note: "cửa sổ không chứa dòng trọn vẹn, cần offset lớn hơn" },
      );
    }
    start = first + 1;
  }

  let end = bytes.length;
  let nextOffset: number | null = null;
  if (!reachedEnd) {
    const last = bytes.lastIndexOf(NEWLINE);
    if (last <= start) {
      return jsonHandledByWorker(
        {
          lines: [],
          matched: 0,
          scanned_bytes: bytes.length,
          next_offset: offset + bytes.length,
          eof: false,
          total_bytes: total,
        },
        started,
        { note: "dòng dài hơn cửa sổ đọc, tăng tham số bytes" },
      );
    }
    end = last;                      // bỏ phần dòng bị cắt ở cuối
    nextOffset = offset + last + 1;  // trang sau bắt đầu ngay sau newline
  }

  const text = new TextDecoder().decode(bytes.subarray(start, end));
  const lines = text.split("\n").filter((l) => l.length > 0);
  const matched = lines.filter(
    (l) => (!level || l.includes(level)) && (!q || l.toLowerCase().includes(q)),
  );

  return jsonHandledByWorker(
    {
      lines: matched.slice(0, MAX_LINES),
      matched: matched.length,
      scanned_bytes: bytes.length,
      next_offset: nextOffset,
      eof: reachedEnd,
      total_bytes: total,
    },
    started,
    {
      note: `R2 range read ${(bytes.length / 1024).toFixed(0)} KB trên file ${(total / 1e6).toFixed(1)} MB`,
    },
  );
}
