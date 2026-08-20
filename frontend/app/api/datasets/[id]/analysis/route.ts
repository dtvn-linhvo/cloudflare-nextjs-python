/** Proxy sang backend: đọc JSON kết quả đã cache trong R2, không phân tích lại. */
import { proxy } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  return proxy(`/datasets/${encodeURIComponent(id)}/analysis`, started);
}
