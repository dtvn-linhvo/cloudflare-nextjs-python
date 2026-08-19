#!/usr/bin/env python3
"""Sinh file log mẫu để thử demo: python scripts/generate_logs.py sample.log 200000"""
import random
import sys
from datetime import datetime, timedelta, timezone

SOURCES = ["api.orders", "api.users", "api.search", "worker.email", "gateway.http"]
MESSAGES = {
    "INFO": ["handled request path=/api/orders status=200 latency_ms={n}",
             "cache hit key=product:{n}",
             "published event topic=order.created id={n}"],
    "WARN": ["slow query took_ms={n} table=orders",
             "retrying upstream attempt=2 host=payments-api"],
    "ERROR": ["upstream timeout host=payments-api status=504 latency_ms={n}",
              "failed to charge card customer_id={n} status=502",
              "unhandled exception path=/api/orders status=500"],
}

out = sys.argv[1] if len(sys.argv) > 1 else "sample.log"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 200_000
rng = random.Random(7)
start = datetime(2026, 8, 19, 6, 0, tzinfo=timezone.utc)

with open(out, "w", encoding="utf-8") as f:
    for i in range(count):
        # Cửa sổ 20% giữa file là "sự cố": tỉ lệ lỗi cao hẳn lên.
        incident = 0.45 < i / count < 0.5
        r = rng.random()
        level = "ERROR" if r < (0.6 if incident else 0.02) else "WARN" if r < 0.08 else "INFO"
        ts = (start + timedelta(seconds=i * 14400 / count)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
        msg = rng.choice(MESSAGES[level]).format(n=rng.randint(10, 99999))
        f.write(f"{ts}Z {level:<5} {rng.choice(SOURCES)} {msg}\n")

print(f"Đã ghi {count:,} dòng vào {out} (có 1 cửa sổ sự cố ở giữa file)")
