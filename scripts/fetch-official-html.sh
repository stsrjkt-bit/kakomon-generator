#!/usr/bin/env bash
set -euo pipefail

# Fetch an official (expected-HTML) page robustly.
# - Always request decompression (--compressed) so we don't end up with gzipped bytes on disk.
# - Fail fast if the downloaded content doesn't look like HTML.
#
# Usage:
#   scripts/fetch-official-html.sh "https://example.edu/page" "tmp/page.html"

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <url> <out.html>" >&2
  exit 2
fi

url="$1"
out="$2"

tmp="$(mktemp)"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

curl -sS -L --fail --compressed \
  -A "Mozilla/5.0" \
  --max-redirs 5 \
  --proto "=https,http" \
  --proto-redir "=https,http" \
  -o "$tmp" -- "$url"

mime="$(file -b --mime-type "$tmp" || true)"
case "$mime" in
  text/*|application/xhtml+xml) ;;
  *)
    echo "ERROR: downloaded content is not text/html-ish (mime=$mime)" >&2
    echo "  url=$url" >&2
    file "$tmp" >&2 || true
    head -c 32 "$tmp" | xxd >&2 || true
    exit 2
    ;;
esac

# Minimal "looks like HTML" check (avoid silently accepting JSON/binary)
if ! rg -n -m 1 -i "<!doctype html|<html|<head|<body" "$tmp" >/dev/null; then
  echo "ERROR: downloaded file does not look like HTML" >&2
  echo "  url=$url" >&2
  head -n 20 "$tmp" >&2 || true
  exit 2
fi

mkdir -p "$(dirname "$out")"
mv -f "$tmp" "$out"
trap - EXIT

bytes="$(wc -c < "$out" | tr -d ' ')"
echo "OK: $out (${bytes} bytes)"

