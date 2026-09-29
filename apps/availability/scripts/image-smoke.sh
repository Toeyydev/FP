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

say "exporting a clean copy of this commit to build from"
# NOT the working directory. By the time this step runs, the runner's checkout holds
# things Railway's build context never has: a `tsconfig.tsbuildinfo` the typecheck steps
# left behind, a `.next` from an earlier build, node_modules, and — worst of all — the
# `.browser-cache` that an earlier step installed.
#
# The tsbuildinfo is what made the first two attempts fail: nixpacks emits a BuildKit
# cache mount at that path, and a bind of a directory onto an existing FILE is refused.
# But the browser cache is the dangerous one. Had the build succeeded, `COPY . /app`
# would have carried the runner's browser into the image, and this test would have
# passed while proving nothing about whether the image builds its own.
#
# `git archive` gives exactly what a fresh checkout gives, which is what Railway builds.
REPO_ROOT="$(git -C "$APP_DIR" rev-parse --show-toplevel)"
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"; cleanup' EXIT
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$CTX"
BUILD_DIR="$CTX/apps/availability"
[ -f "$BUILD_DIR/nixpacks.toml" ] || fail "the exported copy has no nixpacks.toml"

for leftover in .browser-cache .next node_modules tsconfig.tsbuildinfo dist; do
  [ -e "$BUILD_DIR/$leftover" ] && fail "the build context carries '$leftover' from the runner — the image must build its own"
done
echo "  context is a clean export of $(git -C "$REPO_ROOT" rev-parse --short HEAD); no runner artefacts in it"

say "building the image with the project's nixpacks config"
cd "$BUILD_DIR"
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

# Whatever Chrome the RUNNER already has is not this test's business — the renderer
# suite ran one a few steps ago, and other tooling may keep one around. What matters is
# that nothing the CONTAINER started is still here afterwards, so the question is which
# pids are new, not whether the count is zero.
HOST_CHROME_BEFORE="$(pgrep -f 'chrome-headless-shell|chrome|chromium' 2>/dev/null | sort || true)"
echo "  chrome-ish processes already on the runner: $(printf '%s\n' "$HOST_CHROME_BEFORE" | grep -c . || true)"

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
# /api/version renders nothing. Health does — its first call starts the probe — so the
# baseline has to be taken before anything asks health a question.
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { docker logs "$NAME" | tail -30; fail "the container never answered"; }
  sleep 2
done

say "what is running before anything has rendered"
snapshot() { docker exec "$NAME" ps -eo pid,ppid,stat,etime,comm 2>/dev/null || true; }
BASELINE="$(snapshot)"
printf '%s\n' "$BASELINE" | sed 's/^/    /'
PID1="$(printf '%s\n' "$BASELINE" | awk '$1==1 {print $5}')"
echo "  PID 1 is: $PID1"
# An init that reaps is not a detail of the test environment — it is what the image
# ships, and `docker run --init` would hide its absence.
case "$PID1" in
  *tini*|*init*|*dumb-init*) : ;;
  *) fail "PID 1 in the image is '$PID1', which does not reap orphaned children" ;;
esac
BASE_PIDS="$(printf '%s\n' "$BASELINE" | awk 'NR>1 {print $1}' | sort -n)"

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

