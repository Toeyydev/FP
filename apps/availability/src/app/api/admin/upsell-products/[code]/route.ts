import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getProduct, saveProduct, UpsellProductError } from "@/lib/upsell/products";
import { upsellSettingsAccess } from "@/lib/upsell/settings-access";

export const dynamic = "force-dynamic";

const refuse = (status: number) => NextResponse.json({ error: status === 404 ? "not-found" : "forbidden" }, { status });
const answer = (e: unknown) => {
  if (e instanceof UpsellProductError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  throw e;
};

// GET — one product: its form, the rules it does not edit, and every version. ADMIN, OPERATOR and
// ACCOUNTANT. Reads only.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const a = await upsellSettingsAccess();
  if (!a.ok) return refuse(a.status);
  const { code } = await ctx.params;
  try { return NextResponse.json({ ok: true, canEdit: a.canEdit, ...(await getProduct(prisma, code)) }); } catch (e) { return answer(e); }
}

// PUT — Save. ADMIN only. Edits the latest version in place while it has no sales, else makes
// the next version (lib/upsell/products). A field the product does not have is a 400.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const a = await upsellSettingsAccess();
  if (!a.ok) return refuse(a.status);
  if (!a.canEdit) return refuse(403);
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "BAD_FORM", message: "The request was not JSON." }, { status: 400 });
  const { code } = await ctx.params;
  try { return NextResponse.json({ ok: true, ...(await saveProduct(prisma, code, body, { id: a.userId, role: a.role })) }); } catch (e) { return answer(e); }
}
