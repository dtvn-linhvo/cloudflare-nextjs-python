#!/usr/bin/env bash
# Chạy LogLens ở local: analyzer Python (:8000) + Next.js (:3000).
#
# Local dev KHÔNG cần Docker và không cần tài khoản Cloudflare:
#   - R2 và D1 được miniflare giả lập trên đĩa (.wrangler/state)
#   - analyzer là service Python thường, chạy bằng uvicorn
# Ctrl+C để dừng cả hai.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> [1/4] Backend Python"
if [ ! -d backend/.venv ]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi

echo "==> [2/4] Frontend Next.js"
[ -d frontend/node_modules ] || (cd frontend && npm install)

echo "==> [3/4] Bindings Cloudflare (local)"
(cd frontend && npx wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts > /dev/null)
(cd frontend && CI=1 npx wrangler d1 migrations apply loglens-db --local > /dev/null)

echo "==> [4/4] Khởi động"
trap 'kill 0' EXIT INT TERM

echo "    analyzer : http://localhost:8000  (docs: /docs)"
(cd backend && .venv/bin/python -m uvicorn app.main:app --reload --reload-dir app --port 8000) &

echo "    app      : http://localhost:3000"
(cd frontend && npm run dev) &

wait
