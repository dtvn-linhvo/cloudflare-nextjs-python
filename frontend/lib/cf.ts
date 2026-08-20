/**
 * Helper dùng chung cho các Route Handler.
 *
 * Kiến trúc: Worker này KHÔNG có binding R2/D1 nữa. Tầng dữ liệu nằm ở Worker
 * backend (Python) — xem backend/src/worker.py. Ở đây chỉ còn UI + proxy.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function env(): Promise<CloudflareEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env;
}

/**
 * Token dùng chung với backend.
 *
 * Production: secret Cloudflare (`wrangler secret put ANALYZER_TOKEN`) -> nằm
 * trong `env`. Trong `next dev` thì KHÔNG: adapter OpenNext gọi
 * getPlatformProxy({ envFiles: [] }), cố tình không nạp .dev.vars vào env
 * Cloudflare. Nên local đặt trong .env.local và đọc qua process.env.
 */
function token(e: CloudflareEnv): string | undefined {
  const fromBinding = (e as unknown as { ANALYZER_TOKEN?: string }).ANALYZER_TOKEN;
  return fromBinding || process.env.ANALYZER_TOKEN || undefined;
}

export const hasToken = (e: CloudflareEnv) => Boolean(token(e));

/** Gọi Worker backend qua ANALYZER_URL, kèm token nếu đã cấu hình. */
export async function callBackend(
  path: string,
  init?: RequestInit & { duplex?: "half" },
): Promise<Response> {
  const e = await env();
  if (!e.ANALYZER_URL) throw new Error("Thiếu cấu hình ANALYZER_URL");

  const headers = new Headers(init?.headers);
  const t = token(e);
  if (t) headers.set("X-Analyzer-Token", t);

  return fetch(`${e.ANALYZER_URL.replace(/\/$/, "")}${path}`, { ...init, headers });
}

/**
 * Chuyển tiếp một request sang backend rồi bọc lại kèm thông tin handler.
 *
 * Chỉ response được parse — body request (upload) vẫn chảy dạng stream, Worker
 * này không đọc byte nào của log thô.
 *
 * Backend đặt phần mô tả việc nó vừa làm vào `_note`; ở đây tách ra để UI hiện
 * đúng chỗ, phần còn lại là payload.
 */
export async function proxy(
  path: string,
  started: number,
  init?: RequestInit & { duplex?: "half" },
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await callBackend(path, init);
  } catch (err) {
    const e = await env();
    return fail(
      `Không gọi được backend: ${err instanceof Error ? err.message : String(err)} ` +
        `(ANALYZER_URL = ${e.ANALYZER_URL})`,
      502,
    );
  }

  const text = await upstream.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return fail(`Backend trả về không phải JSON: ${text.slice(0, 200)}`, 502);
  }

  if (!upstream.ok) {
    // FastAPI trả lỗi ở khoá `detail`.
    const detail = body.detail ?? body.error ?? `HTTP ${upstream.status}`;
    return fail(String(detail).slice(0, 300), upstream.status);
  }

  const { _note, ...data } = body as { _note?: string };
  return json(data, started, {
    by: "python-worker",
    note: _note,
    status: upstream.status,
  });
}

/** Trả JSON kèm thông tin "ai xử lý request này" để UI minh hoạ được. */
export function json(
  data: object,
  startedAt: number,
  opts: { by?: "nextjs-worker" | "python-worker"; note?: string; status?: number } = {},
): Response {
  const by = opts.by ?? "nextjs-worker";
  const ms = Math.round((performance.now() - startedAt) * 10) / 10;
  return Response.json(
    { ...data, _handler: { handled_by: by, duration_ms: ms, note: opts.note } },
    {
      status: opts.status ?? 200,
      headers: { "X-Handled-By": by, "Cache-Control": "no-store" },
    },
  );
}

export function fail(message: string, status = 400): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
