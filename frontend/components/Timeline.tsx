"use client";

/**
 * Timeline: 3 small multiples dùng CHUNG trục x.
 *
 * Cố tình KHÔNG vẽ lưu lượng và tỉ lệ lỗi chung một khung: hai thang đo khác
 * nhau trên cùng một chart (dual-axis) là lỗi đọc hiểu kinh điển. Mỗi chart
 * một series, tiêu đề chart đặt tên cho series đó nên không cần legend.
 *
 * Vùng bất thường do Python phát hiện được tô nền đỏ nhạt xuyên qua cả 3 chart
 * để mắt bắt được sự trùng khớp theo thời gian.
 */

import { useMemo, useRef, useState } from "react";
import type { Anomaly, TimelinePoint } from "@/lib/types";
import { compact, fullTime, hhmm, niceTicks, num } from "@/lib/format";

const W = 960;                                   // toạ độ trong viewBox
const PAD = { left: 52, right: 14, top: 10, bottom: 4 };
const AXIS_BAND = 22;                            // chỗ cho nhãn trục x
const HEIGHTS = { volume: 132, error: 104, latency: 104 };

interface Props {
  timeline: TimelinePoint[];
  anomalies: Anomaly[];
  bucketSeconds: number;
}

type Series = {
  key: "volume" | "error" | "latency";
  title: string;
  unit: string;
  colorVar: string;
  kind: "bars" | "line";
  height: number;
  values: (number | null)[];
  format: (v: number) => string;
};

/** Path cho bar chỉ bo tròn đầu trên (đầu "dữ liệu"), chân neo vào baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  if (rr === 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
  return (
    `M${x} ${y + h}` +
    `V${y + rr}` +
    `a${rr} ${rr} 0 0 1 ${rr} ${-rr}` +
    `h${w - 2 * rr}` +
    `a${rr} ${rr} 0 0 1 ${rr} ${rr}` +
    `V${y + h}` +
    `Z`
  );
}

/** Gom các bucket bất thường liền nhau thành dải, để tô nền thành vùng. */
function anomalyBands(
  timeline: TimelinePoint[],
  anomalies: Anomaly[],
): { from: number; to: number; high: boolean }[] {
  if (anomalies.length === 0) return [];
  const indexOf = new Map(timeline.map((p, i) => [p.t, i]));
  const flagged = new Map<number, boolean>();
  for (const a of anomalies) {
    const i = indexOf.get(a.t);
    if (i === undefined) continue;
    flagged.set(i, (flagged.get(i) ?? false) || a.severity === "high");
  }
  const sorted = [...flagged.keys()].sort((a, b) => a - b);
  const bands: { from: number; to: number; high: boolean }[] = [];
  for (const i of sorted) {
    const last = bands[bands.length - 1];
    if (last && i === last.to + 1) {
      last.to = i;
      last.high = last.high || flagged.get(i)!;
    } else {
      bands.push({ from: i, to: i, high: flagged.get(i)! });
    }
  }
  return bands;
}

