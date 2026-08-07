import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import { checkIntegrity } from "@/lib/integrity";

// GET — operator/admin only. Runs the read-only integrity health check on demand and
// returns the findings (missing bookings, pax mismatches, payment sanity). No writes.
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const report = await checkIntegrity();
  return NextResponse.json(report, { headers: { "cache-control": "private, no-store" } });
}
