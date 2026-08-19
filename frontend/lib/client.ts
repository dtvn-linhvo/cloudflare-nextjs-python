"use client";

import type { Analysis, Dataset, LinesPage } from "./types";

/** Một dòng trong bảng "ai xử lý request nào". */
export interface FeedEntry {
  id: number;
  method: string;
  path: string;
  handledBy: "nextjs-worker" | "python-service";
  durationMs: number;
  note?: string;
  status: number;
}

/* --- store nhỏ cho request feed, dùng với useSyncExternalStore --- */

/** Hằng số dùng chung cho snapshot phía server: useSyncExternalStore so sánh
 *  bằng tham chiếu, trả về [] mới mỗi lần gọi sẽ gây cảnh báo vòng lặp vô hạn. */
const EMPTY: readonly FeedEntry[] = Object.freeze([]);

let entries: FeedEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function push(entry: Omit<FeedEntry, "id">) {
  entries = [{ ...entry, id: ++seq }, ...entries].slice(0, 40);
  listeners.forEach((l) => l());
}

export const feedStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot() {
    return entries;
  },
  getServerSnapshot() {
    return EMPTY as FeedEntry[];
  },
  clear() {
    entries = [];
    listeners.forEach((l) => l());
  },
};

interface HandlerMeta {
  handled_by?: "nextjs-worker" | "python-service";
  duration_ms?: number;
  note?: string;
}

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const method = init?.method ?? "GET";

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
  }

  const meta = (body as { _handler?: HandlerMeta } | null)?._handler;
  push({
    method,
    path,
    handledBy:
      meta?.handled_by ??
      ((res.headers.get("x-handled-by") as FeedEntry["handledBy"]) || "nextjs-worker"),
    durationMs: meta?.duration_ms ?? Number(res.headers.get("x-duration-ms") ?? 0),
    note: meta?.note,
    status: res.status,
  });

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `Request lỗi ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  listDatasets: () =>
    call<{ datasets: Dataset[] }>("/api/datasets").then((r) => r.datasets),

  getDataset: (id: string) =>
    call<{ dataset: Dataset }>(`/api/datasets/${id}`).then((r) => r.dataset),

  upload: (file: File) =>
    call<{ id: string }>("/api/datasets", {
      method: "POST",
      body: file,
      headers: { "x-file-name": encodeFileName(file.name) },
    }),

  createSample: (lines: number) =>
    call<{ id: string; line_count: number }>(`/api/sample?lines=${lines}`, {
      method: "POST",
    }),

  analyze: (id: string, bucketSeconds: number) =>
    call<{ analysis: Analysis }>(
      `/api/datasets/${id}/analyze?bucket_seconds=${bucketSeconds}`,
      { method: "POST" },
    ).then((r) => r.analysis),

  getAnalysis: (id: string) =>
    call<{ analysis: Analysis }>(`/api/datasets/${id}/analysis`).then((r) => r.analysis),

  remove: (id: string) => call<unknown>(`/api/datasets/${id}`, { method: "DELETE" }),

  lines: (id: string, params: { offset: number; level?: string; q?: string }) => {
    const qs = new URLSearchParams({ offset: String(params.offset) });
    if (params.level) qs.set("level", params.level);
    if (params.q) qs.set("q", params.q);
    return call<LinesPage & { total_bytes: number }>(
      `/api/datasets/${id}/lines?${qs}`,
    );
  },
};

/** Header HTTP chỉ nhận ASCII — tên file tiếng Việt phải encode. */
function encodeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(name) ? name : encodeURIComponent(name);
}
