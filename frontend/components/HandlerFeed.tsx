"use client";

/** Bảng "ai xử lý request nào" — chỗ nhìn thấy được sự phân chia nhẹ/nặng. */

import { useSyncExternalStore } from "react";
import { feedStore } from "@/lib/client";
import { ms } from "@/lib/format";

export default function HandlerFeed() {
  const entries = useSyncExternalStore(
    feedStore.subscribe,
    feedStore.getSnapshot,
    feedStore.getServerSnapshot,
  );

  const worker = entries.filter((e) => e.handledBy === "nextjs-worker");
  const python = entries.filter((e) => e.handledBy === "python-service");
  const avg = (list: typeof entries) =>
    list.length ? list.reduce((s, e) => s + e.durationMs, 0) / list.length : 0;

  return (
    <div className="card">
      <h2>Ai xử lý request này?</h2>
      <p className="sub">
        Mỗi request phía dưới ghi lại nơi thực sự làm việc. Request nhẹ dừng ở
        Worker; chỉ hai đường nặng mới gọi sang service Python.
      </p>

      <div className="row" style={{ marginBottom: 12, gap: 16 }}>
        <span>
          <span className="badge worker">
            <span className="dot" />
            Next.js Worker
          </span>{" "}
          <span className="tnum muted">
            {worker.length} req · TB {ms(avg(worker))}
          </span>
        </span>
        <span>
          <span className="badge python">
            <span className="dot" />
            Python service
          </span>{" "}
          <span className="tnum muted">
            {python.length} req · TB {ms(avg(python))}
          </span>
        </span>
        <span className="spacer" />
        {entries.length > 0 && (
          <button className="ghost" onClick={() => feedStore.clear()}>
            Xoá lịch sử
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Chưa có request nào. Bấm &ldquo;Sinh log mẫu&rdquo; để bắt đầu.
        </p>
      ) : (
        <div className="feed">
          {entries.map((e) => (
            <div className="feed-row" key={e.id}>
              <div className="top">
                <span
                  className={`badge ${e.handledBy === "python-service" ? "python" : "worker"}`}
                >
                  <span className="dot" />
                  {e.handledBy === "python-service" ? "Python" : "Worker"}
                </span>
                <span className="ms">
                  {ms(e.durationMs)}
                  {e.status >= 400 && (
                    <span style={{ color: "var(--status-critical)" }}> · {e.status}</span>
                  )}
                </span>
              </div>
              <div className="path">
                {e.method} {e.path}
              </div>
              {e.note && <div className="note">{e.note}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
