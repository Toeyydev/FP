import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { listHandIns } from "@/lib/upsell/settlement";

export const dynamic = "force-dynamic";

// GET ?status=SUBMITTED,RETURNED — the guides' Extras cash hand-ins (finance roles read).
export async function GET(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR", "ACCOUNTANT"); if (no) return no;
  const status = (req.nextUrl.searchParams.get("status") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return NextResponse.json({ rows: await listHandIns(prisma, { status }), canDecide: a.role === "ADMIN" });
}
