// The guide's expense report: three fixed items, and the operator's review of them (owner 2026-11-15).
//
//   - A guide reports ONLY Water / Bus / Ferry (Inc. Guide) — what they paid with their own
//     money on tour. They cannot add, remove or rename an item. 0 / empty = not used.
//   - Entrance tickets are never a guide expense: they are Company ADV or company-paid, and the
//     guide only uploads their receipts (Ticket receipts). A ticket a guide paid with their own
//     money is not reportable by the guide — the operator handles that exception on the sheet.
//   - Food tours keep their one-figure food report (#375): FOOD_COST rows are accepted there.
//   - Each item maps to PEAK by its CATEGORY (Water → MEAL_REFRESHMENT, Bus/Ferry → TRANSPORTATION)
//     through the PEAK account mapping FolkOPS already holds — never by a code written here.
//
// The operator reviews each item: Approve (verified = reported), Approve with another amount
// (needs a reason) or Reject (needs a reason). Review fields live on the guide's report row;
// approving also writes the verified amount into the job's accounting row for that item.
//
// Pure — no imports beyond the sheet helpers — so every rule is testable.

import { STANDARD_EXPENSE_DESCRIPTIONS, FOOD_COST_DESCRIPTION, FOOD_COST_OVER_DESCRIPTION, standardExpenseDescription, expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";

export type FixedItemKey = "WATER" | "BUS" | "FERRY";
export const FIXED_ITEMS: readonly { key: FixedItemKey; description: string; expenseType: string; label: string; th: string }[] = [
  { key: "WATER", description: STANDARD_EXPENSE_DESCRIPTIONS[0].description, expenseType: STANDARD_EXPENSE_DESCRIPTIONS[0].expenseType, label: "Water", th: "น้ำดื่ม" },
  { key: "BUS", description: STANDARD_EXPENSE_DESCRIPTIONS[1].description, expenseType: STANDARD_EXPENSE_DESCRIPTIONS[1].expenseType, label: "Bus", th: "ค่ารถเมล์" },
  { key: "FERRY", description: STANDARD_EXPENSE_DESCRIPTIONS[2].description, expenseType: STANDARD_EXPENSE_DESCRIPTIONS[2].expenseType, label: "Ferry", th: "ค่าเรือ" },
];

/** Which fixed item a row is, by its (canonical or legacy short) description. */
export function fixedItemOf(row: Pick<Expense, "description"> | null | undefined): (typeof FIXED_ITEMS)[number] | null {
  const std = standardExpenseDescription(row?.description ?? "");
  return std ? FIXED_ITEMS.find((f) => f.description === std.description) ?? null : null;
}

export type ReviewStatus = "PENDING" | "APPROVED" | "ADJUSTED" | "REJECTED";
/** Review fields carried on a guide-report row. Never accepted from a guide. */
export type ReviewFields = {
  reviewStatus?: ReviewStatus; verifiedAmount?: number | null; reviewReason?: string | null;
  reviewedAt?: string | null; reviewedById?: string | null; reviewedOf?: number | null;
};
export type ReportRow = Expense & ReviewFields;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A guide's submitted lines → the rows stored, or why they are refused.
 * Non-food tour: only the three items, each at most once; zero lines dropped. Food tour: the
 * food rows as well. A previous review is kept only for an item whose amount did not change.
 */
export function normalizeGuideReport(lines: readonly Expense[], opts: { foodTour: boolean; previous?: readonly ReportRow[] | null }): { ok: true; rows: ReportRow[] } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const rows: ReportRow[] = [];
  for (const raw of lines) {
    if (isReviewExpense(raw)) continue; // never a guide's line; dropped as before
    const desc = (raw.description ?? "").trim();
    const amount = expenseAmount(raw);
    if (opts.foodTour && (desc === FOOD_COST_DESCRIPTION || desc === FOOD_COST_OVER_DESCRIPTION)) {
      if (amount > 0) rows.push({ ...stripReview(raw), description: desc, expenseType: "meal" });
      continue;
    }
    const item = fixedItemOf(raw);
    if (!item) {
      if (desc || amount > 0) reasons.push(`“${desc || "(no name)"}” cannot be reported — only Water, Bus and Ferry (Inc. Guide)${opts.foodTour ? " or the food total" : ""}. Entrance tickets go under Ticket receipts.`);
      continue;
    }
    if (seen.has(item.key)) { reasons.push(`${item.label} is listed twice — enter it once with the total quantity`); continue; }
    seen.add(item.key);
    if (!Number.isFinite(amount) || (Number(raw.price) || 0) < 0 || (Number(raw.pax) || 0) < 0) { reasons.push(`${item.label}: the price and quantity cannot be negative`); continue; }
    if (amount <= 0) continue; // 0 / empty = not used
    const row: ReportRow = { ...stripReview(raw), description: item.description, expenseType: item.expenseType };
    const prev = (opts.previous ?? []).find((p) => fixedItemOf(p)?.key === item.key);
    if (prev?.reviewStatus && prev.reviewStatus !== "PENDING" && r2(expenseAmount(prev)) === r2(amount)) Object.assign(row, pickReview(prev));
    rows.push(row);
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, rows };
}

