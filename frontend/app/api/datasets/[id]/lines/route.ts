/**
 * NHẸ — xem log thô mà KHÔNG tải cả file.
 *
 * R2 range read: mỗi lần chỉ lấy một cửa sổ 64 KB tại byte offset yêu cầu, nên
 * file 17 MB hay 17 GB thì thời gian như nhau. Đây đúng là loại việc để Worker
 * làm, không cần gọi Python.
 *
 * Offset tính trên byte (Uint8Array), không trên độ dài string: log có ký tự
 * non-ASCII thì hai con số lệch nhau và trang sau sẽ nhảy sai chỗ.
 */
import { env, fail, json, rawKey } from "@/lib/cf";

export const dynamic = "force-dynamic";

const NEWLINE = 0x0a;
const WINDOW = 64 * 1024;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  const offset = Math.max(0, Number(new URL(request.url).searchParams.get("offset") ?? 0) || 0);
  const e = await env();

  const object = await e.LOGS.get(rawKey(id), { range: { offset, length: WINDOW } });
  if (!object) return fail("Không đọc được log thô từ R2", 404);

  const bytes = new Uint8Array(await object.arrayBuffer());
  const total = object.size;
  const eof = offset + bytes.length >= total;

  // Cắt hai đầu về ranh giới dòng.
  const start = offset > 0 ? bytes.indexOf(NEWLINE) + 1 : 0;
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  const end = eof ? bytes.length : lastNewline;

  if (end <= start) {
    return fail("Cửa sổ 64 KB không chứa dòng trọn vẹn nào", 422);
  }

  const lines = new TextDecoder()
    .decode(bytes.subarray(start, end))
    .split("\n")
    .filter((l) => l.length > 0);

  return json(
    {
      lines: lines.slice(0, 200),
      read_bytes: bytes.length,
      total_bytes: total,
      next_offset: eof ? null : offset + lastNewline + 1,
    },
    started,
    { note: `R2 range read ${(bytes.length / 1024).toFixed(0)} KB trên file ${(total / 1e6).toFixed(1)} MB` },
  );
}
