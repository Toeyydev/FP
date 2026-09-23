import { NextResponse } from "next/server";
import { pdfRendererAvailable } from "@/lib/certificates/pdf";
import { prisma } from "@/lib/db";
import { advanceWritesFrozen } from "@/lib/advances/freeze";
import { ADVANCE_BUILD, DB_APPLICATION_NAME } from "@/lib/advances/build";
import { readLoopHealth } from "@/lib/heartbeat";
import { lineEnabled } from "@/lib/line";
import { pushEnabled } from "@/lib/push";
import { emailEnabled } from "@/lib/email";

// Public health check: confirms the app can reach Postgres and reports the
// round-trip latency (dbMs). Consumed by the external uptime/latency monitor —
// a jump in dbMs is the early-warning signal that the DB path regressed (e.g.
// DATABASE_URL slipping back to the public proxy instead of the internal
// network). Returns no secrets and no infra hostnames.
//
// `advances` says which advance build is serving and whether it takes advance writes, so
// the cutover runbook can confirm the freeze from outside, without signing in.
//
// `loop` is the background sweeps' pulse: `beating: false` means offers are not
// expiring and reminders are not being sent, whatever the page looks like. `channels`
// says which ways of reaching a guide are actually configured — an unset one fails
// silently (sendEmail just logs), which is how a reminder path shipped reaching nobody.
// Booleans and a timestamp only: no credentials, no hostnames.
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const dbMs = Date.now() - started;
    const loop = await readLoopHealth();
    return NextResponse.json({
      ok: true, dbMs,
      loop,
      channels: { line: lineEnabled, push: pushEnabled, email: emailEnabled },
      // Whether this deployment can turn a certificate into a PDF. Reported as a word,

      // never as a path — where a binary lives is not something to publish.

      certificateRenderer: pdfRendererAvailable() ? "ready" : "unavailable",

      advances: { build: ADVANCE_BUILD, dbApplicationName: DB_APPLICATION_NAME, writes: advanceWritesFrozen() ? "frozen" : "open", switch: advanceWritesFrozen() ? "on" : "off" },
    });
  } catch {
    return NextResponse.json(
      { ok: false, dbMs: Date.now() - started },
      { status: 503 },
    );
  }
}
