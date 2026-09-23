import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

// POST — the guide says they have the money and have read what it is for.
//
// Not gated on the advance write freeze: this records evidence, not a movement.
// It cannot change an amount, a balance or an account — the only thing it writes
// is "this person confirmed, at this time", which is exactly what a signature on
// a paper voucher does. Recorded once; pressing it again returns the first time.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const myGuideId = session?.user?.guideId ?? null;
  if (!session?.user || !myGuideId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const advance = await prisma.guideAdvance.findUnique({
    where: { id }, select: { id: true, guideId: true, advanceNo: true, acknowledgedAt: true, reversedAt: true },
  });
  if (!advance) return NextResponse.json({ error: "not-found" }, { status: 404 });
  // Only the guide who holds the money can acknowledge it. An operator confirming
  // on the guide's behalf would defeat the point of the document.
  if (advance.guideId !== myGuideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (advance.reversedAt) return NextResponse.json({ error: "not-allowed", reasons: ["This advance was reversed"] }, { status: 409 });
  if (advance.acknowledgedAt) return NextResponse.json({ ok: true, acknowledgedAt: advance.acknowledgedAt, replayed: true });

  const updated = await prisma.guideAdvance.updateMany({
    where: { id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedById: session.user.id ?? null },
  });
  if (updated.count === 1) {
    await audit({
      actorId: session.user.id ?? null, actorRole: session.user.role ?? null,
      action: "advance.acknowledged", entityType: "GuideAdvance", entityId: id,
      detail: { advanceNo: advance.advanceNo, guideId: advance.guideId },
    });
  }
  const now = await prisma.guideAdvance.findUnique({ where: { id }, select: { acknowledgedAt: true } });
  return NextResponse.json({ ok: true, acknowledgedAt: now?.acknowledgedAt ?? null, replayed: updated.count !== 1 });
}