say "rendering Thai inside the container"
# Independent of the app's own probe: this uses the image's puppeteer-core and the
# image's browser directly, so what comes back proves the shared libraries and a
# Thai-capable font are really in there — not that the probe agrees with itself.
THAI_PHRASE="ใบรับรองแทนใบเสร็จรับเงิน"
docker exec "$NAME" node -e '
(async () => {
  const p = (await import("puppeteer-core")).default;
  const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
  const buildId = PUPPETEER_REVISIONS["chrome-headless-shell"];
  const exe = `/app/.browser-cache/chrome-headless-shell/linux-${buildId}/chrome-headless-shell-linux64/chrome-headless-shell`;
  const b = await p.launch({ executablePath: exe, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  try {
    const page = await b.newPage();
    // One Thai line near the top, then a deliberately empty band underneath. The empty
    // band is the control: if the "text" region and the blank region carry the same
    // amount of ink, nothing was drawn where the words should be.
    await page.setContent(`<!doctype html><html lang="th"><head><meta charset="utf-8"></head>
      <body style="margin:0"><div style="height:60px;font-size:28pt;padding:8px">ใบรับรองแทนใบเสร็จรับเงิน</div>
      <div style="height:400px"></div></body></html>`, { waitUntil: "load" });
    const pdf = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
    require("fs").writeFileSync("/tmp/thai.pdf", pdf);
    const head = pdf.subarray(0,5).toString("latin1");
    const tail = pdf.subarray(-1024).toString("latin1");
    if (head !== "%PDF-") throw new Error("not a pdf: " + head);
    if (!tail.includes("%%EOF")) throw new Error("truncated pdf");
    console.log(`  rendered ${pdf.length} bytes with build ${buildId}`);
  } finally { await b.close(); }
})().catch((e) => { console.error("  " + String(e)); process.exit(1); });
' || fail "rendering Thai inside the image failed"

docker cp "$NAME:/tmp/thai.pdf" /tmp/thai.pdf >/dev/null || fail "could not fetch the rendered PDF"

say "reading the Thai back out of that PDF"
# The real question is not "was a font embedded" — a page of boxes embeds a font too.
# It is whether the words are in there. pdftotext answers that directly when the PDF
# carries a ToUnicode map, which Chromium normally writes.
EXTRACTED=$(pdftotext -enc UTF-8 /tmp/thai.pdf - 2>/dev/null | tr -d "[:space:]" || true)
WANTED=$(printf '%s' "$THAI_PHRASE" | tr -d "[:space:]")
if printf '%s' "$EXTRACTED" | grep -qF "$WANTED"; then
  echo "  pdftotext: the phrase read back in full"
else
  echo "  pdftotext: the phrase did not round-trip (no ToUnicode map?) — falling back to fonts and ink"

  say "which fonts the page actually uses"
  FONTS=$(pdffonts /tmp/thai.pdf 2>/dev/null || true)
  printf '%s
' "$FONTS" | sed 's/^/    /'
  printf '%s' "$FONTS" | grep -qiE "noto|garuda|laksaman|loma|tlwg|sarabun" \
    || fail "no Thai-capable font is embedded — the page would be drawn as boxes"
  printf '%s' "$FONTS" | awk 'NR>2 && $NF ~ /no/ { bad=1 } END { exit bad }' 2>/dev/null \
    || echo "    (at least one font is not embedded; the Thai face is what matters)"

  say "and that there is ink where the words are"
  # A greyscale raster, parsed without any image library: P5, a header, then one byte a
  # pixel. The band with the words must be markedly darker than the empty band below it.
  pdftoppm -gray -r 72 -singlefile /tmp/thai.pdf /tmp/thai >/dev/null 2>&1 || fail "pdftoppm could not rasterise the page"
  node -e '
    const fs = require("fs");
    const buf = fs.readFileSync("/tmp/thai.pgm");
    let i = 0, fields = [];
    while (fields.length < 4) {
      while (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; i++; }        // a comment line
      let t = "";
      while (i < buf.length && buf[i] > 0x20) t += String.fromCharCode(buf[i++]);
      while (i < buf.length && buf[i] <= 0x20) i++;
      if (t) fields.push(t);
    }
    const [magic, w, h] = [fields[0], +fields[1], +fields[2]];
    if (magic !== "P5") throw new Error("not a greyscale raster: " + magic);
    const px = buf.subarray(i);
    const dark = (from, to) => {
      let n = 0;
      for (let y = from; y < to; y++) for (let x = 0; x < w; x++) if (px[y * w + x] < 200) n++;
      return n;
    };
    const band = Math.floor(h * 0.10);            // the strip the line of text sits in
    const blank = dark(band + 10, band + 110);    // the deliberately empty strip below it
    const text = dark(0, band);
    console.log(`  ink: ${text} dark pixels where the words are, ${blank} in the blank band below`);
    if (text < 200) throw new Error("the text band is empty — nothing was drawn");
    if (text <= blank) throw new Error("the text band is no darker than the blank one");
  ' || fail "the Thai line did not draw anything"
fi

say "peak memory, as the container itself measured it"
PEAK=$(docker exec "$NAME" sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null || echo ""' || echo "")
if [ -n "$PEAK" ]; then
  awk -v b="$PEAK" 'BEGIN{printf "  peak memory: %.0f MB\n", b/1024/1024}'
else
  echo "  peak memory: not exposed by this cgroup"
fi

say "what is still running, and what it is"
# Compared against the baseline rather than counted by name: the Node server and whatever
# the base image runs were there before any render and are not this test's business.
# Taken three times, because a process that is on its way out looks the same as one that
# is staying, for a moment.
report_new() {
  local when="$1" now new
  now="$(snapshot)"
  echo "  --- $when ---"
  new="$(printf '%s\n' "$now" | awk 'NR>1' | while read -r pid ppid stat etime comm; do
    # The `ps` this very snapshot is running is not a leftover: docker exec gives it
    # ppid 0, and it exits the moment the snapshot does.
    [ "$comm" = "ps" ] && [ "$ppid" = "0" ] && continue
    printf '%s\n' "$BASE_PIDS" | grep -qx "$pid" || printf '    pid=%-6s ppid=%-6s stat=%-5s elapsed=%-8s %s\n' "$pid" "$ppid" "$stat" "$etime" "$comm"
  done)"
  if [ -z "$new" ]; then echo "    (nothing new since the baseline)"; else printf '%s\n' "$new"; fi
  # Counted separately: a zombie has been reaped by nobody, a live process is still running.
  ZOMBIE=$(printf '%s\n' "$new" | grep -c "stat=Z" || true)
  LIVE=$(printf '%s\n' "$new" | grep -c "stat=" || true)
  LIVE=$(( LIVE - ZOMBIE ))
  echo "    new since baseline: $LIVE alive, $ZOMBIE zombie"
}
report_new "immediately after the render"
sleep 5;  report_new "after 5s"
sleep 10; report_new "after 15s"

say "and after a render that throws, one that times out, and three in a row"
# Cleanup that only works on the happy path is cleanup that will not be there when it
# matters. Each of these is asked of the running container, and the count must come back
# to the baseline every time rather than creeping up.
docker exec "$NAME" node -e '
(async () => {
  const p = (await import("puppeteer-core")).default;
  const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
  const exe = `/app/.browser-cache/chrome-headless-shell/linux-${PUPPETEER_REVISIONS["chrome-headless-shell"]}/chrome-headless-shell-linux64/chrome-headless-shell`;
  const open = () => p.launch({ executablePath: exe, args: ["--no-sandbox","--disable-dev-shm-usage"] });

  // A render that throws part way through.
  let b = await open();
  try { const pg = await b.newPage(); await pg.setContent("<p>ล้มกลางคัน</p>"); throw new Error("deliberate"); }
  catch { /* the point is what happens in finally */ }
  finally { await b.close(); }

  // A render abandoned by a timeout — the browser is still closed.
  b = await open();
  try {
    const pg = await b.newPage();
    await Promise.race([
      pg.setContent("<p>หมดเวลา</p>").then(() => pg.pdf({ format: "A4" })),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1)),
    ]);
  } catch { /* expected */ }
  finally { await b.close(); }

  // Three in a row.
  for (let i = 0; i < 3; i++) {
    const n = await open();
    try { const pg = await n.newPage(); await pg.setContent(`<p>รอบที่ ${i + 1}</p>`); await pg.pdf({ format: "A4" }); }
    finally { await n.close(); }
  }
  console.log("  throw, timeout and three consecutive renders done");
})().catch((e) => { console.error("  " + String(e)); process.exit(1); });
' || fail "the failure-path renders did not complete"

