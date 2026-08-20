/**
 * Proxy sang Worker backend (Python) — nơi giữ R2 + D1.
 *   GET  : danh sách dataset (1 câu SELECT trên D1 ở backend)
 *   POST : upload log thô. Body chảy dạng stream xuyên qua Worker này, không
 *          buffer, không parse dòng nào.
 */
import { env, fail, proxy } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function GET() {
  return proxy("/datasets", performance.now());
}

export async function POST(request: Request) {
  const started = performance.now();
  const e = await env();

  // Chặn sớm ngay ở edge để file quá lớn không phải đi thêm một chặng mạng.
  const limit = Number(e.MAX_UPLOAD_BYTES) || 25 * 1024 * 1024;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) {
    return fail(
      `File ${(declared / 1e6).toFixed(1)} MB vượt giới hạn ${(limit / 1e6).toFixed(0)} MB`,
      413,
    );
  }
  if (!request.body) return fail("Thiếu nội dung file");

  return proxy("/datasets", started, {
    method: "POST",
    body: request.body,
    duplex: "half",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "x-file-name": request.headers.get("x-file-name") ?? "upload.log",
      // fetch() với body dạng stream KHÔNG gửi content-length, mà R2.put() ở
      // backend cần biết trước độ dài mới nhận được stream -> gửi bằng header
      // riêng. Thiếu header này backend vẫn chạy, nhưng phải buffer.
      ...(declared ? { "x-log-bytes": String(declared) } : {}),
    },
  });
}
