/** NHẸ — xoá dataset: 2 object R2 + 1 row D1. */
import { analysisKey, env, json, rawKey } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  const e = await env();

  await Promise.all([
    e.LOGS.delete(rawKey(id)),
    e.LOGS.delete(analysisKey(id)),
    e.DB.prepare("DELETE FROM datasets WHERE id = ?").bind(id).run(),
  ]);

  return json({ deleted: id }, started);
}
