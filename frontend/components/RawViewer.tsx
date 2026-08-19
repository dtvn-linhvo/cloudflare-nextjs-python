"use client";

/**
 * Xem log thô — minh hoạ đường NHẸ.
 *
 * Không tải cả file: mỗi lần lật trang Worker chỉ đọc một cửa sổ 64 KB từ R2
 * bằng range read, dù file có 22 MB.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { bytes } from "@/lib/format";
import type { LinesPage } from "@/lib/types";

const LEVELS = ["", "ERROR", "WARN", "INFO"];

export default function RawViewer({ datasetId }: { datasetId: string }) {
  const [offset, setOffset] = useState(0);
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<(LinesPage & { total_bytes: number }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextOffset: number, nextLevel: string, nextQuery: string) => {
      setLoading(true);
      try {
        const res = await api.lines(datasetId, {
          offset: nextOffset,
          level: nextLevel,
          q: nextQuery,
        });
        setPage(res);
        setOffset(nextOffset);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Lỗi không xác định");
      } finally {
        setLoading(false);
      }
    },
    [datasetId],
  );

  useEffect(() => {
    setOffset(0);
    void load(0, level, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  return (
    <div className="card">
      <h2>Log thô</h2>
      <p className="sub">
        Đường nhẹ: Worker đọc R2 range{" "}
        {page ? `${bytes(page.scanned_bytes)} / ${bytes(page.total_bytes)}` : "…"} —
        không gọi Python, không tải cả file.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="toolbar-label">Level</span>
        <select
          aria-label="Level"
          value={level}
          onChange={(e) => {
            setLevel(e.target.value);
            void load(0, e.target.value, q);
          }}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l || "tất cả"}
            </option>
          ))}
        </select>

        <input
          type="text"
          aria-label="Tìm trong cửa sổ hiện tại"
          placeholder="Tìm trong cửa sổ hiện tại…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(offset, level, q);
          }}
          style={{ minWidth: 220 }}
        />
        <button onClick={() => void load(offset, level, q)} disabled={loading}>
          Tìm
        </button>

        <span className="spacer" />
        <button
          onClick={() => void load(0, level, q)}
          disabled={loading || offset === 0}
        >
          Về đầu
        </button>
        <button
          onClick={() => page?.next_offset != null && void load(page.next_offset, level, q)}
          disabled={loading || !page || page.next_offset === null}
        >
          Cửa sổ sau →
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      {page && (
        <>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
            {page.matched} dòng khớp trong cửa sổ này
            {page.matched > page.lines.length && ` (hiện ${page.lines.length} dòng đầu)`}
            {" · offset "}
            <span className="tnum">{offset.toLocaleString("vi-VN")}</span>
            {page.eof && " · đã tới cuối file"}
          </p>
          <div className={`raw${loading ? " working" : ""}`}>
            {page.lines.length === 0 ? (
              <span className="muted">Không có dòng nào khớp trong cửa sổ này.</span>
            ) : (
              page.lines.map((line, i) => (
                <div key={i} className={`lvl-${levelOf(line)}`}>
                  {line}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function levelOf(line: string): string {
  if (line.includes("ERROR")) return "ERROR";
  if (line.includes("WARN")) return "WARN";
  return "OTHER";
}
