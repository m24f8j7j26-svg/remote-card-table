#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="/Users/randywebster/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

cd "$ROOT_DIR"
export PORT="${PORT:-4173}"
echo "$(date '+%Y-%m-%d %H:%M:%S') starting Remote Card Table relay on port $PORT"
exec "$NODE" "$ROOT_DIR/hosted-server.js"
