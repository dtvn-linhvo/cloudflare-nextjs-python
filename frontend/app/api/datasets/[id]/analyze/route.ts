/**
 * NẶNG — nhưng Worker này không làm gì cả.
 *
 * Backend Python đọc log thô từ R2 theo stream, quét toàn bộ dòng, gom bucket,
 * rồi tự cache JSON vào R2 và cập nhật D1. Ở đây chỉ chuyển tiếp.
 */
import { proxy } from "@/lib/cf";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const started = performance.now();
  const { id } = await params;
  return proxy(`/datasets/${encodeURIComponent(id)}/analyze`, started, {
    method: "POST",
  });
}
