import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { listPeakEvents } from "@/lib/upsell/peak-send";
import { upsellPeakAutoSyncEnabled } from "@/lib/upsell/flags";

export const dynamic = "force-dynamic";

// GET — Finance reads (ADMIN, OPERATOR, ACCOUNTANT): where each upsell event stands in PEAK.
export async function GET() {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  return NextResponse.json({ autoSync: upsellPeakAutoSyncEnabled(), ...(await listPeakEvents(prisma)) });
}
