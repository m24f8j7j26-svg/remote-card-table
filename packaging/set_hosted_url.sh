#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: packaging/set_hosted_url.sh https://your-hosted-card-table.example.com" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Remote Spades.app"
URL="$1"

if [[ ! "$URL" =~ ^https?:// ]]; then
  echo "Hosted URL must start with http:// or https://" >&2
  exit 1
fi

mkdir -p "$APP_DIR/Contents/Resources"
printf '%s\n' "$URL" > "$APP_DIR/Contents/Resources/hosted_url.txt"
codesign --force --deep --sign - "$APP_DIR" >/dev/null
echo "Remote Spades.app will open: $URL"
