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

/** Đường đang dùng để gọi backend — hiện trên trang cấu hình để nghiệm thu. */
export const backendTransport = (e: CloudflareEnv): "service-binding" | "http" =>
  (e as unknown as { ANALYZER?: Fetcher }).ANALYZER ? "service-binding" : "http";

/**
 * Gọi Worker backend.
 *
 * Ưu tiên service binding ANALYZER: request đi thẳng trong mạng Cloudflare,
 * backend không cần lộ ra internet. Local dev cũng đi đường này nhờ dev
 * registry của wrangler, miễn là backend đang chạy `pywrangler dev`.
 *
 * Rơi về ANALYZER_URL khi không có binding — ví dụ chạy frontend một mình, hay
 * khi cố tình trỏ sang một analyzer ở nơi khác.
 */
export async function callBackend(
  path: string,
  init?: RequestInit & { duplex?: "half" },
): Promise<Response> {
  const e = await env();

  const headers = new Headers(init?.headers);
  const t = token(e);
  if (t) headers.set("X-Analyzer-Token", t);

  const backend = (e as unknown as { ANALYZER?: Fetcher }).ANALYZER;
  if (backend) {
    // Hostname không có ý nghĩa với service binding, chỉ cần là URL hợp lệ.
    return backend.fetch(`https://backend${path}`, { ...init, headers });
  }

  if (!e.ANALYZER_URL) {
    throw new Error("Missing both the ANALYZER service binding and the ANALYZER_URL var");
  }
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
      `Could not reach the backend: ${err instanceof Error ? err.message : String(err)} ` +
        `(ANALYZER_URL = ${e.ANALYZER_URL})`,
      502,
    );
  }

  const text = await upstream.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return fail(`Backend did not return JSON: ${text.slice(0, 200)}`, 502);
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
