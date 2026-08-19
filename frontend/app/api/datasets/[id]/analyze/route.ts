/**
 * NẶNG — Worker chỉ làm nhiệm vụ điều phối, Python làm việc thật.
 *
 * Luồng:
 *   1. Worker mở stream object R2 (không đọc vào bộ nhớ)
 *   2. Stream thẳng sang analyzer Python làm request body
 *   3. Python parse toàn bộ + tính chuỗi thời gian + z-score, trả JSON
 *   4. Worker cache JSON vào R2 và cập nhật summary vào D1
 *
 * Vì sao không làm ở Worker: parse hàng trăm nghìn dòng + percentile trên
 * chuỗi thời gian sẽ đụng giới hạn CPU của Workers, và JS không có numpy.
 * Analyzer là service Python thường, gọi qua ANALYZER_URL.
 */
import { analysisKey, callAnalyzer, env, rawKey } from "@/lib/cf";
import { getDataset, markAnalyzed, setStatus } from "@/lib/db";
import { errorJson } from "@/lib/http";
import type { Analysis } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const started = performance.now();
  const { id } = await params;
  const url = new URL(request.url);
  const bucket = Number(url.searchParams.get("bucket_seconds") ?? 60) || 60;
  const z = Number(url.searchParams.get("z_threshold") ?? 3.5) || 3.5;

  const e = await env();
  const dataset = await getDataset(e.DB, id);
  if (!dataset) return errorJson("Không tìm thấy dataset", 404);

  const raw = await e.LOGS.get(rawKey(id));
  if (!raw) return errorJson("Không tìm thấy log thô trong R2", 404);

  await setStatus(e.DB, id, "analyzing");

  let upstream: Response;
  try {
    upstream = await callAnalyzer(
      `/analyze?bucket_seconds=${bucket}&z_threshold=${z}`,
      {
        method: "POST",
        body: raw.body,                                  // stream R2 -> Python
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        duplex: "half",
      },
    );
  } catch (err) {
    await setStatus(e.DB, id, "failed");
    return errorJson(
      `Không gọi được analyzer Python: ${err instanceof Error ? err.message : String(err)}. ` +
        `Backend đã chạy chưa? (ANALYZER_URL = ${e.ANALYZER_URL})`,
      502,
    );
  }

  if (!upstream.ok) {
    await setStatus(e.DB, id, "failed");
    const detail = await upstream.text().catch(() => "");
    return errorJson(`Analyzer trả lỗi ${upstream.status}: ${detail.slice(0, 300)}`, 502);
  }

  const analysis = (await upstream.json()) as Analysis;

  if (analysis.empty) {
    await setStatus(e.DB, id, "failed");
    return errorJson(
      `Không parse được dòng nào (${analysis.lines_unparsed} dòng không khớp format). ` +
        `Ví dụ: ${(analysis.unparsed_samples ?? []).slice(0, 2).join(" | ")}`,
      422,
    );
  }

  // Cache kết quả để lần xem sau là request nhẹ, không phải tính lại.
  await e.LOGS.put(analysisKey(id), JSON.stringify(analysis), {
    httpMetadata: { contentType: "application/json" },
  });

  await markAnalyzed(e.DB, id, {
    format: analysis.format,
    line_count: analysis.lines_parsed,
    error_count: analysis.totals.errors,
    anomaly_count: analysis.anomalies.length,
    compute_ms: analysis.compute_ms,
  });

  const roundTrip = Math.round((performance.now() - started) * 10) / 10;
  return Response.json(
    {
      analysis,
      _handler: {
        handled_by: "python-service",
        duration_ms: roundTrip,
        note:
          `Python parse ${analysis.lines_parsed.toLocaleString("vi-VN")} dòng trong ` +
          `${analysis.compute_ms} ms; Worker chỉ stream R2 và ghi D1`,
      },
    },
    {
      headers: {
        "X-Handled-By": "python-service",
        "X-Compute-Ms": String(analysis.compute_ms),
        "X-Duration-Ms": String(roundTrip),
        "Cache-Control": "no-store",
      },
    },
  );
}
