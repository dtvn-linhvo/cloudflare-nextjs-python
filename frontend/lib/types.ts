export type DatasetStatus = "pending" | "analyzing" | "analyzed" | "failed";

export interface Dataset {
  id: string;
  name: string;
  size_bytes: number;
  line_count: number | null;
  source: "upload" | "generated";
  status: DatasetStatus;
  format: string | null;
  error_count: number | null;
  anomaly_count: number | null;
  compute_ms: number | null;
  analyzed_at: string | null;
  created_at: string;
}

export interface TimelinePoint {
  t: string;
  total: number;
  error: number;
  warn: number;
  error_rate: number;
  p95_ms: number | null;
}

export type AnomalyKind = "error_rate" | "volume" | "error_count" | "latency";

export interface Anomaly {
  t: string;
  kind: AnomalyKind;
  score: number;
  value: string;
  baseline: string;
  severity: "high" | "medium";
  detail: string;
}

export interface ErrorTemplate {
  template: string;
  count: number;
  example: string;
  source: string;
  first_seen: string;
  last_seen: string;
}

export interface SourceRow {
  source: string;
  total: number;
  errors: number;
  error_rate: number;
  p95_ms: number | null;
}

export interface Analysis {
  format: string;
  lines_total: number;
  lines_parsed: number;
  lines_unparsed: number;
  unparsed_samples: string[];
  empty?: boolean;
  bucket_seconds: number;
  time_range: { start: string; end: string; span_seconds: number };
  levels: Record<string, number>;
  totals: {
    errors: number;
    warns: number;
    error_rate: number;
    lines_with_latency: number;
  };
  latency: { p50_ms: number; p95_ms: number; p99_ms: number; max_ms: number } | null;
  timeline: TimelinePoint[];
  anomalies: Anomaly[];
  top_errors: ErrorTemplate[];
  top_sources: SourceRow[];
  status_codes: Record<string, number>;
  compute_ms: number;
  read_ms?: number;
  bytes_in?: number;
  handled_by?: string;
}

/** Ai xử lý request, để UI minh hoạ được sự phân chia nhẹ/nặng. */
export interface HandlerInfo {
  handled_by: "nextjs-worker" | "python-service";
  duration_ms: number;
  note?: string;
}

export interface LinesPage {
  lines: string[];
  matched: number;
  scanned_bytes: number;
  next_offset: number | null;
  eof: boolean;
}
