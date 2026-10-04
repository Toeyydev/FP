import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isOps } from "@/lib/roles";
import { changeReviewIncentive, setPeakRef, voidSupplemental } from "@/lib/supplemental-payments/service";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("void"), reason: z.string().max(500) }),
  z.object({ action: z.literal("peakRef"), peakRef: z.string().max(40), reason: z.string().max(500).nullish() }),
  // An unpaid review incentive: more reviews for its month, or e-Withholding on/off.
  z.object({ action: z.literal("reviews"), addReviews: z.number().int().nullish(), eWithholding: z.boolean().nullish(), reason: z.string().max(500) }),
]);

// PATCH — void an UNPAID supplemental payment (with a reason), or record the PEAK document
// it is booked in (correcting one already recorded needs a reason). Nothing else about it changes once created; a paid one is undone by
// reversing its payment. Operators and admins only.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id } = await params;
  const actor = { actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null };
  const d = parsed.data;
  const r = d.action === "void"
    ? await voidSupplemental(prisma, { id, reason: d.reason, actor })
    : d.action === "reviews"
      ? await changeReviewIncentive(prisma, { id, addReviews: d.addReviews ?? null, eWithholding: d.eWithholding ?? null, reason: d.reason, actor })
      : await setPeakRef(prisma, { id, peakRef: d.peakRef, reason: d.reason ?? null, actor });
  if (!r.ok) return NextResponse.json({ error: "refused", reasons: r.reasons }, { status: r.status });
  return NextResponse.json({ ok: true });
}
