import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { upsellSaleAccess } from "@/lib/upsell/access";
import { saleByKey } from "@/lib/upsell/sales";

export const dynamic = "force-dynamic";

// GET — did the sale with this request key reach the server? 200 with the sale, or 404
// NOT_RECEIVED. Used after a lost connection, before anything is sent again: the app never
// starts a new sale while this is unknown. Only the guide's own keys.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const a = await upsellSaleAccess();
  if (!a.ok) return NextResponse.json({ error: a.status === 404 ? "not-found" : "forbidden" }, { status: a.status });
  const { key } = await ctx.params;
  if (!/^[A-Za-z0-9-]{16,80}$/.test(key)) return NextResponse.json({ error: "BAD_REQUEST" }, { status: 400 });
  const sale = await saleByKey(prisma, key, a.guideId);
  if (!sale) return NextResponse.json({ error: "NOT_RECEIVED", message: "This sale was not recorded." }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ok: true, sale }, { headers: { "cache-control": "no-store" } });
}
