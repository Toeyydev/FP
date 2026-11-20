import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellSaleAccess } from "@/lib/upsell/access";
import { jobExtras } from "@/lib/upsell/sales";

export const dynamic = "force-dynamic";

// GET ?guideId&date&slotIdx — the Extras block of the guide's own job sheet: what they may sell
// on it now, what they have sold, and the cash they hold for Folkpaths (from the custody
// ledger). The job's own GUIDE only; 404 while the Route Extension switch is off.
export async function GET(req: NextRequest) {
  const a = await upsellSaleAccess("ANY");
  if (!a.ok) return NextResponse.json({ error: a.status === 404 ? "not-found" : "forbidden" }, { status: a.status });
  const q = req.nextUrl.searchParams;
  const guideId = q.get("guideId") ?? "", date = q.get("date") ?? "", slotIdx = Number(q.get("slotIdx"));
  if (!guideId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(slotIdx) || slotIdx < 0) {
    return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  }
  if (guideId !== a.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(await jobExtras(prisma, { guideId, date, slotIdx }), { headers: { "cache-control": "no-store" } });
}
