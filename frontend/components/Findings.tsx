"use client";

/** Danh sách bất thường + bảng lỗi/nguồn — kết quả từ Python. */

import type { Analysis } from "@/lib/types";
import { fullTime, num, pct } from "@/lib/format";

const KIND_LABEL: Record<string, string> = {
  error_rate: "Tỉ lệ lỗi",
  error_count: "Số lỗi",
  volume: "Lưu lượng",
  latency: "Latency",
};

export function AnomalyList({ analysis }: { analysis: Analysis }) {
  const { anomalies } = analysis;
  if (anomalies.length === 0) {
    return (
      <div className="card">
        <h2>Bất thường</h2>
        <p className="sub">
          Robust z-score (median/MAD) trên từng chuỗi, ngưỡng 3.5.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Không phát hiện bucket nào lệch khỏi mức thường.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Bất thường ({num(anomalies.length)} bucket)</h2>
      <p className="sub">
        Robust z-score (median/MAD) trên từng chuỗi, ngưỡng 3.5. Dùng median thay
        vì mean để chính cái spike không kéo lệch mức nền.
      </p>
      <div className="scroll-y scroll-x">
        <table>
          <thead>
            <tr>
              <th>Thời điểm (UTC)</th>
              <th>Loại</th>
              <th>Giá trị</th>
              <th>Mức thường</th>
              <th className="num">z</th>
              <th>Mức độ</th>
            </tr>
          </thead>
          <tbody>
            {anomalies.map((a, i) => (
              <tr key={`${a.t}-${a.kind}-${i}`}>
                <td className="mono">{fullTime(a.t)}</td>
                <td>{KIND_LABEL[a.kind] ?? a.kind}</td>
                <td className="tnum">{a.value}</td>
                <td className="tnum muted">{a.baseline}</td>
                <td className="num">{a.score.toFixed(1)}</td>
                <td>
                  <span className={`badge sev-${a.severity}`}>
                    {a.severity === "high" ? "nghiêm trọng" : "cần xem"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TopErrors({ analysis }: { analysis: Analysis }) {
  if (analysis.top_errors.length === 0) return null;
  return (
    <div className="card">
      <h2>Nhóm lỗi nhiều nhất</h2>
      <p className="sub">
        Message được chuẩn hoá thành template (số → <code>&lt;N&gt;</code>, IP →{" "}
        <code>&lt;IP&gt;</code>…) rồi gom nhóm, nên cùng một lỗi không bị đếm
        thành hàng nghìn dòng khác nhau.
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th className="num">Số lần</th>
              <th>Template</th>
              <th>Nguồn</th>
              <th>Lần đầu → cuối</th>
            </tr>
          </thead>
          <tbody>
            {analysis.top_errors.map((e) => (
              <tr key={e.template}>
                <td className="num">{num(e.count)}</td>
                <td className="mono">{e.template}</td>
                <td className="mono">{e.source}</td>
                <td className="mono muted" style={{ whiteSpace: "nowrap" }}>
                  {fullTime(e.first_seen)} → {fullTime(e.last_seen)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TopSources({ analysis }: { analysis: Analysis }) {
  if (analysis.top_sources.length === 0) return null;
  const codes = Object.entries(analysis.status_codes);
  return (
    <div className="card">
      <h2>Theo nguồn</h2>
      <p className="sub">Logger (log ứng dụng) hoặc endpoint (access log).</p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Nguồn</th>
              <th className="num">Tổng</th>
              <th className="num">Lỗi</th>
              <th className="num">Tỉ lệ lỗi</th>
              <th className="num">p95 (ms)</th>
            </tr>
          </thead>
          <tbody>
            {analysis.top_sources.map((s) => (
              <tr key={s.source}>
                <td className="mono">{s.source}</td>
                <td className="num">{num(s.total)}</td>
                <td className="num">{num(s.errors)}</td>
                <td className="num">{pct(s.error_rate, 1)}</td>
                <td className="num">{s.p95_ms === null ? "—" : Math.round(s.p95_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {codes.length > 0 && (
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <span className="toolbar-label">Status code</span>
          {codes.map(([code, count]) => (
            <span key={code} className="badge" style={{ color: "var(--ink-2)" }}>
              {code} · {num(count)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
