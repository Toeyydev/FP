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
  // The company's receiving account versions (retired ones too): a slip is reviewed as paid into one of them.
  const accounts = (await prisma.upsellReceivingAccount.findMany({ orderBy: { version: "desc" } })).map((x) => ({ id: x.id, version: x.version, label: x.label, display: x.accountDisplay, retired: !!x.retiredAt }));
  return NextResponse.json({ rows: await listHandIns(prisma, { status }), accounts, canDecide: a.role === "ADMIN" });
}
