-- Metadata dataset. Log thô và JSON kết quả nằm ở R2; D1 chỉ giữ phần nhỏ để
-- list nhanh ngay trên Worker.
CREATE TABLE IF NOT EXISTS datasets (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',   -- pending | analyzed | failed
  line_count  INTEGER,
  error_rate  REAL,
  compute_ms  REAL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets (created_at DESC);