function stripReview(e: Expense): Expense {
  const { reviewStatus: _a, verifiedAmount: _b, reviewReason: _c, reviewedAt: _d, reviewedById: _e, reviewedOf: _f, ...rest } = e as ReportRow;
  return rest as Expense;
}
const pickReview = (r: ReportRow): ReviewFields => ({ reviewStatus: r.reviewStatus, verifiedAmount: r.verifiedAmount ?? null, reviewReason: r.reviewReason ?? null, reviewedAt: r.reviewedAt ?? null, reviewedById: r.reviewedById ?? null, reviewedOf: r.reviewedOf ?? null });

/** The review state of one item on a guide's report (none reported → null). */
export function reviewOf(row: ReportRow | null | undefined): ReviewStatus | null {
  if (!row || expenseAmount(row) <= 0) return null;
  return row.reviewStatus ?? "PENDING";
}

export const MIN_REASON = 8;
export type ReviewDecision = { action: "APPROVE"; verifiedAmount?: number | null; reason?: string | null } | { action: "REJECT"; reason?: string | null };

/** Decide the stored review for one item. Pure; the route adds who / when. */
export function decideReview(reported: number, d: ReviewDecision): { ok: true; status: ReviewStatus; verified: number; reason: string | null } | { ok: false; reasons: string[] } {
  const reason = (d.reason ?? "").trim() || null;
  if (d.action === "REJECT") {
    if (!reason || reason.length < MIN_REASON) return { ok: false, reasons: ["Say why it is rejected (at least 8 characters) — the guide sees this"] };
    return { ok: true, status: "REJECTED", verified: 0, reason };
  }
  const v = d.verifiedAmount == null ? reported : r2(Number(d.verifiedAmount));
  if (!Number.isFinite(v) || v < 0) return { ok: false, reasons: ["Enter the verified amount in baht"] };
  if (v === r2(reported)) return { ok: true, status: "APPROVED", verified: v, reason };
  if (!reason || reason.length < MIN_REASON) return { ok: false, reasons: ["The verified amount differs from what the guide reported — say why (at least 8 characters)"] };
  return { ok: true, status: "ADJUSTED", verified: v, reason };
}

/**
 * The accounting row's price × quantity for a verified amount, keeping the guide's unit price
 * when the amount divides by it (4 bus fares of 15 = 60), else one line of the whole amount.
 */
export function pricePaxFor(verified: number, reported: Pick<Expense, "price" | "pax">): { price: number; pax: number } {
  const v = r2(verified);
  const p = Number(reported.price) || 0;
  if (v === 0) return { price: p, pax: 0 };
  if (p > 0) { const q = v / p; if (Number.isInteger(r2(q))) return { price: p, pax: r2(q) }; }
  return { price: v, pax: 1 };
}

