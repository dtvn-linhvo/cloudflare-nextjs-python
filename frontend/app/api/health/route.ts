/** NHẸ — kiểm tra từng binding và analyzer. Dùng để nghiệm thu sau khi deploy. */
import { callAnalyzer, env, hasToken, json } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const e = await env();

  let analyzer: { ok: boolean; detail: string };
  try {
    const res = await callAnalyzer("/health");
    analyzer = { ok: res.ok, detail: res.ok ? await res.text() : `HTTP ${res.status}` };
  } catch (err) {
    analyzer = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  return json(
    {
      bindings: {
        r2: Boolean(e.LOGS),
        d1: Boolean(e.DB),
        analyzer_url: e.ANALYZER_URL ?? null,
        analyzer_token_set: hasToken(e),
      },
      analyzer,
    },
    started,
  );
}
