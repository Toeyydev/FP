#!/usr/bin/env bash
# Build the image the way Railway builds it, start it, and ask it to render.
#
# Every other check in this repository runs against a checkout: the source tree, the
# node_modules the runner installed, a browser downloaded into the working directory.
# None of that is what ships. The image is what ships, and the failure this whole change
# exists to fix was an image that had no browser in it while everything around it looked
# green.
#
# So this builds an OCI image with the project's own nixpacks config, runs a container
# from it with nothing mounted from the host, blanks every browser override so nothing
# outside the image can stand in, and then makes the running app render a page.
#
# It is deliberately end-to-end. `.browser-cache` surviving into the final image, the
# binary being the pinned build, the shared libraries being present, a font that can draw
# Thai existing — none of those are asserted separately. They are all implied by a PDF
# coming back out.

set -euo pipefail

IMAGE="${IMAGE:-folkops-smoke:ci}"
PORT="${PORT:-8080}"
NAME="folkops-smoke-$$"
EXPECTED_BUILD_ID="${EXPECTED_BUILD_ID:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() {
  docker logs "$NAME" > /tmp/smoke-container.log 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

# The build id the code expects, read from the package rather than typed here.
if [ -z "$EXPECTED_BUILD_ID" ]; then
  EXPECTED_BUILD_ID=$(node -e 'import("puppeteer-core/internal/revisions.js").then(m=>console.log(m.PUPPETEER_REVISIONS["chrome-headless-shell"]))' 2>/dev/null)
fi
[ -n "$EXPECTED_BUILD_ID" ] || fail "could not read the pinned browser build id"
say "pinned build id: $EXPECTED_BUILD_ID"

say "building the image with the project's nixpacks config"
cd "$APP_DIR"
nixpacks build . --name "$IMAGE" --platform linux/amd64 2>&1 | tail -20

SIZE_BYTES=$(docker image inspect "$IMAGE" --format '{{.Size}}')
say "final image size: $(awk -v b="$SIZE_BYTES" 'BEGIN{printf "%.0f MB", b/1024/1024}')"

say "the browser is inside the image, at the pinned build"
INSIDE=$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls -1 /app/.browser-cache/chrome-headless-shell 2>/dev/null || echo NONE')
echo "  .browser-cache/chrome-headless-shell → $INSIDE"
case "$INSIDE" in
  NONE) fail ".browser-cache did not survive into the final image" ;;
  *"linux-$EXPECTED_BUILD_ID"*) : ;;
  *) fail "the image carries '$INSIDE', not linux-$EXPECTED_BUILD_ID" ;;
esac
docker run --rm --entrypoint sh "$IMAGE" -c \
  "test -x /app/.browser-cache/chrome-headless-shell/linux-$EXPECTED_BUILD_ID/chrome-headless-shell-linux64/chrome-headless-shell" \
  || fail "the browser in the image is not executable"

say "starting a container — nothing mounted from the host"
# No -v anywhere on purpose: the source tree, the runner's node_modules and any browser
# on the host are all invisible to it. The three override variables are blanked so the
# only browser it can possibly use is the one the build put inside it.
docker run -d --name "$NAME" --network host \
  -e "DATABASE_URL=${DATABASE_URL:?DATABASE_URL is required}" \
  -e "AUTH_SECRET=smoke-only-not-a-real-secret" \
  -e "SKIP_ENV_VALIDATION=1" \
  -e "PORT=$PORT" \
  -e "CHROME_HEADLESS_SHELL_PATH=" -e "PUPPETEER_EXECUTABLE_PATH=" -e "CHROMIUM_PATH=" \
  "$IMAGE" >/dev/null

say "waiting for it to answer"
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { docker logs "$NAME" | tail -30; fail "the container never answered"; }
  sleep 2
done

say "asking the running app to render"
# The first health call starts the probe; the answer appears on a later one. What it
# reports is the result of an actual render inside this container.
STATUS=""; CODE=""; MS=""
for i in $(seq 1 30); do
  BODY=$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health")
  STATUS=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).certificateRenderer?.status??"")}catch{console.log("")}})')
  CODE=$(printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).certificateRenderer?.code??"")}catch{console.log("")}})')
  [ "$STATUS" = "ready" ] && break
  [ "$STATUS" = "misconfigured" ] || [ "$STATUS" = "unavailable" ] && break
  sleep 2
done
echo "  certificateRenderer: status=$STATUS code=$CODE"
[ "$STATUS" = "ready" ] || { docker logs "$NAME" | tail -40; fail "the renderer in the image reported '$STATUS' ($CODE)"; }

say "rendering Thai inside the container, and looking at the bytes"
# Independent of the app's own probe: this uses the image's puppeteer-core and the
# image's browser directly, so a PDF coming back proves the shared libraries and a
# Thai-capable font are both really in there.
docker exec "$NAME" node -e '
const { execPath } = process;
(async () => {
  const p = (await import("puppeteer-core")).default;
  const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
  const buildId = PUPPETEER_REVISIONS["chrome-headless-shell"];
  const exe = `/app/.browser-cache/chrome-headless-shell/linux-${buildId}/chrome-headless-shell-linux64/chrome-headless-shell`;
  const b = await p.launch({ executablePath: exe, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  try {
    const page = await b.newPage();
    await page.setContent(`<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
      <body style="font-size:20pt"><p>ใบรับรองแทนใบเสร็จรับเงิน</p><p>ค่าเรือข้ามฟาก</p></body></html>`, { waitUntil: "load" });
    const pdf = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
    const head = pdf.subarray(0,5).toString("latin1");
    const tail = pdf.subarray(-1024).toString("latin1");
    const fonts = [...pdf.toString("latin1").matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g)].map(m=>m[1]);
    if (head !== "%PDF-") throw new Error("not a pdf: " + head);
    if (!tail.includes("%%EOF")) throw new Error("truncated pdf");
    if (!fonts.length) throw new Error("no font embedded — Thai would be drawn as boxes");
    if (pdf.length < 8000) throw new Error("suspiciously small for an embedded Thai face: " + pdf.length);
    console.log(`  thai pdf: ${pdf.length} bytes, fonts embedded: ${fonts.length}, build ${buildId}`);
  } finally { await b.close(); }
})().catch((e) => { console.error("  " + String(e)); process.exit(1); });
' || fail "rendering Thai inside the image failed"

say "peak memory, as the container itself measured it"
PEAK=$(docker exec "$NAME" sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo ""' || echo "")
if [ -n "$PEAK" ]; then
  awk -v b="$PEAK" 'BEGIN{printf "  peak memory: %.0f MB\n", b/1024/1024}'
else
  echo "  peak memory: not exposed by this cgroup"
fi

say "no browser left running"
LEFT=$(docker exec "$NAME" sh -c 'ps -eo comm 2>/dev/null | grep -ci "chrome\|headless_shell" || true')
echo "  browser processes in the container: ${LEFT:-0}"
[ "${LEFT:-0}" -eq 0 ] || fail "$LEFT browser process(es) left running inside the image"

say "image smoke passed"
printf 'image_size_mb=%.0f\n' "$(awk -v b="$SIZE_BYTES" 'BEGIN{print b/1024/1024}')"
printf 'build_id=%s\n' "$EXPECTED_BUILD_ID"
