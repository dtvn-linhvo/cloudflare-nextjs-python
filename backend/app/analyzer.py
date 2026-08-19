"""Tổng hợp + phát hiện bất thường bằng numpy.

Phần này là lý do dự án cần Python: vectorised bucketing, percentile, và
robust z-score (median/MAD) trên toàn bộ chuỗi thời gian. Làm việc tương
đương trong JS trên Workers sẽ vừa chậm vừa dễ vượt giới hạn CPU.
"""

from __future__ import annotations

import re
import time
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

from .parser import LEVELS, Record, parse_lines

# Chuẩn hoá message thành "template" để gom các lỗi cùng loại.
NORMALISERS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<UUID>"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "<IP>"),
    (re.compile(r"\b0x[0-9a-fA-F]+\b"), "<HEX>"),
    (re.compile(r"\"[^\"]*\""), "<STR>"),
    (re.compile(r"'[^']*'"), "<STR>"),
    (re.compile(r"\b\d+(?:\.\d+)?(?:ms|s|kb|mb|gb)?\b", re.IGNORECASE), "<N>"),
    (re.compile(r"\s+"), " "),
]

# Ngưỡng robust z-score. 3.5 là mức thường dùng cho median/MAD.
DEFAULT_Z_THRESHOLD = 3.5
HIGH_SEVERITY_Z = 6.0
MAD_TO_SIGMA = 1.4826


def _template(message: str) -> str:
    out = message
    for pattern, repl in NORMALISERS:
        out = pattern.sub(repl, out)
    return out.strip()[:200]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _robust_z(series: np.ndarray) -> np.ndarray:
    """Z-score dựa trên median/MAD — không bị chính spike kéo lệch như mean/std."""
    if series.size == 0:
        return series
    median = float(np.median(series))
    mad = float(np.median(np.abs(series - median)))
    if mad == 0.0:
        # Chuỗi gần như không đổi: rơi về std, và nếu std cũng 0 thì không có
        # bất thường nào để nói.
        std = float(series.std())
        if std == 0.0:
            return np.zeros_like(series)
        return (series - median) / std
    return (series - median) / (MAD_TO_SIGMA * mad)


def _percentiles(values: np.ndarray) -> dict[str, float] | None:
    if values.size == 0:
        return None
    p50, p95, p99 = np.percentile(values, [50, 95, 99])
    return {
        "p50_ms": round(float(p50), 1),
        "p95_ms": round(float(p95), 1),
        "p99_ms": round(float(p99), 1),
        "max_ms": round(float(values.max()), 1),
    }


