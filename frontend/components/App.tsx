"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { bytes, ms, num } from "@/lib/format";
import type { Analysis, Dataset } from "@/lib/types";
import Timeline from "./Timeline";
import StatTiles from "./StatTiles";
import HandlerFeed from "./HandlerFeed";
import RawViewer from "./RawViewer";
import ThemeToggle from "./ThemeToggle";
import { AnomalyList, TopErrors, TopSources } from "./Findings";

const SAMPLE_SIZES = [30_000, 120_000, 400_000];
const BUCKETS = [30, 60, 300];

export default function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleSize, setSampleSize] = useState(SAMPLE_SIZES[1]);
  const [bucket, setBucket] = useState(60);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      setDatasets(await api.listDatasets());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được danh sách");
    }
  }, []);

  // Lần đầu vào trang: mở lại dataset đã phân tích gần nhất để không mất chỗ
  // đang xem sau khi reload.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.listDatasets();
        if (cancelled) return;
        setDatasets(list);
        const latest = list.find((d) => d.status === "analyzed");
        if (latest) {
          setSelected(latest.id);
          try {
            setAnalysis(await api.getAnalysis(latest.id));
          } catch {
            /* kết quả cache đã bị xoá — để người dùng bấm Phân tích lại */
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Không tải được danh sách");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Chọn dataset: thử đọc kết quả đã cache (nhẹ) trước khi tính lại (nặng). */
  const select = useCallback(async (id: string) => {
    setSelected(id);
    setAnalysis(null);
    setBusy("Đang mở dataset…");
    try {
      setAnalysis(await api.getAnalysis(id));
      setError(null);
    } catch {
      setAnalysis(null);   // chưa phân tích lần nào — chờ người dùng bấm
    } finally {
      setBusy(null);
    }
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Lỗi không xác định");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /** Tạo xong thì phân tích luôn: demo chỉ cần một cú bấm là thấy kết quả. */
  const createThenAnalyze = (
    label: string,
    create: () => Promise<{ id: string }>,
  ) =>
    run(label, async () => {
      const created = await create();
      setSelected(created.id);
      setAnalysis(null);
      await refresh();
      setBusy("Python đang phân tích toàn bộ log…");
      setAnalysis(await api.analyze(created.id, bucket));
      await refresh();
    });

  const createSample = () =>
    createThenAnalyze(`Python đang sinh ${num(sampleSize)} dòng…`, () =>
      api.createSample(sampleSize),
    );

  const upload = (file: File) =>
    createThenAnalyze(`Đang tải ${file.name} lên R2…`, () => api.upload(file));

  const analyze = (id: string) =>
    run("Python đang phân tích toàn bộ log…", async () => {
      setSelected(id);
      setAnalysis(await api.analyze(id, bucket));
      await refresh();
    });

  const remove = (id: string) =>
    run("Đang xoá…", async () => {
      await api.remove(id);
      if (selected === id) {
        setSelected(null);
        setAnalysis(null);
      }
      await refresh();
    });

  const current = datasets.find((d) => d.id === selected) ?? null;

  return (
    <div className="shell">
      <div className="masthead">
        <div>
          <h1>LogLens</h1>
          <p>
            Phân tích log và phát hiện bất thường. Demo cách chia việc: request
            nhẹ dừng ở Next.js trên Cloudflare Workers, việc nặng đẩy sang
            service Python.
          </p>
        </div>
        <ThemeToggle />
      </div>

      <div className="split-note">
        <div>
          <strong>Next.js Worker — việc nhẹ</strong>
          <span>
            Query metadata trên D1, stream upload vào R2, range-read xem log thô,
            đọc kết quả đã cache. Đều là I/O, chạy ở edge.
          </span>
        </div>
        <div>
          <strong>Python (FastAPI + numpy) — việc nặng</strong>
          <span>
            Parse hàng trăm nghìn dòng, gom bucket theo phút, percentile latency,
            robust z-score phát hiện spike. CPU-bound, cần numpy.
          </span>
        </div>
      </div>

      {/* Một hàng điều khiển duy nhất, đặt trên mọi thứ nó chi phối. */}
      <div className="toolbar">
        <span className="toolbar-label">Log mẫu</span>
        <select
          value={sampleSize}
          onChange={(e) => setSampleSize(Number(e.target.value))}
          aria-label="Số dòng log mẫu"
        >
          {SAMPLE_SIZES.map((n) => (
            <option key={n} value={n}>
              {num(n)} dòng
            </option>
          ))}
        </select>
        <button className="primary" onClick={createSample} disabled={busy !== null}>
          Sinh log mẫu
        </button>

        <span style={{ width: 1, height: 24, background: "var(--hairline)" }} />

        <button onClick={() => fileInput.current?.click()} disabled={busy !== null}>
          Tải file log lên
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".log,.txt,text/plain"
          hidden
          // Chromium tự gắn caret-color vào input file ẩn, không khớp HTML từ server.
          suppressHydrationWarning
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />

        <span style={{ width: 1, height: 24, background: "var(--hairline)" }} />

        <span className="toolbar-label">Bucket</span>
        <select
          value={bucket}
          onChange={(e) => setBucket(Number(e.target.value))}
          aria-label="Độ rộng bucket thời gian"
        >
          {BUCKETS.map((b) => (
            <option key={b} value={b}>
              {b}s
            </option>
          ))}
        </select>

        <span className="spacer" />
        {busy && <span className="muted">{busy}</span>}
      </div>

      {error && <div className="banner">{error}</div>}

      <div className="columns">
        <div style={{ minWidth: 0 }}>
          <DatasetTable
            datasets={datasets}
            selected={selected}
            busy={busy !== null}
            onSelect={(id) => void select(id)}
            onAnalyze={(id) => void analyze(id)}
            onDelete={(id) => void remove(id)}
          />

          {current && !analysis && !busy && (
            <div className="banner info">
              Dataset đã nằm trên R2 nhưng chưa phân tích. Bấm{" "}
              <strong>Phân tích</strong> để Python xử lý{" "}
              {current.line_count ? `${num(current.line_count)} dòng` : bytes(current.size_bytes)}.
            </div>
          )}

          {analysis && (
            <div className={busy ? "working" : undefined}>
              <StatTiles analysis={analysis} />

              <div className="card">
                <h2>Chuỗi thời gian</h2>
                <p className="sub">
                  Ba khung dùng chung trục thời gian. Cố tình không vẽ chồng lưu
                  lượng và tỉ lệ lỗi lên một khung — hai thang đo khác nhau trên
                  cùng trục y sẽ gây đọc sai.
                </p>
                <Timeline
                  timeline={analysis.timeline}
                  anomalies={analysis.anomalies}
                  bucketSeconds={analysis.bucket_seconds}
                />
              </div>

              <AnomalyList analysis={analysis} />
              <TopErrors analysis={analysis} />
              <TopSources analysis={analysis} />
              {selected && <RawViewer datasetId={selected} />}

              {analysis.lines_unparsed > 0 && analysis.unparsed_samples.length > 0 && (
                <div className="card">
                  <h2>Dòng không parse được</h2>
                  <p className="sub">
                    {num(analysis.lines_unparsed)} dòng không khớp format{" "}
                    <code>{analysis.format}</code>. Ví dụ:
                  </p>
                  <div className="raw">
                    {analysis.unparsed_samples.map((s, i) => (
                      <div key={i}>{s}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!current && datasets.length === 0 && !busy && (
            <div className="card">
              <div className="empty">
                Chưa có dataset nào. Bấm <strong>Sinh log mẫu</strong> — Python
                sẽ tạo log có cài sẵn 3 sự cố (bùng nổ lỗi, tăng vọt lưu lượng,
                latency spike) để xem phần phát hiện bất thường hoạt động.
              </div>
            </div>
          )}
        </div>

        <HandlerFeed />
      </div>
    </div>
  );
}

function DatasetTable({
  datasets,
  selected,
  busy,
  onSelect,
  onAnalyze,
  onDelete,
}: {
  datasets: Dataset[];
  selected: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onAnalyze: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (datasets.length === 0) return null;

  return (
    <div className="card">
      <h2>Dataset ({datasets.length})</h2>
      <p className="sub">Metadata đọc từ D1 — một câu SELECT, không đụng log thô.</p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Tên</th>
              <th className="num">Kích thước</th>
              <th className="num">Dòng</th>
              <th>Trạng thái</th>
              <th className="num">Python tính</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr
                key={d.id}
                style={
                  d.id === selected
                    ? { background: "var(--wash)" }
                    : undefined
                }
              >
                <td>
                  <button
                    className="ghost"
                    style={{ padding: 0, textAlign: "left", minHeight: 0 }}
                    onClick={() => onSelect(d.id)}
                    disabled={busy}
                  >
                    <span style={{ color: "var(--ink)" }}>{d.name}</span>
                  </button>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {d.source === "generated" ? "sinh bởi Python" : "upload"} ·{" "}
                    {d.created_at}
                  </div>
                </td>
                <td className="num">{bytes(d.size_bytes)}</td>
                <td className="num">{d.line_count ? num(d.line_count) : "—"}</td>
                <td>
                  {d.status === "analyzed" ? (
                    <span className="badge" style={{ color: "var(--status-good)" }}>
                      đã phân tích
                    </span>
                  ) : d.status === "failed" ? (
                    <span className="badge sev-high">lỗi</span>
                  ) : (
                    <span className="badge" style={{ color: "var(--ink-2)" }}>
                      chưa phân tích
                    </span>
                  )}
                  {d.anomaly_count != null && d.anomaly_count > 0 && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {num(d.anomaly_count)} bất thường
                    </div>
                  )}
                </td>
                <td className="num">{d.compute_ms ? ms(d.compute_ms) : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => onAnalyze(d.id)} disabled={busy}>
                    Phân tích
                  </button>
                  <button
                    className="ghost danger"
                    onClick={() => onDelete(d.id)}
                    disabled={busy}
                  >
                    Xoá
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
