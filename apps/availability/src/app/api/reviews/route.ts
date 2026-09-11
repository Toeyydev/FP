import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { isOps, canViewFinance } from "@/lib/roles";
import {
  createReviewFromInput,
  lookupBookingReference,
  normalizeBookingRef,
  money2,
  REVIEW_SOURCES,
} from "@/lib/review-incentives";

// GET — the review inbox. Finance roles see everything (with filters); a guide
// sees only their own non-VOID reviews (read-only, spec §16).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = session.user.role;
  const sp = req.nextUrl.searchParams;

  const where: Record<string, unknown> = {};
  if (!canViewFinance(role)) {
    if (!session.user.guideId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    where.guideId = session.user.guideId;
    where.paymentStatus = { not: "VOID" };
  } else {
    const g = sp.get("guideId"); if (g) where.guideId = g;
    const m = sp.get("matchStatus"); if (m) where.matchStatus = m;
    const p = sp.get("paymentStatus"); if (p) where.paymentStatus = p;
    const s = sp.get("source"); if (s) where.source = s;
    const r = Number(sp.get("rating")); if (r >= 1 && r <= 5) where.rating = r;
    const from = sp.get("from"), to = sp.get("to");
    if (from || to) where.reviewDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [reviews, guides] = await Promise.all([
    prisma.review.findMany({ where, orderBy: [{ reviewDate: "desc" }, { createdAt: "desc" }], take: 500 }),
    prisma.user.findMany({ where: { guideId: { not: null } }, select: { guideId: true, displayName: true } }),
  ]);
  const gname = Object.fromEntries(guides.map((g) => [g.guideId, g.displayName]));
  return NextResponse.json({
    reviews: reviews.map((r) => ({ ...r, guideName: r.guideId ? gname[r.guideId] ?? r.guideId : null })),
    guides: canViewFinance(role) ? guides : undefined,
  });
}

const createSchema = z.object({
  bookingReference: z.string().max(60).optional(),
  source: z.enum(REVIEW_SOURCES).default("GETYOURGUIDE"),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  reviewerName: z.string().max(120).optional(),
  reviewText: z.string().max(4000).optional(),
  reviewUrl: z.string().max(1000).optional(),
  incentiveAmount: z.number().min(0).max(100000).optional(),
  force: z.boolean().optional(), // create despite the duplicate warning
});

// POST — create a review (operator UI today; a future email worker calls the
// same createReviewFromInput service). 409 + the existing row on a duplicate
// booking-ref+source unless force is set — never silently duplicated (spec §13).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });

  const out = await createReviewFromInput(parsed.data, { id: session!.user!.id, role: session!.user!.role });
  if (out.duplicate) return NextResponse.json({ error: "duplicate", duplicate: out.duplicate }, { status: 409 });
  return NextResponse.json({ ok: true, id: out.review!.id });
}

const patchSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["match", "setGuide", "amount", "edit", "void", "unvoid"]),
  bookingReference: z.string().max(60).optional(), // match
  guideId: z.string().max(20).optional(), // setGuide (manual pick — e.g. ambiguous split slot)
  incentiveAmount: z.number().min(0).max(100000).optional(), // amount
  rating: z.number().int().min(1).max(5).nullable().optional(), // edit
  reviewerName: z.string().max(120).optional(),
  reviewText: z.string().max(4000).optional(),
  reviewUrl: z.string().max(1000).optional(),
  reviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// PATCH — operator actions on one review. Money-bearing fields are locked once
