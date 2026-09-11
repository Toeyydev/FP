import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { canViewFinance } from "@/lib/roles";
import { lookupBookingReference } from "@/lib/review-incentives";

// GET ?ref=GYG… — the prominent booking-reference search on the Reviews page:
// booking → job → guide, so the operator never re-enters what the ref already
// identifies (spec §2). Read-only; finance roles only.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ref = req.nextUrl.searchParams.get("ref") || "";
  if (ref.trim().length < 4) return NextResponse.json({ error: "ref-too-short" }, { status: 400 });
  return NextResponse.json(await lookupBookingReference(ref));
}
