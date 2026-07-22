import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { canViewFinance, isOps } from "@/lib/roles";

// GET — open reconciliation flags (portal ↔ GetYourGuide mismatches), for the
// operator dashboard panel. Finance roles may view.
export async function GET() {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const flags = await prisma.reconciliationFlag.findMany({
    where: { resolved: false },
    orderBy: [{ tourDate: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ flags });
}

// POST { id } — mark a flag resolved (the operator has handled the mismatch on GYG
// / the portal). Operators/admin only. Accountant is read-only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id } = parsed.data;
  const updated = await prisma.reconciliationFlag.updateMany({
    where: { id, resolved: false },
    data: { resolved: true, resolvedBy: session!.user!.id ?? null, resolvedAt: new Date() },
  });
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "reconcile.resolved", entityType: "ReconciliationFlag", entityId: id });
  return NextResponse.json({ ok: true, resolved: updated.count });
}
