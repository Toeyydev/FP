// Operator resolution of a PAYMENT_NEEDS_REVIEW transaction:
//  - CONFIRM: mark the linked job sheet's tour Paid and set the txn MATCHED. The sheet
//    is either the one the matcher already found (matchedJobSheetId) or, for a slip whose
//    memo never resolved, a job number the operator types in now (jobNo).
//  - DISMISS: drop it from the queue without paying anything.
// Both are audited by the caller. Pure of HTTP; takes the prisma client so it is
// unit-testable with a mock.

import type { PrismaClient } from "@prisma/client";

export type ReviewAction = "confirm" | "dismiss";

export type ResolveReviewInput = {
  id: string; // PaymentTransaction id
  action: ReviewAction;
  jobNo?: string | null; // operator-supplied FOLK-BKK-… when the slip wasn't auto-matched
  note?: string | null;
  actorId?: string | null;
};

export type ResolveReviewResult =
  | { ok: true; status: string; markedPaid: boolean }
  | { ok: false; error: "not-found" | "already-resolved" | "no-linked-sheet" | "job-not-found" | "job-ambiguous" };

function withResolution(details: unknown, action: ReviewAction, actorId: string | null | undefined, note: string | null | undefined, at: Date, manualJobNo?: string | null) {
  const base = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
  return {
    ...base,
    resolution: action === "confirm" ? "confirmed" : "dismissed",
    resolvedBy: actorId ?? null,
    resolvedAt: at.toISOString(),
    resolutionNote: note ?? null,
    ...(manualJobNo ? { manualJobNo } : {}),
  };
}

export async function resolveReview(prisma: PrismaClient, input: ResolveReviewInput): Promise<ResolveReviewResult> {
  const txn = await prisma.paymentTransaction.findUnique({
    where: { id: input.id },
    select: { id: true, validationStatus: true, matchedJobSheetId: true, matchedJobNo: true, validationDetails: true },
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

  // confirm: need a job sheet to know what to mark Paid — the matched one, or a job
  // number the operator supplies now.
  const manualJobNo = !txn.matchedJobSheetId ? (input.jobNo?.trim() || null) : null;
  if (!txn.matchedJobSheetId && !manualJobNo) return { ok: false, error: "no-linked-sheet" };

  return await prisma.$transaction(async (tx) => {
    let sheet: { id: string; guideId: string; date: string; slotIdx: number; tourId: string; ref: string | null } | null;

    if (txn.matchedJobSheetId) {
      sheet = await tx.jobSheet.findUnique({
        where: { id: txn.matchedJobSheetId },
        select: { id: true, guideId: true, date: true, slotIdx: true, tourId: true, ref: true },
      });
      if (!sheet) return { ok: false as const, error: "job-not-found" as const };
    } else {
      const sheets = await tx.jobSheet.findMany({
        where: { ref: manualJobNo! },
        select: { id: true, guideId: true, date: true, slotIdx: true, tourId: true, ref: true },
      });
      if (sheets.length === 0) return { ok: false as const, error: "job-not-found" as const };
      if (sheets.length > 1) return { ok: false as const, error: "job-ambiguous" as const };
      sheet = sheets[0];
    }

    await tx.tourPayment.upsert({
      where: { guideId_date_slotIdx: { guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx } },
      create: { guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, tourId: sheet.tourId, status: "PAID", paidAt: now },
      update: { status: "PAID", paidAt: now },
    });

    await tx.paymentTransaction.update({
      where: { id: txn.id },
      data: {
        validationStatus: "MATCHED",
        memoValidationStatus: "MATCHED",
        matchedJobSheetId: sheet.id,
        matchedJobNo: sheet.ref ?? manualJobNo,
        validationDetails: withResolution(txn.validationDetails, "confirm", input.actorId, input.note, now, manualJobNo),
      },
    });

    return { ok: true as const, status: "MATCHED", markedPaid: true };
  });
}
