"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, bytes, num } from "@/lib/api";
import type { Analysis, Dataset, Handler } from "@/lib/api";

export default function App() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>>["data"] | null>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [log, setLog] = useState<{ lines: string[]; next: number | null; note: string } | null>(null);
  const [last, setLast] = useState<Handler | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Mọi lời gọi API đi qua đây để ghi lại "ai xử lý request vừa rồi". */
  const run = useCallback(async (label: string, fn: () => Promise<Handler | void>) => {
    setBusy(label);
    setError(null);
    try {
      const handler = await fn();
      if (handler) setLast(handler);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lỗi không xác định");
    } finally {
      setBusy(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    const { data, handler } = await api.list();
    setDatasets(data.datasets);
    return handler;
  }, []);

  useEffect(() => {
    void run("Đang kiểm tra binding…", async () => {
      setHealth((await api.health()).data);
      return refresh();
    });
  }, [run, refresh]);

  const open = (id: string) =>
    run("Đang mở dataset…", async () => {
      setSelected(id);
      setAnalysis(null);
      setLog(null);
      const [a, l] = await Promise.all([
        api.analysis(id).catch(() => null),
        api.lines(id, 0),
      ]);
      if (a) setAnalysis(a.data.analysis);
      setLog({ lines: l.data.lines, next: l.data.next_offset, note: l.handler.note ?? "" });
      return l.handler;
    });

  const analyze = (id: string) =>
    run("Python đang quét toàn bộ log…", async () => {
      setSelected(id);
      const { data, handler } = await api.analyze(id);
      setAnalysis(data.analysis);
      await refresh();
      return handler;
    });

  const upload = (file: File) =>
    run(`Đang tải ${file.name} lên R2…`, async () => {
      const { data, handler } = await api.upload(file);
      await refresh();
      void analyze(data.id);
      return handler;
    });

  const more = () =>
    run("Đọc cửa sổ tiếp theo…", async () => {
      if (!selected || log?.next == null) return;
      const { data, handler } = await api.lines(selected, log.next);
      setLog({ lines: data.lines, next: data.next_offset, note: handler.note ?? "" });
      return handler;
    });

  const remove = (id: string) =>
    run("Đang xoá…", async () => {
      const { handler } = await api.remove(id);
      if (selected === id) {
        setSelected(null);
        setAnalysis(null);
        setLog(null);
      }
      await refresh();
      return handler;
    });

  return (
    <main className="shell">
      <h1>LogLens</h1>
      <p className="lede">
        Demo một web application chạy trên Cloudflare: Next.js ở Workers lo UI
        và chuyển tiếp request, Worker Python nắm D1 + R2 và toàn bộ phần phân
        tích log.
      </p>

      {/* Trạng thái config — chỗ nghiệm thu sau khi deploy */}
      {health && (
        <div className="card">
          <h2>Cấu hình đang hoạt động</h2>
          <ul className="checks">
            <Check
              ok={Boolean(health.bindings.r2)}
              label="R2 binding LOGS"
              hint="log thô + cache kết quả (binding của Worker Python)"
            />
            <Check
              ok={Boolean(health.bindings.d1)}
              label="D1 binding DB"
              hint="metadata dataset (binding của Worker Python)"
            />
            <Check
              ok={Boolean(health.bindings.analyzer_url)}
              label="Var ANALYZER_URL"
              hint={String(health.bindings.analyzer_url ?? "chưa đặt")}
            />
            <Check
              ok={Boolean(health.bindings.analyzer_token_set)}
              label="Secret ANALYZER_TOKEN"
              hint={health.bindings.analyzer_token_set ? "đã đặt" : "chưa đặt (bắt buộc khi deploy)"}
              warnOnly
            />
            <Check
              ok={health.analyzer.ok}
              label="Worker backend Python"
              hint={
                health.bindings.backend_transport === "service-binding"
                  ? "phản hồi /health qua service binding"
                  : `phản hồi /health qua HTTP (${health.bindings.analyzer_url ?? "?"})`
              }
            />
          </ul>
        </div>
      )}

      <div className="toolbar">
        <button className="primary" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
          Tải file log lên
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".log,.txt,text/plain"
          hidden
          suppressHydrationWarning
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <span className="muted">
          Chưa có file? <code>python3 backend/scripts/generate_logs.py sample.log 2000</code>
        </span>
        <span className="spacer" />
        {busy && <span className="muted">{busy}</span>}
      </div>

      {last && (
        <div className="handler">
          <span className={`badge ${last.handled_by === "python-worker" ? "python" : "worker"}`}>
            {last.handled_by === "python-worker" ? "Python Worker" : "Next.js Worker"}
          </span>
          <strong>{last.duration_ms} ms</strong>
          {last.note && <span className="muted">— {last.note}</span>}
        </div>
      )}

      {error && <div className="banner">{error}</div>}

      {datasets.length > 0 && (
        <div className="card">
          <h2>Dataset</h2>
          <table>
            <thead>
              <tr>
                <th>Tên</th>
                <th className="num">Kích thước</th>
                <th className="num">Dòng</th>
                <th className="num">Tỉ lệ lỗi</th>
                <th className="num">Python tính</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className={d.id === selected ? "on" : undefined}>
                  <td>{d.name}</td>
                  <td className="num">{bytes(d.size_bytes)}</td>
                  <td className="num">{d.line_count ? num(d.line_count) : "—"}</td>
                  <td className="num">
                    {d.error_rate == null ? "—" : `${(d.error_rate * 100).toFixed(2)}%`}
                  </td>
                  <td className="num">{d.compute_ms == null ? "—" : `${d.compute_ms} ms`}</td>
                  <td className="row">
                    <button onClick={() => void open(d.id)} disabled={busy !== null}>Xem</button>
                    <button onClick={() => void analyze(d.id)} disabled={busy !== null}>Phân tích</button>
                    <button className="danger" onClick={() => void remove(d.id)} disabled={busy !== null}>
                      Xoá
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {analysis && (
        <div className="card">
          <h2>Kết quả (Python)</h2>
          <p className="sub">
            {num(analysis.lines_parsed)} dòng · {analysis.buckets.length} bucket/phút ·{" "}
            {(analysis.error_rate * 100).toFixed(2)}% lỗi · INFO {num(analysis.levels.INFO)} / WARN{" "}
            {num(analysis.levels.WARN)} / ERROR {num(analysis.levels.ERROR)}
            {analysis.lines_skipped > 0 && ` · ${num(analysis.lines_skipped)} dòng không khớp format`}
          </p>

          <div className="two">
            <div>
              <h3>Phút có nhiều lỗi nhất</h3>
              <table>
                <thead>
                  <tr>
                    <th>Phút (UTC)</th>
                    <th className="num">Tổng</th>
                    <th className="num">Lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.busiest.map((b) => (
                    <tr key={b.t}>
                      <td className="mono">{b.t.replace("T", " ")}</td>
                      <td className="num">{num(b.total)}</td>
                      <td className="num">{num(b.error)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3>Nhóm lỗi nhiều nhất</h3>
              <table>
                <thead>
                  <tr>
                    <th className="num">Số lần</th>
                    <th>Message (số đã chuẩn hoá)</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.top_errors.map((e) => (
                    <tr key={e.message}>
                      <td className="num">{num(e.count)}</td>
                      <td className="mono">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {log && (
        <div className="card">
          <h2>Log thô (Worker)</h2>
          <p className="sub">{log.note}</p>
          <pre className="raw">{log.lines.join("\n")}</pre>
          <button onClick={() => void more()} disabled={busy !== null || log.next == null}>
            {log.next == null ? "Đã tới cuối file" : "Đọc 64 KB tiếp →"}
          </button>
        </div>
      )}
    </main>
  );
}

function Check({
  ok,
  label,
  hint,
  warnOnly,
}: {
  ok: boolean;
  label: string;
  hint: string;
  warnOnly?: boolean;
}) {
  return (
    <li>
      <span className={ok ? "ok" : warnOnly ? "warn" : "bad"}>{ok ? "✓" : warnOnly ? "!" : "✗"}</span>
      <strong>{label}</strong>
      <span className="muted">{hint}</span>
    </li>
  );
}
