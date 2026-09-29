// The advance ledger's rules — pure, no database, no network.
//
// An advance is money the company handed a guide before a tour. It is not a fee and
// not an expense: it is a balance the guide owes back, settled by what they spent
// (from the approved job sheet), by money they transfer back, or by deducting it
// from a payment they are owed.
//
// Two numbers hold the whole model:
//   outstanding(advance) = amountSatang − settledSatang        settledSatang = Σ entries
//   unallocated(receipt) = amountSatang − allocatedSatang      allocatedSatang = Σ its entries
//
// Signs are the invariant everything else rests on: every entry EXCEPT a reversal is
// strictly positive (it settles), and a reversal is exactly the negative of the entry
// it reverses. That is why a reversal can never be refused — it only ever lowers a
// counter that its own target raised. It is also why CORRECTION may not be negative:
// reversing a negative correction would have to ADD to the balance, and could then be
// blocked by a settlement that happened in between (see the proof in the tests).
import { toSatang } from "@/lib/payments-v2/rules";

export { toSatang };
export const fromSatang = (v: number) => Math.round(v) / 100;

export const ENTRY_TYPES = ["EXPENSE_SETTLEMENT", "RETURN_ALLOCATION", "PAYMENT_DEDUCTION", "CORRECTION", "REVERSAL"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
/** Everything that settles. A reversal is the only type that may be negative. */
export const SETTLING_TYPES = ENTRY_TYPES.filter((t) => t !== "REVERSAL");

export const ENTRY_LABEL: Record<EntryType, string> = {
  EXPENSE_SETTLEMENT: "Expenses settled",
  RETURN_ALLOCATION: "Guide returned",
  PAYMENT_DEDUCTION: "Deducted from a payment",
  CORRECTION: "Correction",
  REVERSAL: "Reversed",
};

export const RECEIPT_STATUSES = ["CLAIMED", "VERIFIED", "REJECTED"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export type AdvanceStatus = "OPEN" | "PARTIALLY_SETTLED" | "SETTLED" | "REVERSED";

export const MIN_REASON = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (s: string | null | undefined) => !(s ?? "").trim();

export function advanceStatus(a: { amountSatang: number; settledSatang: number; reversedAt?: Date | null }): AdvanceStatus {
  if (a.reversedAt) return "REVERSED";
  if (a.settledSatang <= 0) return "OPEN";
  if (a.settledSatang >= a.amountSatang) return "SETTLED";
  return "PARTIALLY_SETTLED";
}

export const outstandingSatang = (a: { amountSatang: number; settledSatang: number }) => a.amountSatang - a.settledSatang;
export const unallocatedSatang = (r: { amountSatang: number; allocatedSatang: number }) => r.amountSatang - r.allocatedSatang;

/** FOLK-ADV-YYYYMM-NNN / FOLK-ADR-YYYYMM-NNN — the month of the real money movement. */
export const advanceNoFor = (date: string, seq: number) => `FOLK-ADV-${date.slice(0, 7).replace("-", "")}-${String(seq).padStart(3, "0")}`;
export const receiptNoFor = (date: string, seq: number) => `FOLK-ADR-${date.slice(0, 7).replace("-", "")}-${String(seq).padStart(3, "0")}`;
export const periodOf = (date: string) => date.slice(0, 7);

/** The ledger's own idempotency: one operator action writes one entry per advance. */
export const idempotencyKeyFor = (requestKey: string, advanceId: string) => `${requestKey}:${advanceId}`;

export type IssueAdvanceInput = {
  guideId: string;
  advanceDate: string;
  amount: number;
  jobNo?: string | null;
  purpose?: string | null;
  method?: string | null;
  bankRef?: string | null;
  note?: string | null;
  /** Bangkok "today", so a transfer cannot be dated in the future. */
  today: string;
};

export function checkIssueAdvance(input: IssueAdvanceInput): string[] {
  const reasons: string[] = [];
  if (blank(input.guideId)) reasons.push("Choose the guide the money went to");
  if (!DATE.test(input.advanceDate ?? "")) reasons.push("Give the date the money left the bank (YYYY-MM-DD)");
  else if (input.advanceDate > input.today) reasons.push(`${input.advanceDate} is in the future — an advance is recorded after the transfer, not before`);
  const satang = Number.isFinite(input.amount) ? toSatang(input.amount) : NaN;
  if (!Number.isFinite(satang) || satang <= 0) reasons.push("Enter the amount transferred, in baht");
  else if (Math.abs(input.amount * 100 - satang) > 1e-6) reasons.push("The amount may have at most two decimal places");
  return reasons;
}

export type ReceiptInput = {
  guideId: string;
  receivedDate: string;
  amount: number;
  bankRef?: string | null;
  method?: string | null;
  note?: string | null;
  today: string;
  /** A guide filing it from the app can only ever CLAIM. */
  byGuide: boolean;
};

export function checkReceipt(input: ReceiptInput): string[] {
  const reasons: string[] = [];
  if (blank(input.guideId)) reasons.push("Choose the guide the money came from");
  if (!DATE.test(input.receivedDate ?? "")) reasons.push("Give the date the money reached the company bank (YYYY-MM-DD)");
  else if (input.receivedDate > input.today) reasons.push(`${input.receivedDate} is in the future — record a return once the money has arrived`);
  const satang = Number.isFinite(input.amount) ? toSatang(input.amount) : NaN;
  if (!Number.isFinite(satang) || satang <= 0) reasons.push("Enter the amount returned, in baht");
  else if (Math.abs(input.amount * 100 - satang) > 1e-6) reasons.push("The amount may have at most two decimal places");
  return reasons;
}

/**
 * Confirming that a return reached the company account needs the reference of the line on
 * the company bank statement that shows it. Without one, "confirmed" would only record that
 * someone clicked — not what they saw.
 */
export function checkConfirmation(bankRef: string | null | undefined): string[] {
  const ref = (bankRef ?? "").trim();
  if (!ref) return ["Enter the reference of the company bank statement line that shows this money arrived"];
  if (ref.length < 4) return ["That bank statement reference is too short to identify the transfer"];
  return [];
}

export type AllocationRequest = { advanceId: string; amount: number };

/**
 * Everything that can be decided about an allocation without touching the database.
 * The amounts are checked again inside the transaction against the live counters —
 * this only refuses what is already wrong on its face.
 */
export function checkAllocations(input: {
  receipt: { guideId: string; status: ReceiptStatus; amountSatang: number; allocatedSatang: number };
  advances: { id: string; guideId: string; amountSatang: number; settledSatang: number; reversedAt?: Date | null }[];
  allocations: AllocationRequest[];
}): string[] {
  const reasons: string[] = [];
  const { receipt, allocations } = input;
  if (receipt.status !== "VERIFIED") {
    reasons.push(receipt.status === "CLAIMED"
      ? "This return is still waiting to be checked — confirm the money reached the bank before allocating it"
      : "This return was rejected and cannot be allocated");
  }
  if (!allocations.length) reasons.push("Choose at least one advance to allocate this return to");
  const seen = new Set<string>();
  let total = 0;
  for (const [i, a] of allocations.entries()) {
    const n = `Line ${i + 1}`;
    const satang = Number.isFinite(a.amount) ? toSatang(a.amount) : NaN;
    if (!Number.isFinite(satang) || satang <= 0) { reasons.push(`${n}: enter an amount in baht`); continue; }
    if (seen.has(a.advanceId)) { reasons.push(`${n}: that advance is already on this return — put it on one line`); continue; }
    seen.add(a.advanceId);
    const adv = input.advances.find((x) => x.id === a.advanceId);
    if (!adv) { reasons.push(`${n}: no such advance`); continue; }
    if (adv.guideId !== receipt.guideId) { reasons.push(`${n}: that advance belongs to another guide — a return can only clear the advances of the guide who sent it`); continue; }
    if (adv.reversedAt) { reasons.push(`${n}: that advance was reversed and no longer holds a balance`); continue; }
    const left = outstandingSatang(adv);
    if (satang > left) reasons.push(`${n}: only ${fromSatang(left).toLocaleString()} is outstanding on that advance`);
    total += satang;
  }
  const free = unallocatedSatang(receipt);
  if (total > free) reasons.push(`This return has ${fromSatang(free).toLocaleString()} left to allocate, but the lines add up to ${fromSatang(total).toLocaleString()}`);
  return reasons;
}

/** A deduction inside a payment, checked before the transaction opens. */
export function checkDeduction(input: {
  guideId: string;
  advance: { id: string; guideId: string; amountSatang: number; settledSatang: number; reversedAt?: Date | null } | null;
  amountSatang: number;
}): string[] {
  const reasons: string[] = [];
  if (!input.advance) return ["No such advance"];
  if (input.advance.guideId !== input.guideId) reasons.push("That advance belongs to another guide — a payment can only settle the advances of the guide it pays");
  if (input.advance.reversedAt) reasons.push("That advance was reversed and no longer holds a balance");
  if (!(input.amountSatang > 0)) reasons.push("An advance settlement must be a positive amount of the advance");
  else {
    const left = outstandingSatang(input.advance);
    if (input.amountSatang > left) reasons.push(`Only ${fromSatang(left).toLocaleString()} is outstanding on that advance`);
  }
  return reasons;
}

export function checkReversal(entry: { type: EntryType; reversedByEntryId?: string | null } | null, reason: string): string[] {
  const reasons: string[] = [];
  if (!entry) return ["No such ledger entry"];
  if (entry.type === "REVERSAL") reasons.push("A reversal cannot itself be reversed — record the settlement again instead, as what actually happened");
  // The payment still shows this deduction and the guide really was paid that much less.
  // Undoing only the ledger side would make the two disagree, so it is undone with the
  // payment or not at all.
  if (entry.type === "PAYMENT_DEDUCTION") reasons.push("A deduction is part of a payment — reverse the payment itself, which gives the advance its balance back in the same step");
  if (entry.reversedByEntryId) reasons.push("That entry has already been reversed");
  if ((reason ?? "").trim().length < MIN_REASON) reasons.push("Give the reason this entry is being reversed");
  return reasons;
}

/** What the operator sees before confirming, in baht. */
export function balanceLine(a: { amountSatang: number; settledSatang: number }, deltaSatang = 0) {
  const after = a.settledSatang + deltaSatang;
  return {
    amount: fromSatang(a.amountSatang),
    settled: fromSatang(a.settledSatang),
    outstanding: fromSatang(a.amountSatang - a.settledSatang),
    change: fromSatang(deltaSatang),
    outstandingAfter: fromSatang(a.amountSatang - after),
    withinBounds: after >= 0 && after <= a.amountSatang,
  };
}
