// Guide-advance settlement math. Pure functions shared by the Job Sheet UI and the
// advance API. The accounting rule: an ADVANCE is a cash movement, never an expense;
// a RETURN is never a negative expense. Actual spend lives in the sheet's expense
// rows whose paidBy is "advance", and:
//   outstanding = advances paid − expenses paid from advance − money returned.
import { expenseAmount, type Expense } from "@/lib/jobsheet";

// UI "Payment Source" per expense row maps onto the EXISTING Expense.paidBy field:
//   "company" (default, also legacy rows with paidBy unset/operator) · "advance"
//   (paid with the guide's advance money) · "guide" (guide's personal money).
// "Paid by" (แหล่งเงินที่ใช้ชำระ) — the source of money used for an expense line.
// Internal values stay company/advance/guide (per-sheet JSON; no migration):
//   company → Company Direct (บริษัทชำระโดยตรง)
//   advance → Guide Advance (ชำระจากเงินทดรองจ่าย) — counts toward Advance Used
//   guide   → Guide Personal (มัคคุเทศก์สำรองจ่าย) — counts toward Reimbursement Due
export const PAYMENT_SOURCES = [
  { value: "company", label: "Company Direct", th: "บริษัทชำระโดยตรง" },
  { value: "advance", label: "Guide Advance", th: "ชำระจากเงินทดรองจ่าย" },
  { value: "guide", label: "Guide Personal", th: "มัคคุเทศก์สำรองจ่าย" },
] as const;
export const isAdvanceExpense = (e: Pick<Expense, "paidBy">): boolean => e.paidBy === "advance";

export type AdvanceLike = { amount: number };
export type AdvanceTotals = {
  totalAdvancePaid: number;
  usedFromAdvance: number; // sum of expense rows with paidBy = "advance"
  totalReturned: number;
  outstanding: number;
};

// Satang-precision rounding so float sums (e.g. 0.1+0.2) never leave a phantom
// balance that blocks "Settled".
const r2 = (v: number) => Math.round(v * 100) / 100;

export function advanceTotals(advances: AdvanceLike[], returns: AdvanceLike[], expenses: Expense[]): AdvanceTotals {
  const totalAdvancePaid = r2((advances ?? []).reduce((s, a) => s + (a.amount || 0), 0));
  const usedFromAdvance = r2((expenses ?? []).filter(isAdvanceExpense).reduce((s, e) => s + expenseAmount(e), 0));
  const totalReturned = r2((returns ?? []).reduce((s, a) => s + (a.amount || 0), 0));
  return { totalAdvancePaid, usedFromAdvance, totalReturned, outstanding: r2(totalAdvancePaid - usedFromAdvance - totalReturned) };
}

// NOT_REQUIRED — no advance issued · OPEN — advance out, tour not completed yet ·
// PENDING_SETTLEMENT — tour done, money still outstanding · SETTLED — balance zero ·
// OVER_RETURNED — more came back than was outstanding: never silently accepted,
// the UI must show a review warning.
export type AdvanceStatus = "NOT_REQUIRED" | "OPEN" | "PENDING_SETTLEMENT" | "SETTLED" | "OVER_RETURNED";

export function advanceStatus(t: AdvanceTotals, tourCompleted: boolean): AdvanceStatus {
  if (t.totalAdvancePaid <= 0) return "NOT_REQUIRED";
  if (t.outstanding < 0) return "OVER_RETURNED";
  if (t.outstanding === 0) return "SETTLED";
  return tourCompleted ? "PENDING_SETTLEMENT" : "OPEN";
}

export const ADVANCE_STATUS_LABEL: Record<AdvanceStatus, string> = {
  NOT_REQUIRED: "No Advance · ไม่มีเงินทดรองจ่าย",
  OPEN: "Open · ระหว่างงาน",
  PENDING_SETTLEMENT: "Pending Settlement · รอเคลียร์เงินทดรอง",
  SETTLED: "Settled · เคลียร์เงินทดรองแล้ว",
  OVER_RETURNED: "Review Required · ต้องตรวจสอบ (คืนเกิน)",
};
