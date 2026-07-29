import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Public health check: confirms the app can reach Postgres and reports the
// round-trip latency (dbMs). Consumed by the external uptime/latency monitor —
// a jump in dbMs is the early-warning signal that the DB path regressed (e.g.
// DATABASE_URL slipping back to the public proxy instead of the internal
// network). Returns no secrets and no infra hostnames.
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, dbMs: Date.now() - started });
  } catch {
    return NextResponse.json(
      { ok: false, dbMs: Date.now() - started },
      { status: 503 },
    );
  }
}
