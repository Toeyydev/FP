import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { canViewFinance } from "@/lib/roles";
import { refundReviews } from "@/lib/advances/refund-review";
import { advanceWritesFrozen } from "@/lib/advances/freeze";

export const dynamic = "force-dynamic";

// GET ?status= — refunds of excess returns, each with the evidence needed to approve it
// (lib/advances/refund-review). Read-only, finance roles: this is the accountant's view of
// the refund workflow — they approve here, without the operational job sheet.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const status = req.nextUrl.searchParams.get("status") ?? "";
  const refunds = await refundReviews(prisma, status ? { status } : {});
  return NextResponse.json({ refunds, frozen: advanceWritesFrozen() });
}
