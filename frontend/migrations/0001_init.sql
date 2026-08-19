-- Metadata dataset. Log thô và JSON kết quả nằm ở R2, đây chỉ giữ phần
-- nhỏ để list/filter nhanh ngay trên Worker.
CREATE TABLE IF NOT EXISTS datasets (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  line_count    INTEGER,
  source        TEXT    NOT NULL DEFAULT 'upload',   -- 'upload' | 'generated'
  status        TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'analyzed' | 'failed'
  format        TEXT,
  error_count   INTEGER,
  anomaly_count INTEGER,
  compute_ms    REAL,
  analyzed_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_datasets_created ON datasets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_datasets_status  ON datasets (status);
