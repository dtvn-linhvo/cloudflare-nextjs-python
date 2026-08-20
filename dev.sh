#!/usr/bin/env bash
# Chạy LogLens ở local: analyzer Python Worker (:8000) + Next.js (:3000).
#
# Local dev KHÔNG cần Docker và không cần tài khoản Cloudflare:
#   - R2 và D1 được miniflare giả lập trên đĩa (.wrangler/state)
#   - analyzer chạy trên workerd thật qua pywrangler, giống production
# Cần: node + uv (https://astral.sh/uv). Ctrl+C để dừng cả hai.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "Thiếu uv — pywrangler cần nó để vendor package Python."
  echo "Cài: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

# Toolchain Pyodide còn chạy node với --experimental-wasm-stack-switching, flag
# này đã bị bỏ từ Node 23. Node mới hơn thì `uv venv --python pyodide-...` fail.
if [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 23 ]; then
  echo "Node $(node -v) quá mới cho toolchain Pyodide (cần <= 22 LTS)."
  echo "Ví dụ: nvm install 22 && nvm use 22, rồi chạy lại ./dev.sh"
  exit 1
fi

echo "==> [1/4] Backend Python Worker"
(cd backend && uv sync --quiet)

echo "==> [2/4] Frontend Next.js"
[ -d frontend/node_modules ] || (cd frontend && npm install)

echo "==> [3/4] Bindings Cloudflare (local)"
(cd frontend && npx wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts > /dev/null)
# D1 thuộc backend, nên migration chạy ở đó (state nằm trong backend/.wrangler).
(cd backend && CI=1 npx wrangler d1 migrations apply loglens-db --local > /dev/null)

echo "==> [4/4] Khởi động"
trap 'kill 0' EXIT INT TERM

# Cổng lấy từ backend/wrangler.jsonc ("dev": { "port": 8000 }).
echo "    analyzer : http://localhost:8000  (/health)"
(cd backend && uv run pywrangler dev) &

echo "    app      : http://localhost:3000"
(cd frontend && npm run dev) &

wait
