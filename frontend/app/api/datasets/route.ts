/**
 * NHẸ — cả hai đều chỉ là I/O, chạy ở edge.
 *   GET  : một câu SELECT trên D1
 *   POST : đổ body upload vào R2 + một INSERT. Không parse dòng nào.
 */
import { env, fail, json, putToR2, rawKey } from "@/lib/cf";
import type { Dataset } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const e = await env();
  const { results } = await e.DB.prepare(
    "SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC LIMIT 50",
  ).all<Dataset>();

  return json({ datasets: results ?? [] }, started, {
    note: "1 câu SELECT trên D1 — không đọc log thô",
  });
}

export async function POST(request: Request) {
  const started = performance.now();
  const e = await env();

  const limit = Number(e.MAX_UPLOAD_BYTES) || 25 * 1024 * 1024;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) {
    return fail(
      `File ${(declared / 1e6).toFixed(1)} MB vượt giới hạn ${(limit / 1e6).toFixed(0)} MB`,
      413,
    );
  }
  if (!request.body) return fail("Thiếu nội dung file");

  const id = crypto.randomUUID();
  const name = (request.headers.get("x-file-name") ?? "upload.log").slice(0, 120);
  const object = await putToR2(e.LOGS, rawKey(id), request.body, declared || null);

  await e.DB.prepare(
    "INSERT INTO datasets (id, name, size_bytes) VALUES (?, ?, ?)",
  )
    .bind(id, name, object?.size ?? declared)
    .run();

  return json({ id, name }, started, {
    status: 201,
    note: "upload -> R2 + 1 INSERT D1, không parse dòng nào",
  });
}
