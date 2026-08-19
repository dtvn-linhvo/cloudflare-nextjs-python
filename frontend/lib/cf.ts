/** Bindings Cloudflare + helper dùng chung cho các Route Handler. */
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function env(): Promise<CloudflareEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env;
}

/** Key R2: log thô và JSON kết quả của mỗi dataset. */
export const rawKey = (id: string) => `raw/${id}.log`;
export const analysisKey = (id: string) => `analysis/${id}.json`;

/**
 * Token dùng chung với analyzer.
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

/** Gọi analyzer Python qua ANALYZER_URL, kèm token nếu đã cấu hình. */
export async function callAnalyzer(
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
 * Ghi ReadableStream vào R2.
 *
 * R2.put() chỉ nhận stream khi biết trước độ dài: trên workerd bọc qua
 * FixedLengthStream để dữ liệu chảy thẳng vào R2; trong `next dev` (Node) không
 * có API đó nên buffer — chấp nhận được vì upload đã chặn ở MAX_UPLOAD_BYTES.
 */
export async function putToR2(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream,
  length: number | null,
): Promise<R2Object | null> {
  const opts = { httpMetadata: { contentType: "text/plain; charset=utf-8" } };
  if (length && typeof FixedLengthStream !== "undefined") {
    const fixed = new FixedLengthStream(length);
    void body.pipeTo(fixed.writable).catch(() => {});
    return bucket.put(key, fixed.readable, opts);
  }
  return bucket.put(key, await new Response(body).arrayBuffer(), opts);
}

/** Trả JSON kèm thông tin "ai xử lý request này" để UI minh hoạ được. */
export function json(
  data: object,
  startedAt: number,
  opts: { by?: "nextjs-worker" | "python-service"; note?: string; status?: number } = {},
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