// ── Ticket receipts (Company ADV rows) ───────────────────────────────────────────────────────

export type ReceiptReview = "NOT_REVIEWED" | "VERIFIED" | "REJECTED" | "REPLACEMENT_REQUESTED";
export type ReceiptRowStatus = "MISSING" | "TO_REVIEW" | "VERIFIED" | "REJECTED" | "REPLACEMENT_REQUESTED";

/** One ticket row's receipt status from its live files (oldest first). */
export function receiptRowStatus(files: readonly { reviewStatus?: string | null; uploadedAt: string }[]): ReceiptRowStatus {
  if (!files.length) return "MISSING";
  if (files.some((f) => (f.reviewStatus ?? "NOT_REVIEWED") === "NOT_REVIEWED")) return "TO_REVIEW";
  const latest = [...files].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt)).at(-1)!;
  if (files.every((f) => f.reviewStatus === "VERIFIED")) return "VERIFIED";
  return (latest.reviewStatus as ReceiptRowStatus) ?? "TO_REVIEW";
}

/** The sheet rows paid from the Company ADV — tickets, not tour expenses. */
export const isAdvanceRow = (e: Pick<Expense, "paidBy">) => (e.paidBy ?? "") === "advance";

// ── The operator's accounting rows (owner 2026-11-16: "operator too") ───────────────────────
//
// A cost the GUIDE paid with their own money (Paid By = Guide Personal) is one of the three
// fixed items — on the operator's sheet as on the guide's report. "Boat" paid by the guide is
// refused: it is Ferry (Inc. Guide). Not limited: entrance tickets (Company ADV / company-paid,
// or a guide-paid ticket the operator handles as an exception), anything the company paid
// directly, review rewards, a food tour's food rows, and Lotus (Inc. Guide), which the operator
// adds on the sheet when a tour has it. A row already on the sheet and unchanged is left alone:
// history is never rewritten, the rule applies when a row is added or edited.
const OPERATOR_ALSO_ALLOWED = new Set(["Lotus (Inc. Guide)", FOOD_COST_DESCRIPTION, FOOD_COST_OVER_DESCRIPTION]);
const isGuidePersonal = (e: Pick<Expense, "paidBy">) => ["guide", "guide_personal"].includes((e.paidBy ?? "").trim().toLowerCase());
const rowKey = (e: Expense) => [(e.description ?? "").trim(), Number(e.price) || 0, Number(e.pax) || 0, (e.paidBy ?? "").trim().toLowerCase(), (e.expenseType ?? "").trim().toLowerCase()].join("|");

export function operatorRowProblems(rows: readonly Expense[], stored: readonly Expense[] | null | undefined): string[] {
  const before = new Set((stored ?? []).map(rowKey));
  const problems: string[] = [];
  let n = 0;
  for (const e of rows) {
    if (isReviewExpense(e)) continue;
    n++;
    if (!isGuidePersonal(e) || expenseAmount(e) <= 0) continue;
    if ((e.expenseType ?? "").trim().toLowerCase() === "entrance") continue;
    const desc = (e.description ?? "").trim();
    // The short spelling ("Bus") is the same item: older rows carry it, and a row with a confirmed
    // payer cannot be renamed — refusing it would leave that row unsavable.
    if (fixedItemOf(e)) continue;
    if (OPERATOR_ALSO_ALLOWED.has(desc) || /^lotus(\s*\([^)]*guide[^)]*\))?$/i.test(desc)) continue; // Lotus, any spelling
    if (before.has(rowKey(e))) continue; // unchanged history
    problems.push(`Row ${n} “${desc || "(no name)"}”: a cost the guide paid must be Water, Bus or Ferry (Inc. Guide)${/boat|เรือ/i.test(desc) ? " — a boat fare is “Ferry (Inc. Guide)”" : ""}. If the company paid it, set Paid By to Company Direct.`);
  }
  return problems;
}
