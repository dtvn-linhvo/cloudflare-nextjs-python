"use client";

/** Kiểu dữ liệu + client gọi API. Mỗi lời gọi trả kèm _handler để UI biết ai xử lý. */

export interface Dataset {
  id: string;
  name: string;
  size_bytes: number;
  status: "pending" | "analyzed" | "failed";
  line_count: number | null;
  error_rate: number | null;
  compute_ms: number | null;
  created_at: string;
}

export interface Bucket {
  t: string;
  total: number;
  error: number;
}

export interface Analysis {
  lines_total: number;
  lines_parsed: number;
  lines_skipped: number;
  levels: Record<string, number>;
  error_rate: number;
  buckets: Bucket[];
  busiest: Bucket[];
  top_errors: { message: string; count: number }[];
  compute_ms: number;
}

export interface Handler {
  handled_by: "nextjs-worker" | "python-worker";
  duration_ms: number;
  note?: string;
}

/** Kết quả kèm thông tin handler của request vừa gọi. */
export type WithHandler<T> = { data: T; handler: Handler };

async function call<T>(path: string, init?: RequestInit): Promise<WithHandler<T>> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};

  if (!res.ok) throw new Error(body.error ?? `Request lỗi ${res.status}`);
  return { data: body as T, handler: body._handler as Handler };
}

export const api = {
  health: () => call<{ bindings: Record<string, unknown>; analyzer: { ok: boolean } }>("/api/health"),

  list: () => call<{ datasets: Dataset[] }>("/api/datasets"),

  upload: (file: File) =>
    call<{ id: string }>("/api/datasets", {
      method: "POST",
      body: file,
      // Header HTTP chỉ nhận ASCII — tên file tiếng Việt phải encode.
      headers: { "x-file-name": /^[\x20-\x7e]*$/.test(file.name) ? file.name : encodeURIComponent(file.name) },
    }),

  analyze: (id: string) =>
    call<{ analysis: Analysis }>(`/api/datasets/${id}/analyze`, { method: "POST" }),

  analysis: (id: string) => call<{ analysis: Analysis }>(`/api/datasets/${id}/analysis`),

  lines: (id: string, offset: number) =>
    call<{ lines: string[]; next_offset: number | null; total_bytes: number; read_bytes: number }>(
      `/api/datasets/${id}/lines?offset=${offset}`,
    ),

  remove: (id: string) => call<unknown>(`/api/datasets/${id}`, { method: "DELETE" }),
};

export const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1e6 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1e6).toFixed(1)} MB`;

export const num = (n: number) => n.toLocaleString("vi-VN");
