#!/usr/bin/env bash
#
# niteshift-setup.sh — bootstrap the Many web app inside a Niteshift sandbox.
#
# Niteshift runs this at the start of every task, before the agent gets control.
# Whatever HTTP port it binds is automatically given a preview URL of the form
# https://ns-<port>-<previewId>.preview.niteshift.dev (auth-gated, org-scoped).
#
# Steps: install deps -> build (libclaude -> renderer -> server/cli) -> serve.
# The web server is started in the background so this script can exit and hand
# control back to the agent while Many keeps running.

set -euo pipefail

# Resolve to the repo root (directory containing this script).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

# Port Many's web UI listens on. Niteshift exposes this as a preview URL.
PORT="${MANY_WEB_PORT:-3000}"
# Static token for the WebSocket RPC so the preview URL works without copying a
# freshly-generated token out of the logs each boot.
TOKEN="${MANY_WEB_TOKEN:-manyweb}"
LOG="${MANY_WEB_LOG:-/tmp/many-web.log}"

echo "[niteshift-setup] installing dependencies..."
npm install

echo "[niteshift-setup] building (libclaude + renderer + server/cli)..."
npm run build       # tsc --noEmit && vite build (builds libclaude via tsconfig refs)
npm run build:cli   # build:libclaude + tsc -p tsconfig.cli.json

# The SQLite store lives under the platform data dir; on Linux that's
# ~/.config/many, which may not exist on a fresh sandbox.
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/many"

echo "[niteshift-setup] starting Many web server on port ${PORT}..."
# Don't let a stale instance hold the port across a resume.
pkill -f "cli/index.js web" 2>/dev/null || true
sleep 1

nohup node dist-cli/cli/index.js web \
  --port "$PORT" --host 0.0.0.0 --no-open --token "$TOKEN" \
  > "$LOG" 2>&1 &
disown

# Give it a moment and confirm it came up.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "http://localhost:${PORT}/"; then
    echo "[niteshift-setup] Many is serving at http://localhost:${PORT}/?token=${TOKEN}"
    exit 0
  fi
  sleep 1
done

echo "[niteshift-setup] WARNING: server did not respond on port ${PORT}; see ${LOG}" >&2
tail -n 20 "$LOG" 2>/dev/null || true
exit 0
