import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { clientToken, peakMissingEnv, sanitizePeakError } from "@/lib/peak-api";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

export const dynamic = "force-dynamic"; // read env + call PEAK at request time, never cache

// GET — does PEAK accept our credentials right now?
//
// Performs the Client Token handshake ONLY: no contact is looked up, no expense is
// created, nothing in the database is touched. The token stays server-side (it is
// cached inside lib/peak-api and never serialised here), so the response says
// whether the handshake worked and nothing more.
//
// Access: an operator/admin session, or `x-cron-secret: $CRON_SECRET` for a
// terminal check — the same header the offers sweep uses.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!viaCron) {
    const session = await auth();
    if (!ops(session?.user?.role)) return NextResponse.json({ ok: false, service: "PEAK", connected: false, error: "forbidden" }, { status: 403 });
  }

  // Missing env is a deploy problem, not a PEAK problem — name the vars to set.
  const missing = peakMissingEnv();
  if (missing.length) {
    return NextResponse.json({ ok: false, service: "PEAK", connected: false, error: `missing environment variables: ${missing.join(", ")}` }, { status: 503 });
  }

  let res;
  try {
    res = await clientToken(true); // force: a cached token would not prove PEAK is reachable
  } catch (e) {
    return NextResponse.json({ ok: false, service: "PEAK", connected: false, error: sanitizePeakError(e) }, { status: 502 });
  }

  if (res.ok && res.token) return NextResponse.json({ ok: true, service: "PEAK", connected: true });

  // Sanitised failure: PEAK's own result code/description, scrubbed of anything
  // that could match a credential. Never the token, never the request body.
  return NextResponse.json({
    ok: false,
    service: "PEAK",
    connected: false,
    error: sanitizePeakError(res.desc || "PEAK rejected the client token request"),
    peakCode: res.code ?? null,
  }, { status: 502 });
}
