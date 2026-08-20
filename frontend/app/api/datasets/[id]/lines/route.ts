/**
 * Proxy sang backend: xem log thô mà KHÔNG tải cả file.
 *
 * Backend dùng R2 range read — mỗi lần một cửa sổ 64 KB tại byte offset yêu
 * cầu, nên file 17 MB hay 17 GB thì thời gian như nhau.
 */
import { proxy } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  const offset = Math.max(
    0,
    Number(new URL(request.url).searchParams.get("offset") ?? 0) || 0,
  );
  return proxy(`/datasets/${encodeURIComponent(id)}/lines?offset=${offset}`, started);
}
