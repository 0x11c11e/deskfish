#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export PATH="$PWD/.tools/bin:$PATH"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 22.13 or newer and npm, then run npm ci inside site/.' >&2
  exit 1
fi
export npm_config_cache="$PWD/.cache"
export TMPDIR="$PWD/.tmp"
mkdir -p "$TMPDIR"
exec npm run dev
