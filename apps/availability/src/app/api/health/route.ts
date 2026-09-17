import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { advanceWritesBlocked, advanceWritesFrozen, ledgerMigrated } from "@/lib/advances/freeze";
import { ADVANCE_BUILD, DB_APPLICATION_NAME } from "@/lib/advances/build";

// Public health check: confirms the app can reach Postgres and reports the
// round-trip latency (dbMs). Consumed by the external uptime/latency monitor —
// a jump in dbMs is the early-warning signal that the DB path regressed (e.g.
// DATABASE_URL slipping back to the public proxy instead of the internal
// network). Returns no secrets and no infra hostnames.
//
// `advances` says which advance build is serving and whether it takes advance writes, so
// the cutover runbook can confirm the freeze from outside, without signing in.
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const dbMs = Date.now() - started;
    return NextResponse.json({ ok: true, dbMs, advances: { build: ADVANCE_BUILD, dbApplicationName: DB_APPLICATION_NAME, writes: (await advanceWritesBlocked(prisma)) ? "frozen" : "open", switch: advanceWritesFrozen() ? "on" : "off", ledgerMigrated: await ledgerMigrated(prisma) } });
  } catch {
    return NextResponse.json(
      { ok: false, dbMs: Date.now() - started },
      { status: 503 },
    );
  }
}