def analyze(
    text: str,
    bucket_seconds: int = 60,
    z_threshold: float = DEFAULT_Z_THRESHOLD,
    max_timeline_points: int = 720,
) -> dict:
    started = time.perf_counter()

    lines = text.splitlines()
    records, unparsed, fmt, unparsed_samples = parse_lines(lines)

    if not records:
        return {
            "format": fmt,
            "lines_total": len(lines),
            "lines_parsed": 0,
            "lines_unparsed": unparsed,
            "unparsed_samples": unparsed_samples,
            "empty": True,
            "compute_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    # ---- Dồn vào mảng numpy một lần, sau đó chỉ làm việc trên vector ----
    ts = np.fromiter((r.ts for r in records), dtype=np.float64, count=len(records))
    level_idx = np.fromiter(
        (LEVELS.index(r.level) for r in records), dtype=np.int8, count=len(records)
    )
    latency = np.fromiter(
        (r.latency_ms for r in records), dtype=np.float64, count=len(records)
    )
    status = np.fromiter((r.status for r in records), dtype=np.int32, count=len(records))

    t_start, t_end = float(ts[0]), float(ts[-1])
    span = max(t_end - t_start, 1.0)

    # Nếu khoảng thời gian quá dài, nới bucket ra để timeline không quá nhiều điểm.
    if span / bucket_seconds > max_timeline_points:
        bucket_seconds = int(np.ceil(span / max_timeline_points / 10) * 10) or 60

    bucket_start = np.floor(t_start / bucket_seconds) * bucket_seconds
    bucket_of = ((ts - bucket_start) // bucket_seconds).astype(np.int64)
    n_buckets = int(bucket_of[-1]) + 1

    total_per_bucket = np.bincount(bucket_of, minlength=n_buckets)
    is_error = level_idx == LEVELS.index("ERROR")
    is_warn = level_idx == LEVELS.index("WARN")
    error_per_bucket = np.bincount(bucket_of[is_error], minlength=n_buckets)
    warn_per_bucket = np.bincount(bucket_of[is_warn], minlength=n_buckets)

    with np.errstate(divide="ignore", invalid="ignore"):
        error_rate = np.where(
            total_per_bucket > 0, error_per_bucket / total_per_bucket, 0.0
        )

    # p95 latency mỗi bucket (chỉ tính trên các dòng thật sự có latency).
    has_lat = latency >= 0
    p95_per_bucket = np.full(n_buckets, np.nan)
    if has_lat.any():
        lat_buckets = bucket_of[has_lat]
        lat_values = latency[has_lat]
        order = np.argsort(lat_buckets, kind="stable")
        lat_buckets, lat_values = lat_buckets[order], lat_values[order]
        edges = np.searchsorted(lat_buckets, np.arange(n_buckets + 1))
        for b in range(n_buckets):
            lo, hi = edges[b], edges[b + 1]
            if hi > lo:
                p95_per_bucket[b] = np.percentile(lat_values[lo:hi], 95)

    # ---- Phát hiện bất thường ----
    anomalies = _detect_anomalies(
        bucket_start=bucket_start,
        bucket_seconds=bucket_seconds,
        total=total_per_bucket,
        errors=error_per_bucket,
        error_rate=error_rate,
        p95=p95_per_bucket,
        z_threshold=z_threshold,
    )

    timeline = [
        {
            "t": _iso(bucket_start + b * bucket_seconds),
            "total": int(total_per_bucket[b]),
            "error": int(error_per_bucket[b]),
            "warn": int(warn_per_bucket[b]),
            "error_rate": round(float(error_rate[b]), 4),
            "p95_ms": None if np.isnan(p95_per_bucket[b]) else round(float(p95_per_bucket[b]), 1),
        }
        for b in range(n_buckets)
    ]

    return {
        "format": fmt,
        "lines_total": len(lines),
        "lines_parsed": len(records),
        "lines_unparsed": unparsed,
        "unparsed_samples": unparsed_samples,
        "bucket_seconds": bucket_seconds,
        "time_range": {
            "start": _iso(t_start),
            "end": _iso(t_end),
            "span_seconds": int(span),
        },
        "levels": {
            level: int((level_idx == i).sum()) for i, level in enumerate(LEVELS)
        },
        "totals": {
            "errors": int(is_error.sum()),
            "warns": int(is_warn.sum()),
            "error_rate": round(float(is_error.sum() / len(records)), 4),
            "lines_with_latency": int(has_lat.sum()),
        },
        "latency": _percentiles(latency[has_lat]),
        "timeline": timeline,
        "anomalies": anomalies,
        "top_errors": _top_error_templates(records, is_error),
        "top_sources": _top_sources(records, level_idx, latency),
        "status_codes": _status_breakdown(status),
        "compute_ms": round((time.perf_counter() - started) * 1000, 1),
    }


def _detect_anomalies(
    *,
    bucket_start: float,
    bucket_seconds: int,
    total: np.ndarray,
    errors: np.ndarray,
    error_rate: np.ndarray,
    p95: np.ndarray,
    z_threshold: float,
) -> list[dict]:
    out: list[dict] = []

    def add(series: np.ndarray, kind: str, label: str, fmt_value, min_abs: float, mask=None):
        valid = np.ones(series.shape, dtype=bool) if mask is None else mask
        clean = series[valid]
        if clean.size < 5:      # quá ít bucket thì thống kê không có nghĩa
            return
        z_clean = _robust_z(clean)
        z = np.zeros(series.shape)
        z[valid] = z_clean
        baseline = float(np.median(clean))
        for b in np.flatnonzero((z > z_threshold) & valid):
            value = float(series[b])
            if value - baseline < min_abs:
                continue
            out.append({
                "t": _iso(bucket_start + int(b) * bucket_seconds),
                "kind": kind,
                "score": round(float(z[b]), 2),
                "value": fmt_value(value),
                "baseline": fmt_value(baseline),
                "severity": "high" if z[b] >= HIGH_SEVERITY_Z else "medium",
                "detail": (
                    f"{label} = {fmt_value(value)} so với mức thường "
                    f"{fmt_value(baseline)} (robust z = {z[b]:.1f})"
                ),
            })

    add(error_rate * 100, "error_rate", "Tỉ lệ lỗi",
        lambda v: f"{v:.1f}%", min_abs=1.0)
    add(total.astype(np.float64), "volume", "Lưu lượng",
        lambda v: f"{v:.0f} dòng/bucket", min_abs=5.0)
    add(errors.astype(np.float64), "error_count", "Số lỗi",
        lambda v: f"{v:.0f} lỗi/bucket", min_abs=3.0)
    if not np.isnan(p95).all():
        add(np.nan_to_num(p95), "latency", "p95 latency",
            lambda v: f"{v:.0f}ms", min_abs=50.0, mask=~np.isnan(p95))

    out.sort(key=lambda a: (a["t"], -a["score"]))
    return out[:100]


def _top_error_templates(records: list[Record], is_error: np.ndarray, limit: int = 10) -> list[dict]:
    groups: dict[str, dict] = {}
    for rec, err in zip(records, is_error):
        if not err:
            continue
        key = _template(rec.message)
        g = groups.get(key)
        if g is None:
            groups[key] = {
                "template": key,
                "count": 1,
                "example": rec.message[:300],
                "source": rec.source,
                "first_seen": rec.ts,
                "last_seen": rec.ts,
            }
        else:
            g["count"] += 1
            g["last_seen"] = rec.ts

    top = sorted(groups.values(), key=lambda g: -g["count"])[:limit]
    for g in top:
        g["first_seen"] = _iso(g["first_seen"])
        g["last_seen"] = _iso(g["last_seen"])
    return top


def _top_sources(
    records: list[Record], level_idx: np.ndarray, latency: np.ndarray, limit: int = 10
) -> list[dict]:
    err_i = LEVELS.index("ERROR")
    agg: dict[str, dict] = defaultdict(lambda: {"total": 0, "errors": 0, "lat": []})
    for rec, lvl, lat in zip(records, level_idx, latency):
        a = agg[rec.source]
        a["total"] += 1
        if lvl == err_i:
            a["errors"] += 1
        if lat >= 0:
            a["lat"].append(lat)

    rows = []
    for source, a in agg.items():
        lat = np.asarray(a["lat"], dtype=np.float64)
        rows.append({
            "source": source,
            "total": a["total"],
            "errors": a["errors"],
            "error_rate": round(a["errors"] / a["total"], 4),
            "p95_ms": round(float(np.percentile(lat, 95)), 1) if lat.size else None,
        })
    rows.sort(key=lambda r: (-r["errors"], -r["total"]))
    return rows[:limit]


def _status_breakdown(status: np.ndarray) -> dict[str, int]:
    present = status[status > 0]
    if present.size == 0:
        return {}
    codes, counts = np.unique(present, return_counts=True)
    order = np.argsort(-counts)
    return {str(int(codes[i])): int(counts[i]) for i in order[:15]}
