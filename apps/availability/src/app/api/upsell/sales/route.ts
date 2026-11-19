import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellSaleAccess } from "@/lib/upsell/access";
import { recordRouteExtensionSale, UpsellSaleError } from "@/lib/upsell/sales";

export const dynamic = "force-dynamic";

// POST { requestKey, jobSheetId, productVersionId, guests, expectedUnitPriceSatang } — the guide
// records a Route Extension sold on their own job, paid to them in cash: sale + payment +
// custody in one transaction (lib/upsell/sales). The same requestKey again answers with the
// same sale (200, replay: true) — never a second one. Refs are the system's: a request that
// carries saleNo / jobRef / jobSheetRef / settlementNo is a 400. GUIDE only; 404 while off.
export async function POST(req: NextRequest) {
  const a = await upsellSaleAccess();
  if (!a.ok) return NextResponse.json({ error: a.status === 404 ? "not-found" : "forbidden" }, { status: a.status });
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "BAD_REQUEST", message: "The request was not JSON." }, { status: 400 });
  try {
    const r = await recordRouteExtensionSale(prisma, body, { userId: a.userId, guideId: a.guideId });
    return NextResponse.json({ ok: true, ...r }, { status: r.replay ? 200 : 201 });
  } catch (e) {
    if (e instanceof UpsellSaleError) return NextResponse.json({ error: e.code, message: e.message, ...(e.detail ?? {}) }, { status: e.status });
    throw e;
  }
}
