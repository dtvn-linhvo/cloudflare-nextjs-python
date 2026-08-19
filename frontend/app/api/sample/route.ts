/**
 * NẶNG — nhờ Python sinh log mẫu có cài sẵn sự cố.
 *
 * Sinh vài trăm nghìn dòng là việc CPU-bound; Worker chỉ stream kết quả vào R2.
 */
import { callAnalyzer, env, putToR2, rawKey } from "@/lib/cf";
import { insertDataset } from "@/lib/db";
import { errorJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = performance.now();
  const url = new URL(request.url);
  const lines = Math.min(1_000_000, Math.max(500, Number(url.searchParams.get("lines") ?? 120_000) || 120_000));
  const seed = Number(url.searchParams.get("seed") ?? Math.floor(Math.random() * 10_000)) || 7;

  const e = await env();

  let upstream: Response;
  try {
    upstream = await callAnalyzer(`/generate?lines=${lines}&seed=${seed}`, { method: "POST" });
  } catch (err) {
    return errorJson(
      `Không gọi được analyzer Python: ${err instanceof Error ? err.message : String(err)}. ` +
        `Backend đã chạy chưa? (ANALYZER_URL = ${e.ANALYZER_URL})`,
      502,
    );
  }
  if (!upstream.ok || !upstream.body) {
    return errorJson(`Analyzer trả lỗi ${upstream.status}`, 502);
  }

  const generatedLines = Number(upstream.headers.get("x-generated-lines") ?? lines);
  const generateMs = Number(upstream.headers.get("x-generated-ms") ?? 0);

  const id = crypto.randomUUID();
  const declared = Number(upstream.headers.get("content-length"));
  const { object, streamed } = await putToR2(
    e.LOGS,
    rawKey(id),
    upstream.body,
    Number.isFinite(declared) && declared > 0 ? declared : null,
    { httpMetadata: { contentType: "text/plain; charset=utf-8" } },
  );

  const name = `sample-${generatedLines.toLocaleString("en-US").replace(/,/g, "")}-lines.log`;
  await insertDataset(e.DB, {
    id,
    name,
    size_bytes: object?.size ?? 0,
    source: "generated",
    line_count: generatedLines,
  });

  const roundTrip = Math.round((performance.now() - started) * 10) / 10;
  return Response.json(
    {
      id,
      name,
      size_bytes: object?.size ?? 0,
      line_count: generatedLines,
      _handler: {
        handled_by: "python-service",
        duration_ms: roundTrip,
        note:
          `Python sinh ${generatedLines.toLocaleString("vi-VN")} dòng trong ${generateMs} ms; ` +
          `Worker ${streamed ? "stream thẳng" : "đệm rồi ghi"} vào R2`,
      },
    },
    {
      status: 201,
      headers: { "X-Handled-By": "python-service", "Cache-Control": "no-store" },
    },
  );
}
