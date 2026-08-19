/** NHẸ — đọc JSON kết quả đã cache trong R2, không gọi Python. */
import { analysisKey, env, fail, json } from "@/lib/cf";
import type { Analysis } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();

  const object = await e.LOGS.get(analysisKey(id));
  if (!object) return fail("Chưa phân tích dataset này", 404);

  return json({ analysis: (await object.json()) as Analysis }, started, {
    note: "đọc JSON đã cache từ R2 — không chạy lại Python",
  });
}
