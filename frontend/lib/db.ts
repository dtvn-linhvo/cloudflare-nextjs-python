import type { Dataset, DatasetStatus } from "./types";

export async function listDatasets(db: D1Database, limit = 50): Promise<Dataset[]> {
  const { results } = await db
    .prepare("SELECT * FROM datasets ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .bind(limit)
    .all<Dataset>();
  return results ?? [];
}

export async function getDataset(db: D1Database, id: string): Promise<Dataset | null> {
  return db.prepare("SELECT * FROM datasets WHERE id = ?").bind(id).first<Dataset>();
}

export async function insertDataset(
  db: D1Database,
  row: Pick<Dataset, "id" | "name" | "size_bytes" | "source"> & {
    line_count?: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO datasets (id, name, size_bytes, line_count, source, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(row.id, row.name, row.size_bytes, row.line_count ?? null, row.source)
    .run();
}

export async function markAnalyzed(
  db: D1Database,
  id: string,
  summary: {
    format: string;
    line_count: number;
    error_count: number;
    anomaly_count: number;
    compute_ms: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE datasets
          SET status = 'analyzed', format = ?, line_count = ?, error_count = ?,
              anomaly_count = ?, compute_ms = ?, analyzed_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(
      summary.format,
      summary.line_count,
      summary.error_count,
      summary.anomaly_count,
      summary.compute_ms,
      id,
    )
    .run();
}

export async function setStatus(
  db: D1Database,
  id: string,
  status: DatasetStatus,
): Promise<void> {
  await db.prepare("UPDATE datasets SET status = ? WHERE id = ?").bind(status, id).run();
}

export async function deleteDataset(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM datasets WHERE id = ?").bind(id).run();
}
