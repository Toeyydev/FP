import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { listReversals } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// GET ?status=AWAITING_ADMIN — sale reversals (finance roles read; an Admin decides).
export async function GET(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  return NextResponse.json({ rows: await listReversals(prisma, { status: req.nextUrl.searchParams.get("status") ?? undefined }) });
}