// the review is in a payout or paid: remove it from the payout first.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!isOps(session?.user?.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad-body" }, { status: 400 });
  const { id, action } = parsed.data;

  const review = await prisma.review.findUnique({ where: { id } });
  if (!review) return NextResponse.json({ error: "not-found" }, { status: 404 });
  const locked = review.paymentStatus === "IN_PAYOUT" || review.paymentStatus === "PAID";
  const aud = (act: string, detail: Record<string, unknown>) =>
    audit({ actorId: session!.user!.id ?? null, actorRole: session!.user!.role ?? null, action: act, entityType: "Review", entityId: id, detail });

  if (action === "match") {
    if (locked) return NextResponse.json({ error: "locked", hint: "Remove from the payout first." }, { status: 409 });
    const match = await lookupBookingReference(parsed.data.bookingReference || "");
    if (!match.found) return NextResponse.json({ error: "booking-not-found" }, { status: 404 });
    await prisma.review.update({
      where: { id },
      data: {
        bookingReference: normalizeBookingRef(parsed.data.bookingReference),
        bookingId: match.bookingId, guideId: match.guideId ?? null, tourId: match.tourId ?? null,
        tourDate: match.tourDate ?? null, slotIdx: match.slotIdx ?? null, jobSheetRef: match.jobSheetRef ?? null,
        matchStatus: match.guideId ? "MATCHED" : "UNMATCHED",
        reviewerName: review.reviewerName ?? match.guestName ?? null,
      },
    });
    await aud("review.matched", { from: { guideId: review.guideId, matchStatus: review.matchStatus }, to: { guideId: match.guideId, jobSheetRef: match.jobSheetRef }, via: "booking-reference" });
    return NextResponse.json({ ok: true, matched: Boolean(match.guideId), guideAmbiguous: match.guideAmbiguous });
  }

  if (action === "setGuide") {
    if (locked) return NextResponse.json({ error: "locked", hint: "Remove from the payout first." }, { status: 409 });
    const guideId = parsed.data.guideId || "";
    const guide = await prisma.user.findFirst({ where: { guideId }, select: { id: true } });
    if (!guide) return NextResponse.json({ error: "guide-not-found" }, { status: 404 });
    // Manual pick: the operator confirms the guide (ambiguous split slot, or a
    // review with no booking ref). Job linkage stays as-is — optional by design.
    await prisma.review.update({ where: { id }, data: { guideId, matchStatus: "MATCHED" } });
    await aud("review.matched", { from: { guideId: review.guideId, matchStatus: review.matchStatus }, to: { guideId }, via: "manual" });
    return NextResponse.json({ ok: true, matched: true });
  }

  if (action === "amount") {
    if (locked) return NextResponse.json({ error: "locked", hint: "Remove from the payout first." }, { status: 409 });
    const amount = money2(parsed.data.incentiveAmount ?? NaN);
    if (!(amount >= 0)) return NextResponse.json({ error: "bad-amount" }, { status: 400 });
    await prisma.review.update({ where: { id }, data: { incentiveAmount: amount } });
    await aud("review.updated", { field: "incentiveAmount", from: review.incentiveAmount, to: amount });
    return NextResponse.json({ ok: true });
  }

  if (action === "edit") {
    const data: Record<string, unknown> = {};
    if (parsed.data.rating !== undefined) data.rating = parsed.data.rating;
    if (parsed.data.reviewerName !== undefined) data.reviewerName = parsed.data.reviewerName.trim() || null;
    if (parsed.data.reviewText !== undefined) data.reviewText = parsed.data.reviewText.trim() || null;
    if (parsed.data.reviewUrl !== undefined) data.reviewUrl = parsed.data.reviewUrl.trim() || null;
    if (parsed.data.reviewDate !== undefined) data.reviewDate = parsed.data.reviewDate;
    if (!Object.keys(data).length) return NextResponse.json({ error: "nothing-to-edit" }, { status: 400 });
    await prisma.review.update({ where: { id }, data });
    await aud("review.updated", { fields: Object.keys(data) });
    return NextResponse.json({ ok: true });
  }

  if (action === "void") {
    if (review.paymentStatus !== "UNPAID") return NextResponse.json({ error: "not-voidable", hint: "Only an UNPAID review can be voided." }, { status: 409 });
    await prisma.review.update({ where: { id }, data: { paymentStatus: "VOID" } });
    await aud("review.voided", { bookingReference: review.bookingReference, incentive: review.incentiveAmount });
    return NextResponse.json({ ok: true });
  }

  // unvoid
  if (review.paymentStatus !== "VOID") return NextResponse.json({ error: "not-void" }, { status: 409 });
  await prisma.review.update({ where: { id }, data: { paymentStatus: "UNPAID" } });
  await aud("review.updated", { field: "paymentStatus", from: "VOID", to: "UNPAID" });
  return NextResponse.json({ ok: true });
}
