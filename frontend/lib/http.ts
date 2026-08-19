/** Helper trả JSON kèm thông tin "ai xử lý request này" cho UI minh hoạ. */
export function jsonHandledByWorker(
  data: unknown,
  startedAt: number,
  init?: ResponseInit & { note?: string },
): Response {
  const duration = Math.round((performance.now() - startedAt) * 10) / 10;
  const body = {
    ...(data as Record<string, unknown>),
    _handler: {
      handled_by: "nextjs-worker",
      duration_ms: duration,
      ...(init?.note ? { note: init.note } : {}),
    },
  };
  return Response.json(body, {
    status: init?.status ?? 200,
    headers: {
      "X-Handled-By": "nextjs-worker",
      "X-Duration-Ms": String(duration),
      "Cache-Control": "no-store",
      ...(init?.headers as Record<string, string>),
    },
  });
}

export function errorJson(message: string, status = 400): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "X-Handled-By": "nextjs-worker", "Cache-Control": "no-store" },
  });
}
