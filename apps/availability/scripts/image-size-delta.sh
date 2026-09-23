#!/usr/bin/env bash
# What carrying a browser actually costs, as a difference rather than a total.
#
# The first measurement of this said "final image size: 2259 MB", which is true and
# almost useless: a Next.js image with node_modules and a nix layer is most of that with
# no browser in it at all. The number worth knowing is the delta — this commit's image
# against the one already running in production, both built the same way from clean
# exports with the same builder.

set -euo pipefail

BASELINE_REF="${BASELINE_REF:-badaf97}"
HEAD_REF="${HEAD_REF:-HEAD}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
mb() { awk -v b="$1" 'BEGIN{printf "%.0f", b/1024/1024}'; }

build_at() {
  local ref="$1" tag="$2" ctx
  ctx="$(mktemp -d)"
  git -C "$REPO_ROOT" archive "$ref" | tar -x -C "$ctx"
  [ -f "$ctx/apps/availability/nixpacks.toml" ] || echo "  (no nixpacks.toml at $ref — the browser predates this change)" >&2
  ( cd "$ctx/apps/availability" && nixpacks build . --name "$tag" --platform linux/amd64 >/dev/null 2>&1 ) \
    || { echo "  build failed at $ref" >&2; rm -rf "$ctx"; return 1; }
  rm -rf "$ctx"
  docker image inspect "$tag" --format '{{.Size}}'
}

say "baseline: $BASELINE_REF (what production is running)"
BASE_BYTES="$(build_at "$BASELINE_REF" folkops-size-base:ci)" || { echo "baseline build failed"; exit 1; }
echo "  $(mb "$BASE_BYTES") MB"

say "this branch: $(git rev-parse --short "$HEAD_REF")"
HEAD_BYTES="$(build_at "$HEAD_REF" folkops-size-head:ci)" || { echo "head build failed"; exit 1; }
echo "  $(mb "$HEAD_BYTES") MB"

DELTA=$(( HEAD_BYTES - BASE_BYTES ))
say "delta: $(mb "$DELTA") MB"
echo "  that is what the browser, its shared libraries and the Thai fonts cost."
echo "  baseline_mb=$(mb "$BASE_BYTES")"
echo "  head_mb=$(mb "$HEAD_BYTES")"
echo "  delta_mb=$(mb "$DELTA")"
