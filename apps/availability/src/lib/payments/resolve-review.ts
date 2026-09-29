// Operator resolution of a PAYMENT_NEEDS_REVIEW transaction:
//  - CONFIRM: mark the linked job sheet's tour Paid and set the txn MATCHED. The sheet
//    is either the one the matcher already found (matchedJobSheetId) or, for a slip whose
//    memo never resolved, a job number the operator types in now (jobNo).
//  - DISMISS: drop it from the queue without paying anything.
// Both are audited by the caller. Pure of HTTP; takes the prisma client so it is
// unit-testable with a mock.

import type { PrismaClient } from "@prisma/client";
import { audit } from "@/lib/audit";
import { recordPaymentInTx } from "@/lib/payments-v2/service";

export type ReviewAction = "confirm" | "dismiss";

export type ResolveReviewInput = {
  id: string; // PaymentTransaction id
  action: ReviewAction;
  jobNo?: string | null; // operator-supplied FOLK-BKK-… when the slip wasn't auto-matched
  guideId?: string | null;
  slotIdx?: number | null;
  note?: string | null;
  actorId?: string | null;
};

export type ResolveReviewResult =
  | { ok: true; status: string; markedPaid: boolean; paymentNo?: string | null }
  | { ok: false; error: "not-found" | "already-resolved" | "no-linked-sheet" | "job-not-found" | "job-ambiguous" }
  /** The slip is real, but the payment rules refuse it (already paid, unapproved, no date…). */
  | { ok: false; error: "payment-refused"; reasons: string[] };

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

/** The Bangkok calendar date of an instant — the day the bank moved the money. */
const bangkokDate = (d: Date) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

export async function resolveReview(prisma: PrismaClient, input: ResolveReviewInput): Promise<ResolveReviewResult> {
  const pendingAudits: Parameters<typeof audit>[0][] = [];
  const txn = await prisma.paymentTransaction.findUnique({
    where: { id: input.id },
    select: {
      id: true, validationStatus: true, matchedJobSheetId: true, matchedJobNo: true, validationDetails: true,
      paidAt: true, transferAmount: true, transactionId: true,
      evidence: { select: { id: true, driveLink: true } },
    },
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

  const result = await prisma.$transaction(async (tx) => {
    let sheet: { id: string; guideId: string; date: string; slotIdx: number; tourId: string; ref: string | null } | null;

    if (txn.matchedJobSheetId) {
      sheet = await tx.jobSheet.findUnique({
        where: { id: txn.matchedJobSheetId },
        select: { id: true, guideId: true, date: true, slotIdx: true, tourId: true, ref: true },
      });
      if (!sheet) return { ok: false as const, error: "job-not-found" as const };
    } else {
      const sheets = await tx.jobSheet.findMany({
        where: { ref: manualJobNo!, ...(input.guideId ? { guideId: input.guideId } : {}), ...(input.slotIdx != null ? { slotIdx: input.slotIdx } : {}) },
        select: { id: true, guideId: true, date: true, slotIdx: true, tourId: true, ref: true },
      });
      if (sheets.length === 0) return { ok: false as const, error: "job-not-found" as const };
      if (sheets.length > 1) return { ok: false as const, error: "job-ambiguous" as const };
      sheet = sheets[0];
    }

    // Confirming a slip pays its job the one canonical way: a payment record (Payments v2)
    // dated by the bank, with this slip as its evidence. The rules still apply — an already
    // paid or unapproved job is refused here too, and nothing is marked paid.
    const paymentDate = txn.paidAt ? bangkokDate(txn.paidAt) : null;
    const amount = txn.transferAmount == null ? null : Number(txn.transferAmount);
    if (!sheet.ref) return { ok: false as const, error: "payment-refused" as const, reasons: ["The job sheet has no Job No. — a payment names the full Job No."] };
    if (!paymentDate) return { ok: false as const, error: "payment-refused" as const, reasons: ["The slip has no transfer date — add it to the slip, or record the payment by hand"] };
    if (amount == null) return { ok: false as const, error: "payment-refused" as const, reasons: ["The slip has no amount — record this payment by hand"] };
    const recorded = await recordPaymentInTx(tx, {
      guideId: sheet.guideId, jobs: [{ jobNo: sheet.ref, date: sheet.date, slotIdx: sheet.slotIdx }],
      paymentDate, amountTransferred: amount, source: "SLIP_REVIEW",
      slip: { url: txn.evidence?.driveLink ?? "", evidenceId: txn.evidence?.id ?? null, uploadedAt: new Date(), uploadedById: input.actorId ?? null },
      bankRef: txn.transactionId, note: input.note ?? "Confirmed from the payment slips queue",
      actor: { actorId: input.actorId ?? null, actorRole: null },
    });
    if (!recorded.ok) return { ok: false as const, error: "payment-refused" as const, reasons: recorded.reasons };
    pendingAudits.push(...recorded.audits);

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

    return { ok: true as const, status: "MATCHED", markedPaid: true, paymentNo: recorded.payment.paymentNo };
  });
  for (const a of pendingAudits) await audit(a);
  return result;
}