sleep 3; report_new "after throw, timeout and three renders"

NEW_TOTAL=$(( LIVE + ZOMBIE ))
echo "  PID 1 is still: $(docker exec "$NAME" ps -eo pid,comm 2>/dev/null | awk '$1==1 {print $2}')"
[ "$NEW_TOTAL" -eq 0 ] || fail "$LIVE live and $ZOMBIE zombie process(es) left over from rendering"

say "shutting it down the way a deploy does"
# `docker stop`, not `docker rm -f`: stop sends SIGTERM to PID 1 through the image's real
# CMD and waits, which is what Railway does when it replaces a container. `rm -f` sends
# SIGKILL and would prove nothing about whether anything shuts down gracefully.
#
# A container that has to be killed is one that was still holding something when the
# platform gave up on it — a half-written render, a browser mid-launch. The test is
# therefore not "did it stop" but "did it stop BY ITSELF, before the grace period ran
# out, without needing SIGKILL".
GRACE=20
echo "  zombies just before the stop: $(docker exec "$NAME" sh -c 'ps -eo stat 2>/dev/null | grep -c "^Z" || true')"
STOP_START=$(date +%s)
docker stop -t "$GRACE" "$NAME" >/dev/null
STOP_SECONDS=$(( $(date +%s) - STOP_START ))

