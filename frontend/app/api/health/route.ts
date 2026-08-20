/**
 * NHẸ — kiểm tra cấu hình sau khi deploy.
 *
 * Binding R2/D1 giờ nằm ở backend, nên trạng thái của chúng lấy từ /health của
 * backend chứ không kiểm tra được tại đây.
 */
import { backendTransport, callBackend, env, hasToken, json } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = performance.now();
  const e = await env();

  let backend: { ok: boolean; detail: string };
  let bindings: { r2?: boolean; d1?: boolean } = {};
  try {
    const res = await callBackend("/health");
    const text = await res.text();
    backend = { ok: res.ok, detail: res.ok ? text : `HTTP ${res.status}` };
    if (res.ok) {
      try {
        bindings = (JSON.parse(text) as { bindings?: { r2?: boolean; d1?: boolean } }).bindings ?? {};
      } catch {
        // /health trả về không phải JSON — coi như không biết trạng thái binding.
      }
    }
  } catch (err) {
    backend = { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }

  return json(
    {
      bindings: {
        r2: Boolean(bindings.r2),
        d1: Boolean(bindings.d1),
        analyzer_url: e.ANALYZER_URL ?? null,
        analyzer_token_set: hasToken(e),
        backend_transport: backendTransport(e),
      },
      analyzer: backend,
    },
    started,
  );
}
