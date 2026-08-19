"use client";

/** Số liệu tổng — một con số thì dùng stat tile, không vẽ chart. */

import type { Analysis } from "@/lib/types";
import { ms, num, pct } from "@/lib/format";

export default function StatTiles({ analysis }: { analysis: Analysis }) {
  const high = analysis.anomalies.filter((a) => a.severity === "high").length;

  return (
    <div className="tiles">
      <Tile
        label="Dòng đã parse"
        value={num(analysis.lines_parsed)}
        foot={
          analysis.lines_unparsed > 0
            ? `${num(analysis.lines_unparsed)} dòng không khớp format`
            : "toàn bộ dòng khớp format"
        }
      />
      <Tile
        label="Tỉ lệ lỗi"
        value={pct(analysis.totals.error_rate, 2)}
        foot={`${num(analysis.totals.errors)} ERROR · ${num(analysis.totals.warns)} WARN`}
      />
      <Tile
        label="p95 latency"
        value={analysis.latency ? `${Math.round(analysis.latency.p95_ms)} ms` : "—"}
        foot={
          analysis.latency
            ? `p50 ${Math.round(analysis.latency.p50_ms)} · p99 ${Math.round(
                analysis.latency.p99_ms,
              )} ms`
            : "log không có trường latency"
        }
      />
      <Tile
        label="Bucket bất thường"
        value={num(analysis.anomalies.length)}
        foot={high > 0 ? `${high} mức nghiêm trọng` : "không có mức nghiêm trọng"}
      />
      <Tile
        label="Thời gian Python tính"
        value={ms(analysis.compute_ms)}
        foot={`format ${analysis.format} · bucket ${analysis.bucket_seconds}s`}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  foot,
}: {
  label: string;
  value: string;
  foot: string;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="foot">{foot}</div>
    </div>
  );
}
