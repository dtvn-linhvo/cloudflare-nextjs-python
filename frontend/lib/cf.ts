import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Bindings Cloudflare (R2 / D1 / vars). Hoạt động cả trong `next dev`. */
export async function env(): Promise<CloudflareEnv> {
  const { env } = await getCloudflareContext({ async: true });
  return env;
}

/**
 * Token dùng chung với analyzer.
 *
 * Trên production đây là secret Cloudflare (`wrangler secret put ANALYZER_TOKEN`)
 * nên nằm trong `env`. Trong `next dev` thì KHÔNG: adapter OpenNext gọi
 * getPlatformProxy({ envFiles: [] }), tức cố tình không nạp .dev.vars/.env vào
 * env của Cloudflare. Vì vậy local đặt token trong .env.local và đọc qua
 * process.env.
 */
function analyzerToken(e: CloudflareEnv): string | undefined {
  const fromBinding = (e as unknown as { ANALYZER_TOKEN?: string }).ANALYZER_TOKEN;
  return fromBinding || process.env.ANALYZER_TOKEN || undefined;
}

/**
 * Gọi analyzer Python qua HTTP.
 *
 * Analyzer là một service Python thường (uvicorn), không chạy trong Cloudflare
 * nên bắt buộc đi qua URL. Vì endpoint /analyze tốn CPU, nếu đặt ANALYZER_TOKEN
 * thì mọi request sẽ mang header X-Analyzer-Token và backend chặn request
 * không có token.
 */
export async function callAnalyzer(
  path: string,
  init?: RequestInit & { duplex?: "half" },
): Promise<Response> {
  const e = await env();

  const base = e.ANALYZER_URL;
  if (!base) throw new Error("Thiếu cấu hình ANALYZER_URL");

  const token = analyzerToken(e);
  const headers = new Headers(init?.headers);
  if (token) headers.set("X-Analyzer-Token", token);

  return fetch(`${base.replace(/\/$/, "")}${path}`, { ...init, headers });
}

/** Cho /api/health báo được là token đã cấu hình hay chưa. */
export function hasAnalyzerToken(e: CloudflareEnv): boolean {
  return Boolean(analyzerToken(e));
}

export function maxUploadBytes(e: CloudflareEnv): number {
  const n = Number(e.MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
}

/** Key R2 cho log thô và cho JSON kết quả. */
export const rawKey = (id: string) => `raw/${id}.log`;
export const analysisKey = (id: string) => `analysis/${id}.json`;

/**
 * Ghi một ReadableStream vào R2.
 *
 * R2.put() chỉ nhận stream khi biết trước độ dài. Trên workerd (production) ta
 * bọc qua FixedLengthStream để dữ liệu chảy thẳng vào R2, Worker không giữ cả
 * file. Trong `next dev` runtime là Node nên không có FixedLengthStream —
 * fallback buffer vào bộ nhớ, chấp nhận được vì upload đã bị chặn ở
 * MAX_UPLOAD_BYTES.
 */
export async function putToR2(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream,
  contentLength: number | null,
  options?: R2PutOptions,
): Promise<{ object: R2Object | null; streamed: boolean }> {
  const canStream =
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > 0 &&
    typeof FixedLengthStream !== "undefined";

  if (canStream) {
    const fixed = new FixedLengthStream(contentLength!);
    // Không await: R2 đọc đầu readable trong khi upstream vẫn đang đổ vào.
    void body.pipeTo(fixed.writable).catch(() => {});
    const object = await bucket.put(key, fixed.readable, options);
    return { object, streamed: true };
  }

  const buffer = await new Response(body).arrayBuffer();
  const object = await bucket.put(key, buffer, options);
  return { object, streamed: false };
}
