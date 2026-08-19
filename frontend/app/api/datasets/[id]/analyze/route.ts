/**
 * NẶNG — Worker chỉ điều phối, Python làm việc thật.
 *
 *   1. mở stream object R2 (không đọc vào bộ nhớ Worker)
 *   2. stream thẳng sang analyzer làm request body
 *   3. Python quét toàn bộ dòng + gom bucket, trả JSON
 *   4. Worker cache JSON vào R2 và ghi summary vào D1
 */
import { analysisKey, callAnalyzer, env, fail, json, rawKey } from "@/lib/cf";
import type { Analysis } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();

  const raw = await e.LOGS.get(rawKey(id));
  if (!raw) return fail("Không tìm thấy log thô trong R2", 404);

  let upstream: Response;
  try {
    upstream = await callAnalyzer("/analyze", {
      method: "POST",
      body: raw.body,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      duplex: "half",
    });
  } catch (err) {
    await e.DB.prepare("UPDATE datasets SET status = 'failed' WHERE id = ?").bind(id).run();
    return fail(
      `Không gọi được analyzer: ${err instanceof Error ? err.message : String(err)} ` +
        `(ANALYZER_URL = ${e.ANALYZER_URL})`,
      502,
    );
  }

  if (!upstream.ok) {
    await e.DB.prepare("UPDATE datasets SET status = 'failed' WHERE id = ?").bind(id).run();
    const detail = await upstream.text().catch(() => "");
    return fail(`Analyzer trả lỗi ${upstream.status}: ${detail.slice(0, 300)}`, 502);
  }

  const analysis = (await upstream.json()) as Analysis;

  // Cache để lần xem sau là request nhẹ, không phải tính lại.
  await e.LOGS.put(analysisKey(id), JSON.stringify(analysis), {
    httpMetadata: { contentType: "application/json" },
  });

  await e.DB.prepare(
    `UPDATE datasets SET status = 'analyzed', line_count = ?, error_rate = ?, compute_ms = ?
      WHERE id = ?`,
  )
    .bind(analysis.lines_parsed, analysis.error_rate, analysis.compute_ms, id)
    .run();

  return json({ analysis }, started, {
    by: "python-service",
    note: `Python quét ${analysis.lines_parsed.toLocaleString("vi-VN")} dòng trong ${analysis.compute_ms} ms`,
  });
}
