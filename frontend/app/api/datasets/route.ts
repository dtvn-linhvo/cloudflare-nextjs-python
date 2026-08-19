/**
 * NHẸ — chạy hoàn toàn trên Next.js Worker.
 *
 *  GET  : một câu SQL trên D1, không đụng tới log thô.
 *  POST : stream body upload thẳng vào R2 rồi ghi 1 row D1. Worker không bao
 *         giờ giữ cả file trong bộ nhớ, cũng không parse gì.
 */
import { env, maxUploadBytes, putToR2, rawKey } from "@/lib/cf";
import { insertDataset, listDatasets } from "@/lib/db";
import { errorJson, jsonHandledByWorker } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const e = await env();
  const datasets = await listDatasets(e.DB);
  return jsonHandledByWorker(
    { datasets },
    started,
    { note: "1 câu SELECT trên D1 — không đọc log thô" },
  );
}

export async function POST(request: Request) {
  const started = performance.now();
  const e = await env();

  const declared = Number(request.headers.get("content-length") ?? 0);
  const limit = maxUploadBytes(e);
  if (declared > limit) {
    return errorJson(
      `File quá lớn: ${(declared / 1e6).toFixed(1)} MB, giới hạn ${(limit / 1e6).toFixed(0)} MB`,
      413,
    );
  }

  const name = (request.headers.get("x-file-name") ?? "upload.log").slice(0, 120);
  if (!request.body) return errorJson("Thiếu nội dung file", 400);

  const id = crypto.randomUUID();
  const { object } = await putToR2(
    e.LOGS,
    rawKey(id),
    request.body,
    declared > 0 ? declared : null,
    {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { name },
    },
  );

  await insertDataset(e.DB, {
    id,
    name,
    size_bytes: object?.size ?? declared,
    source: "upload",
  });

  return jsonHandledByWorker(
    { id, name, size_bytes: object?.size ?? declared },
    started,
    { status: 201, note: "stream upload -> R2 + 1 INSERT D1, không parse dòng nào" },
  );
}