export default function Timeline({ timeline, anomalies, bucketSeconds }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasLatency = useMemo(
    () => timeline.some((p) => p.p95_ms !== null),
    [timeline],
  );

  const series: Series[] = useMemo(() => {
    const list: Series[] = [
      {
        key: "volume",
        title: "Lưu lượng",
        unit: `dòng / ${bucketSeconds}s`,
        colorVar: "var(--series-volume)",
        kind: "bars",
        height: HEIGHTS.volume,
        values: timeline.map((p) => p.total),
        format: (v) => `${num(Math.round(v))} dòng`,
      },
      {
        key: "error",
        title: "Tỉ lệ lỗi",
        unit: "% dòng ERROR",
        colorVar: "var(--series-error)",
        kind: "line",
        height: HEIGHTS.error,
        values: timeline.map((p) => p.error_rate * 100),
        format: (v) => `${v.toFixed(1)}%`,
      },
    ];
    if (hasLatency) {
      list.push({
        key: "latency",
        title: "p95 latency",
        unit: "ms",
        colorVar: "var(--series-latency)",
        kind: "line",
        height: HEIGHTS.latency,
        values: timeline.map((p) => p.p95_ms),
        format: (v) => `${Math.round(v)} ms`,
      });
    }
    return list;
  }, [timeline, bucketSeconds, hasLatency]);

  const bands = useMemo(() => anomalyBands(timeline, anomalies), [timeline, anomalies]);
  const n = timeline.length;
  const plotW = W - PAD.left - PAD.right;
  const slot = plotW / Math.max(1, n);

  const xTicks = useMemo(() => {
    const wanted = Math.min(8, Math.max(2, Math.floor(plotW / 110)));
    const stride = Math.max(1, Math.round(n / wanted));
    const out: number[] = [];
    for (let i = 0; i < n; i += stride) out.push(i);
    return out;
  }, [n, plotW]);

  function pointerIndex(event: React.PointerEvent<SVGSVGElement>): number | null {
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    const xInView = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((xInView - PAD.left) / slot);
    return i >= 0 && i < n ? i : null;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setHover((prev) => {
      const next = (prev ?? 0) + step;
      return Math.max(0, Math.min(n - 1, next));
    });
  }

  if (n === 0) return <p className="muted">Không có bucket nào để vẽ.</p>;

  const point = hover !== null ? timeline[hover] : null;
  // Tooltip đặt bên phải con trỏ, tự lật sang trái khi gần mép.
  const hoverFrac = hover !== null ? (PAD.left + (hover + 0.5) * slot) / W : 0;
  const flip = hoverFrac > 0.62;

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {num(n)} bucket × {bucketSeconds}s · trục thời gian UTC
        </span>
        <span className="spacer" />
        <button
          className="ghost"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
        >
          {asTable ? "Xem biểu đồ" : "Xem dạng bảng"}
        </button>
      </div>

      {asTable ? (
        <TimelineTable timeline={timeline} anomalies={anomalies} />
      ) : (
        <div
          className="chart-stack"
          ref={containerRef}
          tabIndex={0}
          role="group"
          aria-label="Biểu đồ chuỗi thời gian của log. Dùng mũi trái/phải để đọc từng bucket."
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          {series.map((s, idx) => (
            <Chart
              key={s.key}
              series={s}
              timeline={timeline}
              bands={bands}
              slot={slot}
              hover={hover}
              showXAxis={idx === series.length - 1}
              xTicks={xTicks}
              onHover={setHover}
              pointerIndex={pointerIndex}
            />
          ))}

          {point && (
            <div
              className="tooltip"
              style={{
                left: flip ? undefined : `calc(${hoverFrac * 100}% + 12px)`,
                right: flip ? `calc(${(1 - hoverFrac) * 100}% + 12px)` : undefined,
                top: 8,
              }}
            >
              <div className="t">{fullTime(point.t)}</div>
              <dl>
                <dt>Tổng dòng</dt>
                <dd>{num(point.total)}</dd>
                <dt>ERROR</dt>
                <dd>{num(point.error)}</dd>
                <dt>WARN</dt>
                <dd>{num(point.warn)}</dd>
                <dt>Tỉ lệ lỗi</dt>
                <dd>{(point.error_rate * 100).toFixed(1)}%</dd>
                {point.p95_ms !== null && (
                  <>
                    <dt>p95</dt>
                    <dd>{Math.round(point.p95_ms)} ms</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          <div className="chart-key">
            <span>
              <span
                className="swatch"
                style={{ background: "var(--band)", border: "1px solid var(--band-edge)" }}
              />
              Vùng Python đánh dấu bất thường
            </span>
            <span className="muted">
              Trỏ chuột (hoặc focus + mũi trái/phải) để đọc giá trị từng bucket
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function Chart({
  series,
  timeline,
  bands,
  slot,
  hover,
  showXAxis,
  xTicks,
  onHover,
  pointerIndex,
}: {
  series: Series;
  timeline: TimelinePoint[];
  bands: { from: number; to: number; high: boolean }[];
  slot: number;
  hover: number | null;
  showXAxis: boolean;
  xTicks: number[];
  onHover: (i: number | null) => void;
  pointerIndex: (e: React.PointerEvent<SVGSVGElement>) => number | null;
}) {
  const plotH = series.height;
  const svgH = plotH + PAD.top + PAD.bottom + (showXAxis ? AXIS_BAND : 0);
  const values = series.values;
  const max = Math.max(...values.map((v) => v ?? 0), 0);
  const ticks = niceTicks(max, 3);
  const scaleMax = ticks[ticks.length - 1] || 1;

  const y = (v: number) => PAD.top + plotH - (v / scaleMax) * plotH;
  const xCenter = (i: number) => PAD.left + (i + 0.5) * slot;

  // Nhãn trực tiếp cho đúng một điểm: giá trị lớn nhất. Không dán số lên mọi điểm.
  let maxIndex = 0;
  for (let i = 1; i < values.length; i += 1) {
    if ((values[i] ?? -1) > (values[maxIndex] ?? -1)) maxIndex = i;
  }

  const linePath = useMemo(() => {
    if (series.kind !== "line") return "";
    let d = "";
    let open = false;
    values.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${xCenter(i).toFixed(2)} ${y(v).toFixed(2)}`;
      open = true;
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, series.kind, slot, scaleMax, plotH]);

  const barW = Math.max(0.8, slot - Math.min(2, slot * 0.3));

  return (
    <div className="chart-block">
      <div className="chart-head">
        <span className="chart-title">
          <span
            className="swatch"
            style={{
              background: series.colorVar,
              display: "inline-block",
              width: 22,
              height: series.kind === "bars" ? 8 : 3,
              borderRadius: 3,
            }}
          />
          {series.title}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({series.unit})
          </span>
        </span>
        <span className="chart-max">cao nhất {series.format(max)}</span>
      </div>

      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${svgH}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${series.title} theo thời gian, cao nhất ${series.format(max)}`}
        onPointerMove={(e) => onHover(pointerIndex(e))}
        onPointerLeave={() => onHover(null)}
      >
        {/* vùng bất thường — vẽ trước để nằm dưới dữ liệu */}
        {bands.map((b, i) => (
          <rect
            key={i}
            x={PAD.left + b.from * slot}
            y={PAD.top}
            width={Math.max(slot, (b.to - b.from + 1) * slot)}
            height={plotH}
            fill="var(--band)"
            stroke="var(--band-edge)"
            strokeWidth={b.high ? 1 : 0}
          />
        ))}

        {/* lưới + nhãn trục y, hairline liền, không dashed */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--axis)" : "var(--grid)"}
              strokeWidth="1"
              shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 8}
              y={y(t) + 3.5}
              textAnchor="end"
              fontSize="10.5"
              fill="var(--ink-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {series.key === "error" ? `${t}%` : compact(t)}
            </text>
          </g>
        ))}

        {/* dữ liệu */}
        {series.kind === "bars"
          ? values.map((v, i) => {
              const h = ((v ?? 0) / scaleMax) * plotH;
              if (h <= 0) return null;
              return (
                <path
                  key={i}
                  d={topRoundedBar(
                    xCenter(i) - barW / 2,
                    PAD.top + plotH - h,
                    barW,
                    h,
                    Math.min(4, barW / 2),
                  )}
                  fill={series.colorVar}
                  opacity={hover === null || hover === i ? 1 : 0.62}
                />
              );
            })
          : (
            <path
              d={linePath}
              fill="none"
              stroke={series.colorVar}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

        {/* marker trên đỉnh, có vòng nền 2px để không lẫn vào dải bất thường */}
        {(() => {
          const v = values[maxIndex];
          if (v === null || v === undefined || max <= 0) return null;
          return (
            <g>
              <circle
                cx={xCenter(maxIndex)}
                cy={y(v)}
                r="5"
                fill={series.colorVar}
                stroke="var(--surface)"
                strokeWidth="2"
              />
              <text
                x={Math.min(
                  W - PAD.right - 2,
                  Math.max(PAD.left + 30, xCenter(maxIndex) + 10),
                )}
                y={Math.max(PAD.top + 10, y(v) - 8)}
                textAnchor={xCenter(maxIndex) > W * 0.75 ? "end" : "start"}
                fontSize="11"
                fill="var(--ink-2)"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {series.format(v)}
              </text>
            </g>
          );
        })()}

        {/* crosshair dùng chung cho cả 3 chart */}
        {hover !== null && (
          <g>
            <line
              x1={xCenter(hover)}
              x2={xCenter(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--ink-2)"
              strokeWidth="1"
            />
            {values[hover] !== null && values[hover] !== undefined && (
              <circle
                cx={xCenter(hover)}
                cy={y(values[hover]!)}
                r="4.5"
                fill={series.colorVar}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            )}
          </g>
        )}

        {/* trục x chỉ vẽ ở chart cuối — cả 3 chart dùng chung thang thời gian */}
        {showXAxis &&
          xTicks.map((i) => (
            <text
              key={i}
              x={xCenter(i)}
              y={PAD.top + plotH + 15}
              textAnchor="middle"
              fontSize="10.5"
              fill="var(--ink-muted)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {hhmm(timeline[i].t)}
            </text>
          ))}
      </svg>
    </div>
  );
}

function TimelineTable({
  timeline,
  anomalies,
}: {
  timeline: TimelinePoint[];
  anomalies: Anomaly[];
}) {
  const flagged = useMemo(() => new Set(anomalies.map((a) => a.t)), [anomalies]);
  return (
    <div className="scroll-y scroll-x">
      <table>
        <thead>
          <tr>
            <th>Thời điểm (UTC)</th>
            <th className="num">Tổng</th>
            <th className="num">ERROR</th>
            <th className="num">WARN</th>
            <th className="num">Tỉ lệ lỗi</th>
            <th className="num">p95 (ms)</th>
            <th>Bất thường</th>
          </tr>
        </thead>
        <tbody>
          {timeline.map((p) => (
            <tr key={p.t}>
              <td className="mono">{fullTime(p.t)}</td>
              <td className="num">{num(p.total)}</td>
              <td className="num">{num(p.error)}</td>
              <td className="num">{num(p.warn)}</td>
              <td className="num">{(p.error_rate * 100).toFixed(1)}%</td>
              <td className="num">{p.p95_ms === null ? "—" : Math.round(p.p95_ms)}</td>
              <td>{flagged.has(p.t) ? "có" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
