/** Proxy sang backend: xoá 2 object R2 + 1 row D1. */
import { proxy } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  return proxy(`/datasets/${encodeURIComponent(id)}`, started, { method: "DELETE" });
}
