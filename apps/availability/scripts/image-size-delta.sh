#!/usr/bin/env bash
# What carrying a browser actually costs, as a difference rather than a total.
#
# The first measurement said "final image size: 2259 MB", which is true and almost
# useless: a Next.js image with node_modules and a nix layer is most of that with no
# browser in it at all. The number worth knowing is the delta — this commit's image
# against the one production is running, both built the same way, from clean exports,
# with the same pinned builder.
#
# The first attempt at THIS failed and said the wrong thing about why. `git archive`
# could not resolve the baseline, because a workflow checkout is shallow and does not
# have that commit — but the script reported it as "no nixpacks.toml at badaf97", which
# would have sent somebody looking in entirely the wrong place. An error is only useful
# if it names what actually went wrong.

set -euo pipefail

# The full SHA, never the short one: a shallow clone cannot abbreviate a commit it does
# not have, and `git rev-parse badaf97` fails differently from `git fetch badaf97…`.
BASELINE_REF="${BASELINE_REF:-badaf97631026585a108e87dcbef9507223b6a1a}"
HEAD_REF="${HEAD_REF:-HEAD}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }
mb() { awk -v b="$1" 'BEGIN{printf "%.0f", b/1024/1024}'; }

case "$BASELINE_REF" in
  ????????????????????????????????????????) : ;;
  *) fail "BASELINE_REF must be a full 40-character SHA, not '$BASELINE_REF' — a shallow checkout cannot resolve an abbreviation" ;;
esac

say "making sure the baseline commit is actually here"
# A workflow checkout is depth 1. The commit production is running is almost certainly
# not in it, so fetch that one object rather than deepening the whole history.
if ! git -C "$REPO_ROOT" cat-file -e "${BASELINE_REF}^{commit}" 2>/dev/null; then
  echo "  not in the local checkout — fetching it"
  git -C "$REPO_ROOT" fetch --no-tags --depth 1 origin "$BASELINE_REF" 2>/dev/null \
    || git -C "$REPO_ROOT" fetch --no-tags origin "$BASELINE_REF" 2>/dev/null \
    || fail "could not fetch baseline commit $BASELINE_REF from origin"
fi
git -C "$REPO_ROOT" cat-file -e "${BASELINE_REF}^{commit}" 2>/dev/null \
  || fail "baseline commit $BASELINE_REF is still missing after fetching — it is not a commit on this remote"
echo "  $(git -C "$REPO_ROOT" log -1 --format='%h %s' "$BASELINE_REF")"

# Exported once each, and the reasons a build can fail are kept apart: a ref that is not
# there, a file that is not there, and a build that did not succeed are three different
# problems with three different fixes.
build_at() {
  local ref="$1" tag="$2" ctx
  ctx="$(mktemp -d)"
  git -C "$REPO_ROOT" archive "$ref" 2>/dev/null | tar -x -C "$ctx" \
    || { rm -rf "$ctx"; fail "could not export $ref — the commit resolves but `git archive` failed on it"; }
  if [ ! -f "$ctx/apps/availability/nixpacks.toml" ]; then
    # Said plainly, because it is a real possibility for a baseline that predates this
    # change — and it is NOT what a missing commit looks like.
    echo "  note: $ref has no nixpacks.toml; nixpacks will use its own defaults for it" >&2
  fi
  ( cd "$ctx/apps/availability" && nixpacks build . --name "$tag" --platform linux/amd64 >/tmp/nixpacks-$tag.log 2>&1 ) \
    || { tail -25 "/tmp/nixpacks-$tag.log" >&2; rm -rf "$ctx"; fail "building $ref failed — see the tail above"; }
  rm -rf "$ctx"
  docker image inspect "$tag" --format '{{.Size}}'
}

say "baseline: $(git -C "$REPO_ROOT" rev-parse --short "$BASELINE_REF") — what production is running"
BASE_BYTES="$(build_at "$BASELINE_REF" folkops-size-base)"
echo "  $(mb "$BASE_BYTES") MB"

say "this branch: $(git -C "$REPO_ROOT" rev-parse --short "$HEAD_REF")"
HEAD_BYTES="$(build_at "$HEAD_REF" folkops-size-head)"
echo "  $(mb "$HEAD_BYTES") MB"

DELTA=$(( HEAD_BYTES - BASE_BYTES ))
say "delta: $(mb "$DELTA") MB"
echo "  the browser, its shared libraries, the Thai fonts and tini, together."
echo
echo "baseline_mb=$(mb "$BASE_BYTES")"
echo "head_mb=$(mb "$HEAD_BYTES")"
echo "delta_mb=$(mb "$DELTA")"
