// Review-incentive domain: a customer review earns the guide a bonus separate
// from the job sheet. The OTA booking reference is the lookup key — booking →
// job (date+slot) → assigned guide — and the review row is the financial
// record. Pure helpers first (unit-tested); DB services at the bottom.

import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { bookingRef } from "@/lib/booking-ref";

export const REVIEW_MATCH_STATUSES = ["MATCHED", "UNMATCHED"] as const;
export const REVIEW_PAYMENT_STATUSES = ["UNPAID", "IN_PAYOUT", "PAID", "VOID"] as const;
export const REVIEW_PAYOUT_STATUSES = ["DRAFT", "PAID", "CANCELLED"] as const;
export const REVIEW_SOURCES = ["GETYOURGUIDE", "VIATOR", "GOOGLE", "TRIPADVISOR", "OTHER"] as const;

// Default incentive per review (THB). Env-overridable without a deploy.
export function defaultIncentiveAmount(): number {
  const n = Number(process.env.REVIEW_INCENTIVE_DEFAULT_THB);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

// OTA refs are typed/pasted by hand — normalize before any lookup or dedup:
// uppercase, no whitespace. "gyg2q9gl5q49 " and "GYG2Q9GL5Q49" are one booking.
export function normalizeBookingRef(s: string | null | undefined): string {
  return (s || "").replace(/\s+/g, "").toUpperCase();
}

// A review may join a payout only when the money can actually be paid: a guide
// is confirmed (matched) and the incentive isn't already in-flight/paid/void.
export function canJoinPayout(r: { matchStatus: string; paymentStatus: string; guideId: string | null }): boolean {
  return r.matchStatus === "MATCHED" && r.paymentStatus === "UNPAID" && Boolean(r.guideId);
}

// Duplicate rule (spec §13): same booking reference + same source is the same
// review — warn, never silently create. reviewDate equality is reported so the
// operator can tell a true duplicate from a rare second review on one booking.
export function isDuplicateReview(
  a: { bookingReference: string | null; source: string; reviewDate: string },
  b: { bookingReference: string | null; source: string; reviewDate: string },
): { duplicate: boolean; sameDate: boolean } {
  const ra = normalizeBookingRef(a.bookingReference), rb = normalizeBookingRef(b.bookingReference);
  const duplicate = Boolean(ra) && ra === rb && a.source === b.source;
  return { duplicate, sameDate: duplicate && a.reviewDate === b.reviewDate };
}

// FOLK-RR-YYYYMMDD-NN — the review-payout reference (RR = review reward).
export function makePayoutRef(date: string, seq: number): string {
  return `FOLK-RR-${date.replace(/-/g, "")}-${String(seq).padStart(2, "0")}`;
}

// Which guide ran the booking's departure? Booking.assignedGuideId wins (split
// slots tag each booking); otherwise the slot's assignments decide — exactly one
// guide → that guide; several guides with untagged bookings → ambiguous, return
// null and let the operator pick (never guess, spec §3).
export function resolveGuideForBooking(
  booking: { assignedGuideId: string | null },
  assignmentsAtSlot: { guideId: string }[],
): string | null {
  if (booking.assignedGuideId) return booking.assignedGuideId;
  const distinct = [...new Set(assignmentsAtSlot.map((a) => a.guideId))];
  return distinct.length === 1 ? distinct[0] : null;
}

export const money2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

// ── DB services ─────────────────────────────────────────────────────────────

// Next unused payout ref for a date (max-suffix + skip-taken, like nextJobRef).
export async function nextPayoutRef(date: string): Promise<string> {
  const stamp = date.replace(/-/g, "");
  const rows = await prisma.reviewPayout.findMany({ where: { ref: { startsWith: `FOLK-RR-${stamp}-` } }, select: { ref: true } });
  const used = new Set(rows.map((r) => r.ref));
  let seq = 0;
  for (const r of rows) { const m = r.ref.match(/-(\d{2,})$/); if (m) seq = Math.max(seq, parseInt(m[1], 10)); }
  let ref = makePayoutRef(date, ++seq);
  while (used.has(ref)) ref = makePayoutRef(date, ++seq);
  return ref;
}

export type BookingLookup = {
  found: boolean;
  bookingId?: string;
  bookingReference?: string;
  guestName?: string | null;
  bookingSource?: string;
  tourId?: string | null;
  tourName?: string | null;
  tourDate?: string | null;
  slotIdx?: number | null;
  guideId?: string | null;
  guideName?: string | null;
  jobSheetRef?: string | null;
  guideAmbiguous?: { guideId: string; name: string }[]; // several guides, untagged booking
};

// bookingReference → Booking → job → guide. The heart of the module: the
// operator (or a future email worker) supplies only the OTA ref.
export async function lookupBookingReference(refRaw: string): Promise<BookingLookup> {
  const ref = normalizeBookingRef(refRaw);
  if (!ref) return { found: false };
  const booking = await prisma.booking.findFirst({
    where: {
      status: { notIn: ["CANCELLED", "IGNORED"] },
      OR: [{ externalRef: { equals: ref, mode: "insensitive" } }, { confirmationCode: { equals: ref, mode: "insensitive" } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!booking) return { found: false };

  const date = booking.date, slotIdx = booking.slotIdx;
  const assigns = date != null && slotIdx != null
    ? await prisma.assignment.findMany({ where: { date, slotIdx }, select: { guideId: true } })
    : [];
  const guideId = resolveGuideForBooking(booking, assigns);
  const [sheet, tour, guide, candidates] = await Promise.all([
    guideId && date && slotIdx != null
      ? prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId, date, slotIdx } }, select: { ref: true } })
      : Promise.resolve(null),
    booking.tourId ? prisma.tour.findUnique({ where: { id: booking.tourId }, select: { name: true } }) : Promise.resolve(null),
    guideId ? prisma.user.findFirst({ where: { guideId }, select: { displayName: true } }) : Promise.resolve(null),
    !guideId && assigns.length > 1
      ? prisma.user.findMany({ where: { guideId: { in: [...new Set(assigns.map((a) => a.guideId))] } }, select: { guideId: true, displayName: true } })
      : Promise.resolve([]),
  ]);

  return {
    found: true,
    bookingId: booking.id,
    bookingReference: bookingRef(booking.externalRef, booking.confirmationCode) || ref,
    guestName: booking.customerName,
    bookingSource: booking.source,
    tourId: booking.tourId,
    tourName: tour?.name ?? booking.productName ?? null,
    tourDate: date,
    slotIdx,
    guideId,
    guideName: guide?.displayName ?? null,
    jobSheetRef: sheet?.ref ?? null,
    guideAmbiguous: candidates.length ? candidates.map((c) => ({ guideId: c.guideId!, name: c.displayName })) : undefined,
  };
}

export type CreateReviewInput = {
  bookingReference?: string | null;
  source?: string;
  reviewDate: string; // "YYYY-MM-DD"
  rating?: number | null;
  reviewerName?: string | null;
  reviewText?: string | null;
  reviewUrl?: string | null;
  incentiveAmount?: number | null;
  force?: boolean; // create despite a duplicate warning
  gmailMessageId?: string | null; // future email worker idempotency
  sourceReviewId?: string | null;
};

// Create a review, auto-matching from the booking reference. This is the single
// entry point for BOTH the operator UI and a future email-ingestion worker
// (spec §12) — the worker calls this with gmailMessageId/sourceReviewId set.
export async function createReviewFromInput(
  input: CreateReviewInput,
  actor: { id?: string | null; role?: string | null },
): Promise<{ review?: { id: string }; duplicate?: { id: string; reviewDate: string; sameDate: boolean } }> {
  const source = input.source || "GETYOURGUIDE";
  const ref = normalizeBookingRef(input.bookingReference);

  if (ref && !input.force) {
    const existing = await prisma.review.findFirst({
      where: { bookingReference: ref, source, paymentStatus: { not: "VOID" } },
      select: { id: true, reviewDate: true },
    });
    if (existing) return { duplicate: { id: existing.id, reviewDate: existing.reviewDate, sameDate: existing.reviewDate === input.reviewDate } };
  }

  const match = ref ? await lookupBookingReference(ref) : { found: false as const };
  const matched = match.found && Boolean(match.guideId);

  const review = await prisma.review.create({
    data: {
      bookingReference: ref || null,
      source,
      reviewDate: input.reviewDate,
      rating: input.rating ?? null,
      reviewerName: input.reviewerName?.trim() || (match.found ? match.guestName ?? null : null),
      reviewText: input.reviewText?.trim() || null,
      reviewUrl: input.reviewUrl?.trim() || null,
      incentiveAmount: money2(input.incentiveAmount ?? defaultIncentiveAmount()),
      bookingId: match.found ? match.bookingId ?? null : null,
      guideId: matched ? match.guideId! : null,
      tourId: match.found ? match.tourId ?? null : null,
      tourDate: match.found ? match.tourDate ?? null : null,
      slotIdx: match.found ? match.slotIdx ?? null : null,
      jobSheetRef: match.found ? match.jobSheetRef ?? null : null,
      matchStatus: matched ? "MATCHED" : "UNMATCHED",
      gmailMessageId: input.gmailMessageId || null,
      sourceReviewId: input.sourceReviewId || null,
      createdById: actor.id ?? null,
    },
  });
  await audit({
    actorId: actor.id ?? null, actorRole: actor.role ?? null, action: "review.created",
    entityType: "Review", entityId: review.id,
    detail: { bookingReference: ref || null, source, reviewDate: input.reviewDate, rating: input.rating ?? null, incentive: review.incentiveAmount, matchStatus: review.matchStatus, guideId: review.guideId, jobSheetRef: review.jobSheetRef },
  });
  return { review: { id: review.id } };
}