EXIT_CODE=$(docker inspect "$NAME" --format '{{.State.ExitCode}}')
OOM=$(docker inspect "$NAME" --format '{{.State.OOMKilled}}')
echo "  stopped in ${STOP_SECONDS}s (grace period ${GRACE}s) · exit code $EXIT_CODE · OOMKilled=$OOM"

# 137 is 128+9: SIGKILL. Docker only sends that after the grace period has elapsed, so
# seeing it means nothing inside answered SIGTERM.
[ "$EXIT_CODE" != "137" ] || fail "the container had to be SIGKILLed — nothing inside answered SIGTERM"
[ "$OOM" != "true" ] || fail "the container was killed for memory during shutdown"
[ "$STOP_SECONDS" -lt "$GRACE" ] || fail "it took the whole ${GRACE}s grace period to stop, which means it was killed rather than exiting"
# 143 is 128+15, a clean SIGTERM exit; 0 is a clean exit of its own accord.
case "$EXIT_CODE" in
  0|143) echo "  exited on SIGTERM, of its own accord" ;;
  *) echo "  note: exit code $EXIT_CODE — not SIGKILL, so it exited itself, but check the logs" ;;
esac

# Nothing the container started may outlive it. A Chrome helper that escaped its cgroup
# would show up on the host, and no check above this line would have seen it — but the
# runner's own processes are not evidence of anything, so this compares pids against the
# baseline rather than demanding the host be empty.
sleep 2
# Sorted the way `comm` compares — lexicographically, not numerically. Mixing the two
# makes comm quietly report the wrong difference.
HOST_CHROME_AFTER="$(pgrep -f 'chrome-headless-shell|chrome|chromium' 2>/dev/null | sort || true)"
NEW_HOST_PIDS="$(comm -13 <(printf '%s\n' "$HOST_CHROME_BEFORE") <(printf '%s\n' "$HOST_CHROME_AFTER") 2>/dev/null || true)"
NEW_HOST_COUNT="$(printf '%s\n' "$NEW_HOST_PIDS" | grep -c . || true)"
echo "  chrome-ish processes new on the runner since the container started: ${NEW_HOST_COUNT:-0}"
if [ "${NEW_HOST_COUNT:-0}" -ne 0 ]; then
  printf '%s\n' "$NEW_HOST_PIDS" | while read -r pid; do
    [ -n "$pid" ] && printf '    pid=%s %s\n' "$pid" "$(ps -o comm= -p "$pid" 2>/dev/null || echo gone)"
  done
  fail "${NEW_HOST_COUNT} browser process(es) started during this test outlived the container"
fi

say "image smoke passed"
printf 'image_size_mb=%.0f\n' "$(awk -v b="$SIZE_BYTES" 'BEGIN{print b/1024/1024}')"
printf 'build_id=%s\n' "$EXPECTED_BUILD_ID"
