// Operator resolution of a PAYMENT_NEEDS_REVIEW transaction: either CONFIRM (override
// the mismatch and mark the linked job sheet's tour Paid) or DISMISS (drop it from the
// queue without paying anything). Both are audited by the caller. Pure of HTTP; takes
// the prisma client so it is unit-testable with a mock.

import type { PrismaClient } from "@prisma/client";

export type ReviewAction = "confirm" | "dismiss";

export type ResolveReviewInput = {
  id: string; // PaymentTransaction id
  action: ReviewAction;
  note?: string | null;
  actorId?: string | null;
};

export type ResolveReviewResult =
  | { ok: true; status: string; markedPaid: boolean }
  | { ok: false; error: "not-found" | "already-resolved" | "no-linked-sheet" | "sheet-missing" };

function withResolution(details: unknown, action: ReviewAction, actorId: string | null | undefined, note: string | null | undefined, at: Date) {
  const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
  return { ...base, resolution: action === "confirm" ? "confirmed" : "dismissed", resolvedBy: actorId ?? null, resolvedAt: at.toISOString(), resolutionNote: note ?? null };
}

export async function resolveReview(prisma: PrismaClient, input: ResolveReviewInput): Promise<ResolveReviewResult> {
  const txn = await prisma.paymentTransaction.findUnique({
    where: { id: input.id },
    select: { id: true, validationStatus: true, matchedJobSheetId: true, validationDetails: true },
  });
  if (!txn) return { ok: false, error: "not-found" };
  // Only items still awaiting a decision can be resolved (idempotency guard).
  if (txn.validationStatus !== "PAYMENT_NEEDS_REVIEW") return { ok: false, error: "already-resolved" };

  const now = new Date();

  if (input.action === "dismiss") {
    await prisma.paymentTransaction.update({
      where: { id: txn.id },
      data: {
        validationStatus: "DISMISSED",
        validationDetails: withResolution(txn.validationDetails, "dismiss", input.actorId, input.note, now),
      },
    });
    return { ok: true, status: "DISMISSED", markedPaid: false };
  }

  // confirm: requires a linked job sheet to know what to mark Paid.
  if (!txn.matchedJobSheetId) return { ok: false, error: "no-linked-sheet" };

  return await prisma.$transaction(async (tx) => {
    const js = await tx.jobSheet.findUnique({
      where: { id: txn.matchedJobSheetId! },
      select: { guideId: true, date: true, slotIdx: true, tourId: true },
    });
    if (!js) return { ok: false as const, error: "sheet-missing" as const };

    await tx.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId: js.guideId, date: js.date, slotIdx: js.slotIdx } },
      create: { guideId: js.guideId, date: js.date, slotIdx: js.slotIdx, tourId: js.tourId, status: "PAID", paidAt: now },
      update: { status: "PAID", paidAt: now },
    });

    await tx.paymentTransaction.update({
      where: { id: txn.id },
      data: {
        validationStatus: "MATCHED",
        memoValidationStatus: "MATCHED",
        validationDetails: withResolution(txn.validationDetails, "confirm", input.actorId, input.note, now),
      },
    });

    return { ok: true as const, status: "MATCHED", markedPaid: true };
  });
}
