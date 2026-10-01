import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

const ops = (r?: string) => r === "OPERATOR" || r === "ADMIN";

// Closed (owner decision 2026-10-01). A bonus is paid as a supplemental payment now — with
// its own transfer, slip and PEAK reference (lib/supplemental-payments). Earlier bonuses
// stay readable as history; nothing new is filed against them here.
export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!ops(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ error: "read-only", reasons: ["Bonuses are now paid as supplemental payments — use Add Supplemental Payment and record the transfer there."] }, { status: 410 });
}
