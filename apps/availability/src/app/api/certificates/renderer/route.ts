import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { audit } from "@/lib/audit";
import { CHROME_BUILD_ID, findExecutable } from "@/lib/certificates/browser";
import { cachedProbe, probeRenderer, PROBE_TIMEOUT_MS } from "@/lib/certificates/probe";
import { denied } from "@/lib/certificates/denied";

export const dynamic = "force-dynamic";

// Asking the renderer to prove itself, on demand, in production.
//
// GET  — the last measured answer, cheap, no browser started
// POST — measure it again now
//
// What the deep check renders is a page of invented text with nothing on it: no job
// sheet, no guide, no money. The bytes are checked for a PDF header and trailer and then
// dropped. Nothing is written to the database, to Drive or to a job sheet, and no
// certificate comes into existence — the point is to learn whether the browser works
// without doing anything that would matter if it did not.

/** One deep check at a time across the process, and not more than one a minute. */
const MIN_GAP_MS = 60_000;
let lastForced = 0;
let forcing: Promise<unknown> | null = null;

export async function GET() {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.renderer_get");
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const exe = findExecutable();
  const last = cachedProbe();
  return NextResponse.json({
    ok: true,
    // Whether a browser is installed where this build expects one. Not a path.
    executable: exe.ok ? { present: true, source: exe.source } : { present: false, reason: exe.code, source: exe.source },
    buildId: CHROME_BUILD_ID,
    lastProbe: last ?? null,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

export async function POST() {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    await denied(session, "certificate.renderer_probe");
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const since = Date.now() - lastForced;
  if (forcing) return NextResponse.json({ error: "in-progress", reasons: ["A renderer check is already running."] }, { status: 429 });
  if (since < MIN_GAP_MS) {
    return NextResponse.json({
      error: "too-soon",
      reasons: [`A renderer check starts a browser. Wait ${Math.ceil((MIN_GAP_MS - since) / 1000)}s, or read the last result.`],
      lastProbe: cachedProbe() ?? null,
    }, { status: 429 });
  }

  lastForced = Date.now();
  forcing = probeRenderer({ force: true });
  try {
    const result = await (forcing as Promise<Awaited<ReturnType<typeof probeRenderer>>>);
    await audit({
      actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null,
      action: "certificate.renderer_probed", entityType: "Renderer",
      // Safe to keep: a status, a code and a duration. No path, no environment, no stack.
      detail: { status: result.status, code: result.code, ms: result.ms, buildId: CHROME_BUILD_ID,
        note: "synthetic page, rendered in memory and discarded; no certificate, no Drive, no job sheet" },
    });
    return NextResponse.json({ ok: result.status === "ready", probe: result, buildId: CHROME_BUILD_ID });
  } finally {
    forcing = null;
  }
}
