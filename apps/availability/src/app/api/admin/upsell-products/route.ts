import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { listProducts } from "@/lib/upsell/products";
import { upsellSettingsAccess } from "@/lib/upsell/settings-access";

export const dynamic = "force-dynamic";

// GET — the upsell products, for Settings › Upsell products. ADMIN and ACCOUNTANT; 404 while
// UPSELL_ENABLED is off. Reads only.
export async function GET() {
  const a = await upsellSettingsAccess();
  if (!a.ok) return NextResponse.json({ error: a.status === 404 ? "not-found" : "forbidden" }, { status: a.status });
  return NextResponse.json({ ok: true, canEdit: a.canEdit, products: await listProducts(prisma) });
}
