#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-4173}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required. Install it with: brew install cloudflared" >&2
  exit 1
fi

if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Starting Remote Spades with automatic tunnel."
  /usr/bin/python3 "$ROOT_DIR/packaging/launcher.py" "$ROOT_DIR"
else
  echo "Using existing Remote Spades relay at http://127.0.0.1:$PORT"
fi
