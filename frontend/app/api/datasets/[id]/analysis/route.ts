/** NHẸ — đọc JSON kết quả đã cache trong R2, không gọi Python. */
import { analysisKey, env } from "@/lib/cf";
import { errorJson, jsonHandledByWorker } from "@/lib/http";
import type { Analysis } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();

  const object = await e.LOGS.get(analysisKey(id));
  if (!object) return errorJson("Chưa có kết quả phân tích cho dataset này", 404);

  const analysis = (await object.json()) as Analysis;
  return jsonHandledByWorker(
    { analysis },
    started,
    { note: "đọc JSON đã cache từ R2 — không chạy lại Python" },
  );
}
