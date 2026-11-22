import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cashActor, only } from "@/lib/upsell/cash-access";
import { recordOfficeSale, UpsellSaleError } from "@/lib/upsell/sales";

export const dynamic = "force-dynamic";

// POST { kind, reason, receivedOn, requestKey, jobSheetId, productVersionId, guests,
// expectedUnitPriceSatang, allocations? | leadName? } — an Admin or operator records, on the Job
// Sheet, a cash sale the job's guide told the office about (owner, 22 Nov 2026). The guide holds
// the cash and hands it in as for their own sale. Accountants read only; 404 while Extras is off.
export async function POST(req: NextRequest) {
  const a = await cashActor();
  if (a instanceof NextResponse) return a;
  const no = only(a, "ADMIN", "OPERATOR"); if (no) return no;
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "BAD_REQUEST", message: "The request was not JSON." }, { status: 400 });
  try {
    const r = await recordOfficeSale(prisma, body, { userId: a.userId, role: a.role as "ADMIN" | "OPERATOR" });
    return NextResponse.json({ ok: true, ...r }, { status: r.replay ? 200 : 201 });
  } catch (e) {
    if (e instanceof UpsellSaleError) return NextResponse.json({ error: e.code, message: e.message, ...(e.detail ?? {}) }, { status: e.status });
    throw e;
  }
}
