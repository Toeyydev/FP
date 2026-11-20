import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { setProductActive, UpsellProductError } from "@/lib/upsell/products";
import { upsellSettingsAccess } from "@/lib/upsell/settings-access";

export const dynamic = "force-dynamic";

// POST { expectedUpdatedAt, active } — Activate / Deactivate. ADMIN only. Active alone sells
// nothing: a product is live only while its switch is on as well.
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const a = await upsellSettingsAccess();
  if (!a.ok) return NextResponse.json({ error: a.status === 404 ? "not-found" : "forbidden" }, { status: a.status });
  if (!a.canEdit) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "BAD_FORM", message: "The request was not JSON." }, { status: 400 });
  const { code } = await ctx.params;
  try {
    return NextResponse.json({ ok: true, ...(await setProductActive(prisma, code, body, { id: a.userId, role: a.role })) });
  } catch (e) {
    if (e instanceof UpsellProductError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    throw e;
  }
}
