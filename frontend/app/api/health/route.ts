/** NHẸ — kiểm tra Worker và analyzer Python còn sống. */
import { callAnalyzer, env, hasAnalyzerToken } from "@/lib/cf";
import { jsonHandledByWorker } from "@/lib/http";

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

  const bindings = {
    r2: Boolean(e.LOGS),
    d1: Boolean(e.DB),
    analyzer_url: e.ANALYZER_URL ?? null,
    analyzer_token_set: hasAnalyzerToken(e),
  };

  return jsonHandledByWorker({ worker: "ok", bindings, analyzer }, started);
}
