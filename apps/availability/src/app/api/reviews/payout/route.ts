import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps, canViewFinance } from "@/lib/roles";
import { canJoinPayout, money2, nextPayoutRef } from "@/lib/review-incentives";

const bkk = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// GET — list review payouts (?id= for one with its reviews). Finance-gated.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!canViewFinance(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const payout = await prisma.reviewPayout.findUnique({ where: { id }, include: { reviews: { orderBy: { reviewDate: "asc" } } } });
    if (!payout) return NextResponse.json({ error: "not-found" }, { status: 404 });
    return NextResponse.json({ payout });
  }
  const payouts = await prisma.reviewPayout.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { _count: { select: { reviews: true } } } });
  const guides = await prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } });
  const gname = Object.fromEntries(guides.map((g) => [g.guideId, g.displayName]));
  return NextResponse.json({ payouts: payouts.map((p) => ({ ...p, reviewCount: p._count.reviews, guideName: gname[p.guideId] ?? p.guideId })) });
}

// POST { guideId, reviewIds } — bundle a guide's UNPAID+MATCHED reviews into one
// payout (normally the weekly run). Amounts are summed server-side; each review
// flips UNPAID → IN_PAYOUT and keeps payoutBatchId, so every payout line traces
// back to its review → booking → job → guide (spec §7/§15).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ guideId: z.string().min(1), reviewIds: z.array(z.string()).min(1).max(200), note: z.string().max(300).optional() })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { guideId, reviewIds, note } = parsed.data;

  const reviews = await prisma.review.findMany({ where: { id: { in: reviewIds }, guideId } });
  const eligible = reviews.filter(canJoinPayout);
  const skipped = reviewIds.length - eligible.length; // wrong guide / already in a payout / paid / void / unmatched
  if (!eligible.length) return NextResponse.json({ error: "nothing-eligible", skipped }, { status: 400 });

  const today = bkk();
  const dates = eligible.map((r) => r.reviewDate).sort();
  const ref = await nextPayoutRef(today);
  const total = money2(eligible.reduce((s, r) => s + r.incentiveAmount, 0));

  const payout = await prisma.$transaction(async (tx) => {
    const p = await tx.reviewPayout.create({
      data: { ref, guideId, periodStart: dates[0], periodEnd: dates[dates.length - 1], totalAmount: total, note: note ?? null, createdById: session!.user!.id ?? null },
    });
    await tx.review.updateMany({ where: { id: { in: eligible.map((r) => r.id) }, paymentStatus: "UNPAID" }, data: { paymentStatus: "IN_PAYOUT", payoutBatchId: p.id } });
    return p;
  });
  await audit({
    actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "review_payout.created",
    entityType: "ReviewPayout", entityId: payout.id,
    detail: { ref, guideId, reviews: eligible.length, total, skipped },
  });
  return NextResponse.json({ ok: true, id: payout.id, ref, total, count: eligible.length, skipped });
}

// PATCH { id, action: "paid" | "unpaid" } — settle or revert a payout. Reviews
// follow: IN_PAYOUT → PAID on settle; PAID → IN_PAYOUT on revert (only this
// payout's own reviews are touched, mirroring the batch provenance rule).
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = z.object({ id: z.string().min(1), action: z.enum(["paid", "unpaid"]) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, action } = parsed.data;
  const payout = await prisma.reviewPayout.findUnique({ where: { id } });
  if (!payout) return NextResponse.json({ error: "not-found" }, { status: 404 });

  if (action === "paid") {
    if (payout.status === "PAID") return NextResponse.json({ ok: true }); // idempotent
    await prisma.$transaction([
      prisma.reviewPayout.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } }),
      prisma.review.updateMany({ where: { payoutBatchId: id }, data: { paymentStatus: "PAID" } }),
    ]);
    await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "review_payout.paid", entityType: "ReviewPayout", entityId: id, detail: { ref: payout.ref, guideId: payout.guideId, total: payout.totalAmount } });
    return NextResponse.json({ ok: true });
  }
  // revert
  if (payout.status !== "PAID") return NextResponse.json({ ok: true });
  await prisma.$transaction([
    prisma.reviewPayout.update({ where: { id }, data: { status: "DRAFT", paidAt: null } }),
    prisma.review.updateMany({ where: { payoutBatchId: id }, data: { paymentStatus: "IN_PAYOUT" } }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "review_payout.unpaid", entityType: "ReviewPayout", entityId: id, detail: { ref: payout.ref } });
  return NextResponse.json({ ok: true });
}

// DELETE ?id= — cancel a payout that hasn't been paid: its reviews go back to
// UNPAID (payoutBatchId clears via SetNull). A PAID payout is delete-locked,
// same as a PAID payment batch.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id") || "";
  const payout = await prisma.reviewPayout.findUnique({ where: { id } });
  if (!payout) return NextResponse.json({ error: "not-found" }, { status: 404 });
  if (payout.status === "PAID") return NextResponse.json({ error: "paid-locked", hint: "Un-mark it paid first." }, { status: 409 });
  await prisma.$transaction([
    prisma.review.updateMany({ where: { payoutBatchId: id }, data: { paymentStatus: "UNPAID" } }),
    prisma.reviewPayout.delete({ where: { id } }),
  ]);
  await audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: "review_payout.deleted", entityType: "ReviewPayout", entityId: id, detail: { ref: payout.ref, guideId: payout.guideId } });
  return NextResponse.json({ ok: true });
}
