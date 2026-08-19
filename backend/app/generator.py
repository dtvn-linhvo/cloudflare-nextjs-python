"""Sinh log mẫu có cài sẵn sự cố, để demo có dữ liệu thật mà không cần file ngoài.

Cũng là một tác vụ nặng (sinh vài trăm nghìn dòng) nên đặt ở phía Python.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

import numpy as np

SERVICES = [
    "api.orders", "api.payments", "api.users", "api.search",
    "worker.email", "worker.export", "gateway.http", "db.pool",
]

INFO_MESSAGES = [
    "handled request path=/api/orders status=200 latency_ms={lat}",
    "handled request path=/api/users/{uid} status=200 latency_ms={lat}",
    "handled request path=/api/search?q=laptop status=200 latency_ms={lat}",
    "cache hit key=product:{uid} latency_ms={lat}",
    "published event topic=order.created id={uid}",
    "job finished name=nightly-export duration_ms={lat}",
]

WARN_MESSAGES = [
    "slow query took_ms={lat} table=orders",
    "retrying upstream attempt=2 host=payments-api latency_ms={lat}",
    "connection pool near capacity in_use={uid} max=50",
    "deprecated endpoint called path=/v1/orders status=200 latency_ms={lat}",
]

ERROR_MESSAGES = [
    "upstream timeout host=payments-api status=504 latency_ms={lat}",
    "failed to charge card customer_id={uid} status=502 latency_ms={lat}",
    "unhandled exception in handler path=/api/orders status=500 latency_ms={lat}",
    "database connection refused host=10.0.{uid_mod}.12 status=500 latency_ms={lat}",
    "invalid token for user_id={uid} status=401 latency_ms={lat}",
]

# Các sự cố được cài vào log: (offset phút, số phút kéo dài, loại)
INCIDENTS = [
    (0.22, 0.04, "error_burst"),   # 22% thời lượng, kéo dài 4% -> lỗi bùng nổ
    (0.55, 0.03, "traffic_spike"), # tăng vọt lưu lượng
    (0.78, 0.05, "latency_spike"), # p95 tăng mạnh
]


def generate(lines: int = 120_000, seed: int = 7, minutes: int = 240) -> tuple[str, dict]:
    started = time.perf_counter()
    rng = np.random.default_rng(seed)
    lines = max(500, min(lines, 2_000_000))

    start = datetime(2026, 8, 19, 6, 0, 0, tzinfo=timezone.utc)
    total_seconds = minutes * 60

    # Lưu lượng nền theo hình sin (giả lập chu kỳ ngày) + nhiễu.
    base = rng.random(lines) ** 0.8
    offsets = np.sort(base * total_seconds)

    # Đánh dấu dòng nào rơi vào cửa sổ sự cố nào.
    incident_kind = np.zeros(lines, dtype=np.int8)   # 0 = bình thường
    windows = []
    for i, (at, dur, kind) in enumerate(INCIDENTS, start=1):
        lo, hi = at * total_seconds, (at + dur) * total_seconds
        mask = (offsets >= lo) & (offsets < hi)
        incident_kind[mask] = i
        windows.append({
            "kind": kind,
            "start": (start + timedelta(seconds=lo)).isoformat().replace("+00:00", "Z"),
            "end": (start + timedelta(seconds=hi)).isoformat().replace("+00:00", "Z"),
        })

    # Cửa sổ traffic_spike: nhân bản thêm dòng để lưu lượng thật sự tăng vọt.
    spike_idx = np.flatnonzero(incident_kind == 2)
    if spike_idx.size:
        extra = rng.choice(spike_idx, size=spike_idx.size * 4, replace=True)
        offsets = np.concatenate([offsets, offsets[extra]])
        incident_kind = np.concatenate([incident_kind, incident_kind[extra]])
        order = np.argsort(offsets, kind="stable")
        offsets, incident_kind = offsets[order], incident_kind[order]

    n = offsets.size
    roll = rng.random(n)
    latency = rng.lognormal(mean=3.6, sigma=0.7, size=n)     # ~36ms median
    uid = rng.integers(1000, 99999, size=n)
    svc = rng.integers(0, len(SERVICES), size=n)
    pick = rng.integers(0, 10_000, size=n)

    out: list[str] = []
    append = out.append
    for i in range(n):
        kind = incident_kind[i]
        lat = latency[i]
        r = roll[i]

        if kind == 1:                      # error_burst: 65% dòng là ERROR
            level = "ERROR" if r < 0.65 else ("WARN" if r < 0.8 else "INFO")
        elif kind == 3:                    # latency_spike: chậm hẳn, lỗi nhẹ
            lat *= 22.0
            level = "ERROR" if r < 0.08 else ("WARN" if r < 0.45 else "INFO")
        else:                              # nền: ~1.2% lỗi, ~6% cảnh báo
            level = "ERROR" if r < 0.012 else ("WARN" if r < 0.072 else "INFO")

        if level == "ERROR":
            pool = ERROR_MESSAGES
        elif level == "WARN":
            pool = WARN_MESSAGES
        else:
            pool = INFO_MESSAGES
        template = pool[pick[i] % len(pool)]

        ts = (start + timedelta(seconds=float(offsets[i]))).strftime("%Y-%m-%dT%H:%M:%S.") \
            + f"{int(offsets[i] * 1000) % 1000:03d}Z"
        message = template.format(lat=int(lat), uid=int(uid[i]), uid_mod=int(uid[i]) % 8)
        append(f"{ts} {level:<5} {SERVICES[svc[i]]} {message}")

    # Vài dòng rác để chứng minh phần đếm "không parse được" hoạt động.
    for pos in rng.integers(0, n, size=max(3, n // 20_000)):
        out[int(pos)] = "  at com.example.Handler.process(Handler.java:88)"

    text = "\n".join(out) + "\n"
    return text, {
        "lines": n,
        "bytes": len(text.encode()),
        "seed": seed,
        "minutes": minutes,
        "injected_incidents": windows,
        "generate_ms": round((time.perf_counter() - started) * 1000, 1),
    }
