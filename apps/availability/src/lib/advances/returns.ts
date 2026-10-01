// Money a guide sends back against a company advance — the rules, pure.
//
// Phase 1C (owner policy 2026-10-01). A return is a GuideAdvanceReceipt: evidence that money
// came back. Its status is only ever CLAIMED → VERIFIED (or REJECTED, or VOIDED). Whether it
// cleared an advance is not a status: that is a RETURN_ALLOCATION ledger entry, explicit and
// never automatic. A return is never revenue, a reimbursement, a guide payment, a
// supplemental payment or a negative expense — it settles company cash already advanced.
//
// The part of a return that exceeded what was owed (an over-return) stays UNALLOCATED and
// visible until an operator chooses: allocate it to another advance of the same guide, or pay
// it back to the guide (GuideAdvanceRefund: RECORDED → APPROVED → PAID, or VOIDED). Nothing
// carries it anywhere by itself.
//
//   unallocated = amount − live allocations − PAID refunds
//
// A refund only moves money when it is PAID, so only a paid refund reduces the balance. A
// refund still RECORDED or APPROVED holds nothing back in the books — but it is money an
// operator has decided to pay, so the service will not allocate or refund past it either
// (`available`).
export type ReceiptStatus = "CLAIMED" | "VERIFIED" | "REJECTED" | "VOIDED";
export type RefundStatus = "RECORDED" | "APPROVED" | "PAID" | "VOIDED";

export type ReturnProblem = "NEGATIVE_UNALLOCATED" | "ALLOCATED_COUNTER_DRIFT" | "REFUNDED_COUNTER_DRIFT";
export type ReturnSummary = {
  amount: number;       // satang
  allocated: number;    // live RETURN_ALLOCATION entries, net of reversals
  refunded: number;     // PAID refunds
  pendingRefunds: number; // RECORDED + APPROVED refunds — decided, not yet paid
  unallocated: number;  // amount − allocated − refunded, never clamped
  available: number;    // unallocated − pendingRefunds: what may still be allocated or refunded
  status: ReceiptStatus;
  problems: ReturnProblem[];
  ok: boolean;          // false → no further financial action until it is checked
};

export function returnSummary(
  receipt: { amountSatang: number; allocatedSatang?: number | null; refundedSatang?: number | null; status: string },
  allocations: readonly { id: string; type: string; amountSatang: number; reversesEntryId?: string | null; receiptId?: string | null }[],
  refunds: readonly { status: string; amountSatang: number }[],
): ReturnSummary {
  const byId = new Map(allocations.map((e) => [e.id, e]));
  let allocated = 0;
  for (const e of allocations) {
    if (e.type === "RETURN_ALLOCATION") allocated += e.amountSatang;
    else if (e.type === "REVERSAL" && e.reversesEntryId && byId.get(e.reversesEntryId)?.type === "RETURN_ALLOCATION") allocated += e.amountSatang; // negative
  }
  const refunded = refunds.filter((r) => r.status === "PAID").reduce((s, r) => s + r.amountSatang, 0);
  const pendingRefunds = refunds.filter((r) => r.status === "RECORDED" || r.status === "APPROVED").reduce((s, r) => s + r.amountSatang, 0);
  const amount = receipt.amountSatang;
  const unallocated = amount - allocated - refunded;
  const problems: ReturnProblem[] = [];
  if (unallocated < 0) problems.push("NEGATIVE_UNALLOCATED");
  if (receipt.allocatedSatang != null && receipt.allocatedSatang !== allocated) problems.push("ALLOCATED_COUNTER_DRIFT");
  if (receipt.refundedSatang != null && receipt.refundedSatang !== refunded) problems.push("REFUNDED_COUNTER_DRIFT");
  return {
    amount, allocated, refunded, pendingRefunds, unallocated, available: unallocated - pendingRefunds,
    status: receipt.status as ReceiptStatus, problems, ok: problems.length === 0,
  };
}

/**
 * Why a return may NOT be linked to this advance / job — empty when it may. Linking is
 * intent only: it records what the guide or operator said the money was for; allocation is
 * still a separate, explicit ledger entry.
 */
export function returnLinkProblems(
  receipt: { guideId: string },
  advance: { guideId: string; date: string; slotIdx: number; reversedAt?: Date | string | null; advanceNo: string } | null,
  sheet: { id: string; guideId: string; date: string; slotIdx: number } | null,
): string[] {
  const reasons: string[] = [];
  if (advance) {
    if (advance.guideId !== receipt.guideId) reasons.push(`${advance.advanceNo} belongs to another guide — a return can only be for the advances of the guide who sent it`);
    if (advance.reversedAt) reasons.push(`${advance.advanceNo} was reversed`);
  }
  if (sheet) {
    if (sheet.guideId !== receipt.guideId) reasons.push("That job sheet belongs to another guide");
    if (advance && (sheet.date !== advance.date || sheet.slotIdx !== advance.slotIdx || sheet.guideId !== advance.guideId)) reasons.push(`That job sheet is not the job ${advance.advanceNo} was issued for`);
  }
  return reasons;
}

export const MIN_REFUND_REASON = 8;
export const refundNoFor = (date: string, seq: number) => `FOLK-ADF-${date.slice(0, 7).replace("-", "")}-${String(seq).padStart(3, "0")}`;

/** The refund lifecycle. A paid refund is never voided here — undoing a transfer needs its own design. */
export const REFUND_NEXT: Record<RefundStatus, RefundStatus[]> = {
  RECORDED: ["APPROVED", "VOIDED"],
  APPROVED: ["PAID", "VOIDED"],
  PAID: [],
  VOIDED: [],
};
