#!/usr/bin/env python3
"""Sinh file log mẫu ra đĩa: python scripts/generate_logs.py sample.log 200000"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.generator import generate  # noqa: E402

out = Path(sys.argv[1] if len(sys.argv) > 1 else "sample.log")
lines = int(sys.argv[2]) if len(sys.argv) > 2 else 200_000

text, meta = generate(lines=lines)
out.write_text(text, encoding="utf-8")
print(f"Đã ghi {meta['lines']:,} dòng ({meta['bytes'] / 1e6:.1f} MB) vào {out}")
print(f"Thời gian sinh: {meta['generate_ms']} ms")
for inc in meta["injected_incidents"]:
    print(f"  sự cố cài sẵn: {inc['kind']:<14} {inc['start']} → {inc['end']}")
