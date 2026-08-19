/** NHẸ — đọc/xoá metadata. DELETE dọn cả 2 object R2. */
import { analysisKey, env, rawKey } from "@/lib/cf";
import { deleteDataset, getDataset } from "@/lib/db";
import { errorJson, jsonHandledByWorker } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();
  const dataset = await getDataset(e.DB, id);
  if (!dataset) return errorJson("Không tìm thấy dataset", 404);
  return jsonHandledByWorker({ dataset }, started);
}

export async function DELETE(_request: Request, { params }: Params) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();
  if (!(await getDataset(e.DB, id))) return errorJson("Không tìm thấy dataset", 404);

  await Promise.all([
    e.LOGS.delete(rawKey(id)),
    e.LOGS.delete(analysisKey(id)),
    deleteDataset(e.DB, id),
  ]);
  return jsonHandledByWorker({ deleted: id }, started);
}
