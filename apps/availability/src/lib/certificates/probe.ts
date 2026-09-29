import { findExecutable } from "@/lib/certificates/browser";
import { renderPdf } from "@/lib/certificates/pdf";

// Asking the renderer to prove it works, rather than asking whether a file exists.
//
// A path that exists and is executable still tells you very little. A browser missing a
// shared library starts and dies; one that starts may still fail to produce a page. The
// only answer worth reporting is the one you get by rendering something, so this renders
// something: a page of invented text, in memory, with no data on it, and checks that what
// comes back is a PDF.
//
// It is deliberately cheap to be wrong about in the safe direction. Nothing here writes
// to the database, to Drive, or to a job sheet, and no certificate is created. The bytes
// are looked at and dropped.

export type RendererStatus = "ready" | "unavailable" | "misconfigured";

export type RendererProbe = {
  status: RendererStatus;
  /** A short, safe word. Never a path, an environment or a stack. */
  code: string;
  /** How long the probe took, in milliseconds. */
  ms: number;
  /** When it ran, so a cached answer can be read for what it is. */
  at: string;
};

/** Long enough for a cold start on a small container, short enough not to hang a request. */
export const PROBE_TIMEOUT_MS = 20_000;
/** How long an answer is believed. A browser does not come and go minute to minute. */
export const PROBE_CACHE_MS = 5 * 60_000;

/** A page with nothing real on it. No network, no fonts to fetch, no data. */
const PROBE_HTML = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>probe</title>
<style>@page{size:A4;margin:10mm} body{font-family:sans-serif;font-size:12pt}</style></head>
<body><p>renderer probe</p><p>ทดสอบการแสดงผลภาษาไทย</p></body></html>`;

let cached: RendererProbe | null = null;
let inFlight: Promise<RendererProbe> | null = null;

export function cachedProbe(): RendererProbe | null {
  if (!cached) return null;
  return Date.now() - Date.parse(cached.at) < PROBE_CACHE_MS ? cached : null;
}

/** Drop the cached answer. Used by the deep check, and by tests. */
export function resetProbe(): void {
  cached = null;
  inFlight = null;
}

async function run(timeoutMs: number): Promise<RendererProbe> {
  const started = Date.now();
  const done = (status: RendererStatus, code: string): RendererProbe =>
    ({ status, code, ms: Date.now() - started, at: new Date().toISOString() });

  const exe = findExecutable();
  if (!exe.ok) return done("unavailable", exe.code);

  try {
    const bytes = await Promise.race([
      renderPdf(PROBE_HTML),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe-timeout")), timeoutMs).unref?.()),
    ]);
    const head = bytes.subarray(0, 5).toString("latin1");
    const tail = bytes.subarray(-1024).toString("latin1");
    if (head !== "%PDF-") return done("misconfigured", "not-a-pdf");
    if (!tail.includes("%%EOF")) return done("misconfigured", "truncated-pdf");
    if (bytes.length < 400) return done("misconfigured", "suspiciously-small");
    return done("ready", "ok");
  } catch (err) {
    // Reduced to a word on purpose: this is reported on a public health endpoint, and a
    // launch failure's message can carry paths and library names.
    const msg = String(err);
    const code = /probe-timeout/.test(msg) ? "timeout"
      : /ENOENT|not found/i.test(msg) ? "launch-enoent"
      : /shared librar|\.so[.\d]*:|cannot open shared/i.test(msg) ? "missing-libraries"
      : /EACCES|permission/i.test(msg) ? "permission-denied"
      : "launch-failed";
    return done("misconfigured", code);
  }
}

/**
 * The renderer's state, measured.
 *
 * Cached, and single-flighted: a health endpoint that started a browser on every request
 * would be a way to bring a small container down by refreshing a page.
 */
export async function probeRenderer(opts: { force?: boolean; timeoutMs?: number } = {}): Promise<RendererProbe> {
  if (!opts.force) {
    const hit = cachedProbe();
    if (hit) return hit;
    if (inFlight) return inFlight;
  }
  const p = run(opts.timeoutMs ?? PROBE_TIMEOUT_MS).then((r) => { cached = r; inFlight = null; return r; },
    (e) => { inFlight = null; throw e; });
  if (!opts.force) inFlight = p;
  return p;
}

/**
 * What health says, without waiting for a browser.
 *
 * A health check has to stay cheap, so this never blocks: it reports the last measured
 * answer, and when there is none it starts one in the background and says so. The first
 * health check after a deployment therefore reads `unmeasured`, and the one after it
 * reads what the render actually did — which is as close to a startup probe as this
 * needs, given the platform polls health anyway.
 *
 * `unmeasured` is deliberately not `ready`. Saying a renderer works before anything has
 * rendered is the exact mistake this replaces.
 */
export function rendererStatusForHealth(): { status: RendererStatus | "unmeasured"; code: string } {
  const hit = cachedProbe();
  if (hit) return { status: hit.status, code: hit.code };
  const exe = findExecutable();
  if (!exe.ok) return { status: "unavailable", code: exe.code };
  // Fire and forget, single-flighted inside probeRenderer. A failure here is not a
  // health failure — the next call will report whatever it found.
  void probeRenderer().catch(() => {});
  return { status: "unmeasured", code: "probing" };
}
