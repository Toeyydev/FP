// A cost "paid from a company advance" on a job that has no advance on record.
//
// A row whose payer is Company Advance is left out of what the guide is transferred, on the
// ground that the company's cash already paid for it (lib/peak-sync tourCostBreakdown). That
// is only true when an advance was actually issued for the job. When none is recorded,
// nothing proves who paid: perhaps the advance was handed over and never entered, perhaps
// the guide fronted the money and the tag is wrong. Either way the amount must not simply
// leave the transfer — that is money disappearing with nobody told.
//
// FolkOPS does not guess which. The figure is left as it is (adding the amount back would be
// a guess too, and could pay for a ticket twice), and the job is HELD: no payment recorded,
// no PEAK payment document, and the reason said in words and as a code — until a person
// either records the advance or corrects who paid.
//
// "Covered" is the rule a row's own link rests on (lib/advances/categories linkProblems):
// a live advance — not reversed — issued for THIS job (same guide, date and departure) that
// may pay for the row's category. And what the covered rows come to cannot be more than
// those advances handed over: the part above it was paid by somebody, and it was not them.
//
// Pure: no database, no network. lib/advances/coverage-server reads the advances.
import { expenseAmount, expenseCategory, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { paymentPayer } from "@/lib/payer-rules";
import { categoryAllowed } from "@/lib/advances/categories";

/** The machine-readable reason, the same string wherever this is reported. */
export const ADVANCE_NOT_RECORDED = "ADVANCE_NOT_RECORDED";

/** A live advance of the job, as far as coverage needs to know it. */
export type JobAdvance = { amount: number; allowedCategories?: readonly string[] | null };

export type AdvanceGapRow = {
  /** The row's number as the job sheet shows it (review rewards are not numbered). */
  rowNo: number;
  description: string;
  category: string | null;
  amount: number;
  /** NO_ADVANCE: the job has no live advance. CATEGORY_NOT_ALLOWED: it has one, but not for this kind of cost. */
  why: "NO_ADVANCE" | "CATEGORY_NOT_ALLOWED";
};

export type AdvanceGap = {
  code: typeof ADVANCE_NOT_RECORDED;
  /** The amount held out of the transfer with no recorded advance behind it: the rows below, plus `excess`. */
  amount: number;
  /** Rows no live advance of the job may pay for. */
  rows: AdvanceGapRow[];
  /** How much MORE the rows an advance does cover come to than the job's live advances issued. 0 when they fit. */
  excess: number;
  /** What the job's live advances issued, in all. */
  issued: number;
};

const satang = (n: number) => Math.round(n * 100);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `guideId|date|slotIdx` — one job. */
export const advanceJobKey = (j: { guideId: string; date: string; slotIdx: number }) => `${j.guideId}|${j.date}|${j.slotIdx}`;

/**
 * What a job counts as paid from a company advance without a recorded advance to show for
 * it — or null when every such row is covered.
 *
 * `advances` are the job's LIVE advances, a fact the caller loads. A caller that has not
 * loaded them must pass none: unknown is never read as covered.
 */
export function advanceGap(expenses: readonly Expense[] | null | undefined, advances: readonly JobAdvance[] | null | undefined): AdvanceGap | null {
  const live = advances ?? [];
  const rows: AdvanceGapRow[] = [];
  let covered = 0;
  let rowNo = 0;
  for (const e of expenses ?? []) {
    if (isReviewExpense(e)) continue;
    rowNo++;
    const amount = expenseAmount(e);
    if (!(amount > 0)) continue;
    // paymentPayer: the payer the transfer relies on — the very rule that leaves the row out.
    if (paymentPayer(e) !== "GUIDE_ADVANCE") continue;
    if (live.some((a) => categoryAllowed(a, e))) { covered += satang(amount); continue; }
    rows.push({
      rowNo, description: (e.description ?? "").trim() || `row ${rowNo}`, category: expenseCategory(e) ?? null, amount: round2(amount),
      why: live.length ? "CATEGORY_NOT_ALLOWED" : "NO_ADVANCE",
    });
  }
  const issued = live.reduce((s, a) => s + satang(Number(a.amount) || 0), 0);
  const excess = Math.max(0, covered - issued);
  if (!rows.length && !excess) return null;
  return { code: ADVANCE_NOT_RECORDED, amount: round2((rows.reduce((s, r) => s + satang(r.amount), 0) + excess) / 100), rows, excess: excess / 100, issued: issued / 100 };
}

const baht = (n: number) => `฿${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A sentence that reads after the job's number: "FOLK-BKK-… <message>". */
export function advanceGapMessage(gap: AdvanceGap): string {
  const parts: string[] = [];
  const none = gap.rows.filter((r) => r.why === "NO_ADVANCE");
  const kind = gap.rows.filter((r) => r.why === "CATEGORY_NOT_ALLOWED");
  const sum = (rs: AdvanceGapRow[]) => round2(rs.reduce((s, r) => s + r.amount, 0));
  const count = (rs: AdvanceGapRow[]) => `${rs.length} row${rs.length === 1 ? "" : "s"}`;
  if (none.length) parts.push(`has ${baht(sum(none))} of expenses (${count(none)}) marked "From company advance", but no advance is recorded for this job`);
  if (kind.length) parts.push(`has ${baht(sum(kind))} of expenses (${count(kind)}) marked "From company advance" that the advance recorded for this job does not cover (${[...new Set(kind.map((r) => r.category ?? "no category"))].join(", ")})`);
  if (gap.excess > 0) parts.push(`has ${baht(gap.excess)} more marked "From company advance" than the ${baht(gap.issued)} of advances recorded for it`);
  return `${parts.join("; and ")} — that amount is not in the transfer and nothing shows the company paid it. ` +
    `Record the advance${kind.length || gap.excess > 0 ? " that paid for it" : ""}, or correct who paid on the job sheet, before paying`;
}

/** The full reason, naming the job. */
export const advanceGapReason = (where: string, gap: AdvanceGap) => `${where} ${advanceGapMessage(gap)}`;

/** One job's refusal in the form every endpoint returns it (`blocks`). */
export type AdvanceBlock = { code: AdvanceGap["code"]; jobNo: string; date: string; slotIdx: number; amount: number; rows: AdvanceGapRow[]; excess: number; issued: number };
export const advanceBlock = (job: { jobNo: string | null | undefined; date: string; slotIdx: number }, gap: AdvanceGap): AdvanceBlock =>
  ({ code: gap.code, jobNo: (job.jobNo ?? "").trim(), date: job.date, slotIdx: job.slotIdx, amount: gap.amount, rows: gap.rows, excess: gap.excess, issued: gap.issued });
