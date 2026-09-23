// PEAK accounting readiness for a job sheet.
//
// Everything here is PURE: no network, no database, no PEAK API. It answers three
// questions the sheet needs to be accounting-safe *before* anything is posted:
//
//   1. What do we actually owe the guide, versus what did this job cost the company?
//   2. Is every expense row mapped to an account well enough to book it?
//   3. May this sheet be synced at all — and has it already been?
//
// The money rule that drives all of it: an expense the COMPANY already paid the
// vendor directly is a company cost but NOT money owed to the guide. Reimbursing it
// would pay for the same thing twice. Only what the guide fronted with personal
// money comes back to them.

import { categoryForExpenseType, categoryLabel, isPerJobCategory } from "@/lib/peak-accounts";
import {
  expenseAmount,
  expenseCategory,
  isReviewExpense,
  computeTotals,
  thb,
  jobCostBreakdown,
  type Expense,
  type ExpenseCategoryKey,
  type GuideFee,
  type Booking,
} from "@/lib/jobsheet";

// ── Paid By ──────────────────────────────────────────────────────────────────
// Who fronted the cash. Deliberately separate from the accounting CATEGORY: what
// a cost *is* (transport, tickets) has nothing to do with whose wallet it left.
//
// Stored values stay exactly as they always were ("company" | "guide" | "advance",
// plus the legacy "operator"), so nothing needs migrating. UNSPECIFIED is the
// important addition: a row that has never been tagged. The old UI silently
// displayed those as "Company Direct", which would quietly drop a guide's
// reimbursement to zero — so an untagged row is now its own state that blocks sync
// rather than a guess that costs someone money.
export type PaidBy = "COMPANY_DIRECT" | "GUIDE_PERSONAL" | "GUIDE_ADVANCE" | "UNSPECIFIED";

export function canonicalPaidBy(e: Pick<Expense, "paidBy">): PaidBy {
  const raw = (e.paidBy ?? "").trim().toLowerCase();
  if (!raw) return "UNSPECIFIED";
  if (raw === "guide" || raw === "guide_personal") return "GUIDE_PERSONAL";
  if (raw === "advance" || raw === "guide_advance") return "GUIDE_ADVANCE";
  // "company", and the legacy "operator", are both the company paying directly.
  if (raw === "company" || raw === "operator" || raw === "company_direct") return "COMPANY_DIRECT";
  return "UNSPECIFIED";
}

// Only personal money creates a debt to the guide. Company-direct rows were never
// the guide's money; advance rows were company money already in their hands and are
// settled through the advance ledger (lib/advance), never reimbursed a second time.
export function createsReimbursement(e: Pick<Expense, "paidBy">): boolean {
  return canonicalPaidBy(e) === "GUIDE_PERSONAL";
}

// ── Account mapping ──────────────────────────────────────────────────────────
// A category is mapped to a PEAK account through configuration, never guessed from
// the row's description. The map is passed in (server-supplied from env) so this
// module stays pure and testable, and so an unconfigured deployment reports
// "not configured" instead of inventing an account code.
export type PeakAccount = { code: string; id?: string; name?: string };
export type PeakAccountMap = Partial<Record<ExpenseCategoryKey, PeakAccount>>;

export type MappingStatus = "READY" | "NEEDS_REVIEW" | "UNMAPPED";

// Per-row accounting readiness. Order matters: the most actionable problem wins,
// so an operator is told the one thing to fix rather than the last check that failed.
export function expenseMappingStatus(e: Expense, accounts: PeakAccountMap = {}): MappingStatus {
  const cat = expenseCategory(e);
  if (!cat) return "UNMAPPED";                       // no category chosen yet
  if (canonicalPaidBy(e) === "UNSPECIFIED") return "NEEDS_REVIEW"; // who paid is unknown
  // OTHER_TOUR_COST is the catch-all. It is ready when the row names its own
  // account, or when the owner has saved a default for the category; with neither,
  // it waits for a choice on the row rather than being guessed.
  if (cat === "other") return (e.peakAccountCode || accounts.other?.code) ? "READY" : "NEEDS_REVIEW";
  // Any other category still needs a real account behind it before it can book.
  const acct = e.peakAccountCode || accounts[cat]?.code;
  return acct ? "READY" : "UNMAPPED";
}

// Resolve the account a row would post to, without mutating the row. Returns null
// when nothing is configured — the caller must treat that as "cannot sync".
export function resolveExpenseAccount(e: Expense, accounts: PeakAccountMap = {}): PeakAccount | null {
  if (e.peakAccountCode) return { code: e.peakAccountCode, id: e.peakAccountId ?? undefined, name: e.peakAccountName ?? undefined };
  const cat = expenseCategory(e);
  return (cat && accounts[cat]) || null;
}

// ── Duplicate protection ─────────────────────────────────────────────────────
// A company-direct expense is often already in PEAK from its own supplier invoice
// or receipt. Posting the job sheet must not book it a second time.
export type SyncDisposition = "SYNC" | "ALREADY_RECORDED" | "BLOCKED" | "NOT_GUIDE_PAYABLE";

/**
 * Phase 3 guard. A job-sheet expense document is raised against the GUIDE as the
 * vendor: every line on it is money the company owes that guide. A row the company
 * already settled — paid direct to the supplier, or paid with cash it had already
 * advanced the guide — is a real company cost but it is NOT owed to the guide, so
 * putting it on that document books a payable that does not exist. (It happened once:
 * a document carried an advance-funded meal and had to be voided.)
 *
 * These rows are held back from the document and listed instead — see
 * lib/advances/unbooked — so the cost is followed up rather than lost. The combined
 * payment document has always skipped them (lib/peak-payment-document); this makes the
 * two paths agree.
 */
export function notGuidePayable(e: Expense): boolean {
  const paid = canonicalPaidBy(e);
  return paid === "COMPANY_DIRECT" || paid === "GUIDE_ADVANCE";
}

export function expenseDisposition(e: Expense, accounts: PeakAccountMap = {}): SyncDisposition {
  // An expense already booked in PEAK stays in this job's cost reporting but is
  // never re-sent — regardless of how well it is mapped.
  if (e.alreadyRecordedInPeak) return "ALREADY_RECORDED";
  if (notGuidePayable(e)) return "NOT_GUIDE_PAYABLE";
  return expenseMappingStatus(e, accounts) === "READY" ? "SYNC" : "BLOCKED";
}

// The rows that would actually be posted: billed, not a review reward, mapped, and
// not already recorded elsewhere.
export function syncableExpenses(expenses: Expense[], accounts: PeakAccountMap = {}): Expense[] {
  return (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0 && expenseDisposition(e, accounts) === "SYNC");
}

// Are the EXPENSE ROWS themselves accounting-ready? Deliberately narrower than
// peakSyncEligibility: a missing guide contact or approval blocks the sheet, but it
// says nothing about the expense table, and labelling the expense total "Needs
// review" for it sends the operator hunting through rows that are all fine.
export function expenseRowsReady(expenses: Expense[], accounts: PeakAccountMap = {}): boolean {
  const billed = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);
  // Whether a row will be posted on the GUIDE's document is a different question (see
  // notGuidePayable): a company-settled row still needs its category and account, because
  // the accountant books it from the unbooked-cost register.
  return billed.length > 0 && billed.every((e) => e.alreadyRecordedInPeak || expenseMappingStatus(e, accounts) === "READY");

}

// ── Job-sheet money ──────────────────────────────────────────────────────────
// One place that computes every figure the Summary shows, so no caller can derive
// a total twice from overlapping sources.
export type JobSheetTotals = {
  totalTourExpenses: number;        // every billed tour-expense row, whoever paid
  guideFeeGross: number;            // agreed fee before tax
  wht: number;                      // the whole withholding: fee + review incentive
  whtOnFee: number;                 // …the part the fee bears
  whtOnReview: number;              // …the part the review incentive bears
  whtBase: number;                  // fee + review incentive — never reimbursements
  netGuideFee: number;              // fee after the whole withholding
  additionalGuidePayment: number;   // review rewards paid out with this job
  additionalOwnedByJob: number;     // …the part earned on THIS job (a cost of it)
  reimbursementDue: number;         // GUIDE_PERSONAL rows only
  companyDirectTotal: number;       // already paid by the company — never reimbursed
  advanceSpentTotal: number;        // paid from a guide advance — settled separately
  unspecifiedTotal: number;         // untagged rows: cannot be attributed yet
  totalCompanyCost: number;         // what this job cost the company
  netPayToGuide: number;            // what we transfer to the guide
  legacyPayout: number;             // what Payments transfers today (guidePayoutTotal)
  settledByCompany: number;         // tour expenses the company already settled
  payoutDiffersFromPayments: boolean;
};

export function jobSheetTotals(
  expenses: Expense[],
  guideFee: GuideFee,
  jobRef?: string | null,
  bookings?: Booking[],
): JobSheetTotals {
  const t = computeTotals(expenses, guideFee);
  const cost = jobCostBreakdown(expenses, guideFee, jobRef, bookings);
  const rows = (expenses ?? []).filter((e) => !isReviewExpense(e));
  const sumWhere = (p: (e: Expense) => boolean) => rows.filter(p).reduce((s, e) => s + expenseAmount(e), 0);

  // Review rewards are guide compensation and are counted in additionalGuidePayment;
  // they must never also land in reimbursement, so they are excluded from `rows`.
  const reimbursementDue = sumWhere(createsReimbursement);
  const additionalGuidePayment = cost.reviewOwn + cost.reviewOther;

  // §12: what we owe the guide is their own money back plus what they earned —
  // never a cost the company already settled directly with the vendor.
  const netPayToGuide = t.netGuideFee + additionalGuidePayment + reimbursementDue;
  const paymentsFigure = guidePayoutTotal(expenses, guideFee).payout;
  // Tour expenses that are real company cost but not owed to the guide, because a
  // person recorded that the company already settled them.
  const settled = sumWhere((e) => { const p = canonicalPaidBy(e); return p === "COMPANY_DIRECT" || p === "GUIDE_ADVANCE"; });

  return {
    totalTourExpenses: cost.tourExpenses,
    guideFeeGross: t.gross,
    wht: t.wht,
    whtOnFee: t.whtOnFee,
    whtOnReview: t.whtOnReview,
    whtBase: t.whtBase,
    netGuideFee: t.netGuideFee,
    additionalGuidePayment,
    additionalOwnedByJob: cost.reviewOwn,
    reimbursementDue,
    companyDirectTotal: sumWhere((e) => canonicalPaidBy(e) === "COMPANY_DIRECT"),
    advanceSpentTotal: sumWhere((e) => canonicalPaidBy(e) === "GUIDE_ADVANCE"),
    unspecifiedTotal: sumWhere((e) => canonicalPaidBy(e) === "UNSPECIFIED"),
    // Owner decision 2026-08-26: the Summary no longer lists Additional Guide
    // Payment, so the reward is excluded from this total too — otherwise the
    // visible lines would stop adding up to it, which is the exact confusion the
    // "of which" regroup fixed. NOTE: on a job that DID earn a reward this now
    // understates actual company outlay by that amount; the reward is still paid
    // (it remains in netPayToGuide) and still appears in its own section.
    // lib/jobsheet's jobCostBreakdown().jobExpenses keeps the full figure for the
    // printed document.
    totalCompanyCost: cost.tourExpenses + t.gross,
    netPayToGuide,
    // What Payments actually transfers today. This MUST track the real rule in
    // guidePayoutTotal, not computeTotals().grandTotal — comparing against a formula
    // Payments no longer uses made the sheet warn about a difference that had
    // already been fixed, which is worse than not warning at all.
    legacyPayout: paymentsFigure,
    payoutDiffersFromPayments: Math.round(netPayToGuide * 100) !== Math.round(paymentsFigure * 100),
    // The part of tour expenses the guide is NOT paid for, and why — so the Net Pay
    // box can explain itself instead of looking like money went missing.
    settledByCompany: settled,
  };
}

// ── "Recheck this number" ────────────────────────────────────────────────────
// A figure can be arithmetically correct and still not safe to pay from, because
// the DATA behind it is incomplete. The commonest case: expense rows with no
// Paid By set. Those are excluded from Reimbursement Due (we will not pay out
// money nobody has claimed), which makes both it and Net Pay understated — and
// that understatement is invisible unless we say so at the number itself.
//
// Each reason names the affected figure, what is wrong, and what to do about it.
export type RecheckField = "totalTourExpenses" | "reimbursementDue" | "netPayToGuide" | "reviewReward";
export type Recheck = { field: RecheckField; short: string; detail: string; amount?: number };

export function figuresNeedRecheck(
  expenses: Expense[],
  totals: JobSheetTotals,
  accounts: PeakAccountMap = {},
  // Per-row status as the SERVER computed it (it knows which accounts are
  // configured; the browser does not). Without this the client recomputes with an
  // empty account map and reports rows as unready that the table beside it is
  // showing as Ready — two contradictory statements about the same rows.
  rowStatuses?: (("READY" | "NEEDS_REVIEW" | "UNMAPPED") | null | undefined)[],
): Recheck[] {
  const out: Recheck[] = [];

  // A review reward is priced per review: price x count. Leaving the count blank
  // makes the row worth ZERO while still reading "Review 50" on screen, so it
  // looks recorded and pays nothing. Nineteen such rows were sitting in
  // production across eight guides. Say it plainly rather than let the row look
  // done.
  const zeroReviews = (expenses ?? []).filter(
    (e) => isReviewExpense(e) && (e.price ?? 0) > 0 && expenseAmount(e) === 0,
  );
  if (zeroReviews.length) {
    const n = zeroReviews.length;
    out.push({
      field: "reviewReward",
      short: `${n} review reward${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} worth ฿0 · ค่าตอบแทนรีวิวเป็น ฿0`,
      detail: `The count is blank, so the row pays nothing however large the rate — enter how many reviews it covers. · ช่องจำนวนว่าง บรรทัดนี้จึงจ่าย ฿0 ไม่ว่าเรตจะเท่าไหร่ กรุณาใส่จำนวนรีวิว`,
    });
  }

  const rows = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);

  const untagged = rows.filter((e) => canonicalPaidBy(e) === "UNSPECIFIED");
  if (untagged.length) {
    out.push({
      field: "reimbursementDue",
      short: untagged.length === 1 ? "1 expense has no Paid By" : `${untagged.length} expenses have no Paid By`,
      detail: `They are counted in the tour's cost and in nothing else — not reimbursed, not transferred — and the payment is refused until someone says who paid. Set Paid By on ${untagged.length === 1 ? "that row" : "those rows"}.`,
      amount: totals.unspecifiedTotal,
    });
  }

  const noAmount = (expenses ?? []).filter((e) => !isReviewExpense(e) && (e.description || "").trim() && expenseAmount(e) === 0);
  if (noAmount.length) {
    out.push({
      field: "totalTourExpenses",
      short: noAmount.length === 1 ? "1 expense row has no amount" : `${noAmount.length} expense rows have no amount`,
      detail: "A described row with no price or quantity contributes nothing to the total. Fill it in or remove it.",
    });
  }

  const statusOf = (e: Expense) => {
    if (!rowStatuses) return expenseMappingStatus(e, accounts);
    const i = (expenses ?? []).indexOf(e);
    return rowStatuses[i] ?? expenseMappingStatus(e, accounts);
  };
  const unmapped = rows.filter((e) => !e.alreadyRecordedInPeak && statusOf(e) !== "READY");
  if (unmapped.length) {
    out.push({
      field: "totalTourExpenses",
      short: unmapped.length === 1 ? "1 expense is not ready for accounting" : `${unmapped.length} expenses are not ready for accounting`,
      detail: "These rows are counted in the totals but cannot be posted to PEAK yet.",
    });
  }
  return out;
}
// Local formatter — lib/jobsheet owns thb(), but importing it here for one string
// would pull display concerns into the money module.
function thbLike(v: number): string {
  return `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── What Payments actually transfers ─────────────────────────────────────────
// computeTotals().grandTotal pays the guide for EVERY expense row, including ones
// the company had already settled — a guide advance handed over before the tour, or
// an invoice the company paid the vendor direct. Both are money already spent on the
// guide's behalf; paying them again in the payout pays twice.
//
// The rule is deliberately narrow, because the two cases are not alike:
//   · explicitly tagged company/advance → EXCLUDED. Nothing is being judged here;
//     someone recorded who paid, and it was not the guide.
//   · not tagged at all → INCLUDED, exactly as before. Nobody recorded who paid,
//     and guessing would either underpay a guide who fronted cash or pay one twice.
//     Those sheets keep their existing payout until a person tags the rows.
//
// Review rewards are always included: they are compensation the guide earns.
export type GuidePayout = {
  payoutExpenses: number;   // expense rows that are still owed to the guide
  payout: number;           // + net guide fee — what to transfer
  excludedTagged: number;   // company/advance rows deliberately left out
  /** Rows whose payer nobody recorded. Not paid, not dropped — they block the payment. */
  unresolved: number;
};

/**
 * What the job COST, and — separately — what the guide is OWED.
 *
 * These are two different questions and the screens kept answering the first when
 * someone asked the second. A ticket bought with a company advance is a real cost of
 * the tour and belongs in its total; it is not money the guide is owed, because the
 * company already handed it over. Adding it to a transfer pays for the ticket twice.
 *
 * One function answers both, so a job sheet, a payment preview, a PEAK payload and a
 * PDF cannot disagree about the same job.
 *
 *   tourCost            every operating row, whoever paid — the cost of the job
 *     = fundedByAdvance + fundedByCompany + reimbursableToGuide + unresolved
 *
 *   grossPayable        feeGross + reviewReward + reimbursableToGuide
 *   netTransfer         grossPayable − withholding        ← the only figure to transfer
 *
 * `unresolved` is in the cost and in nothing else. A row whose payer nobody recorded
 * cannot be paid on a guess: paying it might reimburse money the guide never spent,
 * and dropping it might swallow money they did. It is shown, and it blocks the
 * payment until a person says who paid.
 */
export type TourCostBreakdown = {
  tourCost: number;
  fundedByAdvance: number;
  fundedByCompany: number;
  reimbursableToGuide: number;
  unresolved: number;
  reviewReward: number;
  feeGross: number;
  grossPayable: number;
  withholding: number;
  netTransfer: number;
};

const r2c = (n: number) => Math.round(n * 100) / 100;

export function tourCostBreakdown(expenses: Expense[] | null | undefined, guideFee: GuideFee): TourCostBreakdown {
  const rows = expenses ?? [];
  const t = computeTotals(rows, guideFee);
  let fundedByAdvance = 0, fundedByCompany = 0, reimbursableToGuide = 0, unresolved = 0, reviewReward = 0;
  for (const e of rows) {
    const amt = expenseAmount(e);
    if (!amt) continue;
    // A review reward is earned, not spent: it is paid with the job, never a cost of it.
    if (isReviewExpense(e)) { reviewReward += amt; continue; }
    switch (canonicalPaidBy(e)) {
      case "GUIDE_ADVANCE": fundedByAdvance += amt; break;
      case "COMPANY_DIRECT": fundedByCompany += amt; break;
      case "GUIDE_PERSONAL": reimbursableToGuide += amt; break;
      default: unresolved += amt;
    }
  }
  const grossPayable = t.gross + reviewReward + reimbursableToGuide;
  return {
    tourCost: r2c(fundedByAdvance + fundedByCompany + reimbursableToGuide + unresolved),
    fundedByAdvance: r2c(fundedByAdvance),
    fundedByCompany: r2c(fundedByCompany),
    reimbursableToGuide: r2c(reimbursableToGuide),
    unresolved: r2c(unresolved),
    reviewReward: r2c(reviewReward),
    feeGross: r2c(t.gross),
    grossPayable: r2c(grossPayable),
    withholding: r2c(t.wht),
    netTransfer: r2c(grossPayable - t.wht),
  };
}

export function guidePayoutTotal(expenses: Expense[], guideFee: GuideFee): GuidePayout {
  const b = tourCostBreakdown(expenses, guideFee);
  return {
    payoutExpenses: r2c(b.reimbursableToGuide + b.reviewReward),
    payout: b.netTransfer,
    excludedTagged: r2c(b.fundedByAdvance + b.fundedByCompany),
    unresolved: b.unresolved,
  };
}

// What the GUIDE is shown they will receive, on their own job page.
//
// Three rules this exists to hold together:
//   * Tour expenses come from whichever list is authoritative right now — the
//     guide's own report while it is open, the operator's record once the operator
//     has approved the sheet or the job is paid.
//   * Only money owed back to the guide is counted, by the SAME payer rule as the
//     transfer (guidePayoutTotal): a row the company paid directly, or paid from a
//     company advance, is shown as not reimbursed — never added to "You'll receive".
//     A row with no payer recorded yet counts, as it does in Payments, and is called
//     out so the guide knows it is still to be confirmed.
//   * The review reward ALWAYS comes from the operator's record and is added once.
//     It is compensation the operator awards, not something a guide reports, so it
//     must not disappear when the guide files a report with no review lines in it —
//     and must not be counted twice when the report was seeded from the operator's
//     rows, which already contained them.
// Until the operator approves the sheet (or it is paid) the figure is an estimate.
export type GuidePayoutView = {
  tourExpenses: number; // reimbursed to the guide: their own money + rows with no payer yet
  reviewReward: number;
  total: number;
  notReimbursed: { company: number; advance: number };
  unspecified: number; // the part of tourExpenses with no payer recorded yet
  basis: "reported" | "official";
  status: "estimate" | "confirmed" | "final";
};

export function guidePayoutView(args: {
  operatorExpenses: Expense[];
  reportedExpenses: Expense[];
  netGuideFee: number;
  /** true while the guide's own report window is open (tour done, not yet paid) */
  useReported: boolean;
  approved?: boolean;
  paid?: boolean;
}): GuidePayoutView {
  const basis = args.useReported && !args.approved && !args.paid ? "reported" : "official";
  const rows = (basis === "reported" ? args.reportedExpenses : args.operatorExpenses) ?? [];
  let tourExpenses = 0, company = 0, advance = 0, unspecified = 0;
  for (const e of rows) {
    if (isReviewExpense(e)) continue;
    const amt = expenseAmount(e);
    if (!amt) continue;
    const paid = canonicalPaidBy(e);
    if (paid === "COMPANY_DIRECT") { company += amt; continue; }
    if (paid === "GUIDE_ADVANCE") { advance += amt; continue; }
    // A row nobody has assigned a payer to is not money we can say is owed. It is
    // shown separately so the guide can see it is still being decided, and it is left
    // out of the figure, exactly as the transfer leaves it out.
    if (paid === "UNSPECIFIED") { unspecified += amt; continue; }
    tourExpenses += amt;
  }
  const reviewReward = (args.operatorExpenses ?? []).filter(isReviewExpense).reduce((s, e) => s + expenseAmount(e), 0);
  return {
    tourExpenses, reviewReward, total: args.netGuideFee + tourExpenses + reviewReward,
    notReimbursed: { company, advance }, unspecified, basis,
    status: args.paid ? "final" : args.approved ? "confirmed" : "estimate",
  };
}

// ── Sync status ──────────────────────────────────────────────────────────────
export type PeakSyncStatus = "NOT_READY" | "READY" | "SYNCING" | "SYNCED" | "FAILED" | "BLOCKED";

export type PeakSyncState = {
  peakSyncStatus?: string | null;
  peakDocumentId?: string | null;
  peakDocumentNo?: string | null;
  syncedAt?: string | Date | null;
  syncError?: string | null;
  lastPayloadHash?: string | null;
};

export type SyncEligibilityInput = {
  expenses: Expense[];
  guideFee: GuideFee;
  approved: boolean;
  peakContactId?: string | null;   // the guide's stable PEAK contact
  accountingDate?: string | null;
  accounts?: PeakAccountMap;
  jobRef?: string | null;
  bookings?: Booking[];
  state?: PeakSyncState;
  /** "HISTORICAL_BACKFILL" for a reconstructed sheet. Display only — the block
   *  that matters is in buildPayoutExpense, which every posting path goes through. */
  origin?: string | null;
};

export type SyncEligibility = {
  status: PeakSyncStatus;
  canSync: boolean;
  reasons: string[];   // why not — empty when canSync
  changedSinceSync: boolean;
};

// May this sheet be posted to PEAK, and if not, exactly why. Every reason is
// phrased as the thing to go fix.
export function peakSyncEligibility(input: SyncEligibilityInput): SyncEligibility {
  const { expenses, guideFee, approved, peakContactId, accountingDate, accounts = {}, jobRef, bookings, state } = input;
  const reasons: string[] = [];

  if (input.origin === "HISTORICAL_BACKFILL")
    reasons.push("Reconstructed from historical records — not eligible for PEAK sync");
  if (!approved) reasons.push("Job sheet is not approved");
  if (!peakContactId) reasons.push("Guide is not mapped to a PEAK Contact");
  if (!accountingDate) reasons.push("No accounting date set");

  const billed = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);
  const needReview = billed.filter((e) => !e.alreadyRecordedInPeak && expenseMappingStatus(e, accounts) !== "READY");

  // Name the actual cause per §7. "2 expenses need account review" tells an
  // operator nothing about where to go; "Transportation has no PEAK account
  // mapping" points at the settings page, and "1 Other Tour Cost requires account
  // review" points at the row. They are different fixes in different places.
  const unmappedCats = new Set<string>();
  let perJobUnresolved = 0;
  let uncategorised = 0;
  for (const e of needReview) {
    const cat = categoryForExpenseType(e.expenseType);
    if (!cat) { uncategorised++; continue; }
    // Paid By before the account: an Other Tour Cost that has an account but no
    // Paid By must be told to set Paid By, not sent looking for an account.
    if (canonicalPaidBy(e) === "UNSPECIFIED") { uncategorised++; continue; }
    if (isPerJobCategory(cat)) { perJobUnresolved++; continue; }
    unmappedCats.add(cat);
  }
  for (const cat of unmappedCats) reasons.push(`${categoryLabel(cat)} has no PEAK account mapping`);
  if (perJobUnresolved) reasons.push(`${perJobUnresolved} ${categoryLabel("OTHER_TOUR_COST")} ${perJobUnresolved === 1 ? "has" : "have"} no PEAK account — choose one on the row, or set a default under PEAK sync`);
  if (uncategorised) reasons.push(uncategorised === 1 ? "1 expense needs a category or Paid By" : `${uncategorised} expenses need a category or Paid By`);

  // A company-direct row claiming to be in PEAK already must say WHICH document,
  // otherwise "already recorded" is an unverifiable assertion that could hide a
  // real expense from the books.
  const unresolvedDupes = billed.filter((e) => e.alreadyRecordedInPeak && !e.peakExistingDocumentId && !e.sourceDocumentNo);
  if (unresolvedDupes.length) reasons.push(unresolvedDupes.length === 1
    ? "1 expense is marked already-recorded without a source document"
    : `${unresolvedDupes.length} expenses are marked already-recorded without a source document`);

  const totals = jobSheetTotals(expenses, guideFee, jobRef, bookings);
  if (!(totals.netPayToGuide >= 0) || !isFinite(totals.netPayToGuide)) reasons.push("Payment values are not valid");
  if (syncableExpenses(expenses, accounts).length === 0 && totals.guideFeeGross <= 0) reasons.push("Nothing to post");

  const changedSinceSync = !!(state?.peakDocumentId && state.lastPayloadHash
    && state.lastPayloadHash !== peakPayloadHash({ expenses, guideFee, accountingDate, peakContactId, accounts }));

  // An in-flight or failed sync is a state of its own — never silently "ready".
  const stored = (state?.peakSyncStatus ?? "") as PeakSyncStatus;
  if (stored === "SYNCING") return { status: "SYNCING", canSync: false, reasons: ["A sync is already in progress"], changedSinceSync };
  if (state?.peakDocumentId && !changedSinceSync) return { status: "SYNCED", canSync: false, reasons: [], changedSinceSync: false };
  if (stored === "FAILED" && !reasons.length) return { status: "FAILED", canSync: true, reasons: [], changedSinceSync };

  if (reasons.length) {
    // BLOCKED = a hard dependency outside this sheet (contact mapping, approval).
    // NOT_READY = data on this sheet the operator can fix right here.
    const blocking = reasons.some((r) => r.includes("PEAK Contact") || r.includes("not approved"));
    return { status: blocking ? "BLOCKED" : "NOT_READY", canSync: false, reasons, changedSinceSync };
  }
  return { status: "READY", canSync: true, reasons: [], changedSinceSync };
}

// ── The document ─────────────────────────────────────────────────────────────
// Turn an eligible job sheet into the PEAK expense payload.
//
// Pure, like the rest of this module: no env, no network. Every account comes from
// the chart the operator configured in the app, so this path needs none of the
// PEAK_ACCT_* variables the per-payment payout path reads.
//
// Two deliberate differences from lib/peak-payout.buildPayoutExpense:
//
//   1. ONE LINE PER EXPENSE ROW, each on its own resolved account — not two lump
//      lines on two env accounts. "Grand Palace" and "Lotus (Inc. Guide)" are the
//      accounting evidence the sheet already holds; collapsing them loses the
//      category separation the operator configured and an accountant then has to
//      reconstruct by hand. Rows in the same category merge naturally in PEAK's
//      reporting because they share an account code.
//   2. NO paidPayments. A job sheet is approved before the transfer happens, so
//      the document is an expense that is not yet settled. Telling PEAK it was paid
//      would be recording a payment that has not been made.
export type PeakExpenseLine = {
  description: string;
  quantity: number;
  price: number;
  accountCode: string;
  vatType?: string;
  withHoldingTaxAmount: number;
};

export type JobSheetExpenseDoc = {
  expense: Record<string, unknown>;
  lines: PeakExpenseLine[];
  total: number;
};

/** Thrown rather than returned: a cost silently dropped from the ledger is worse
 *  than a refusal, and a caller must not be able to ignore it by reading a field. */
export class JobSheetNotPostable extends Error {
  readonly code = "jobsheet-not-postable";
  constructor(message: string) { super(message); this.name = "JobSheetNotPostable"; }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const compact = (d: string) => d.replace(/-/g, ""); // 2026-06-28 -> 20260628

/**
 * " · WHT 3% ฿45.00" — the tax withheld from a guide-fee line, written into the line's
 * own description. PEAK stores the withholding on the line, but its printed expense
 * form has no withholding column: the amount appears only as a total at the foot of
 * the last page. Owner decision 2026-09-15: every guide-fee line shows its WHT.
 * Empty when nothing is withheld. Text only — PEAK's withHoldingTaxAmount is unchanged.
 */
export function whtNote(whtPct: number | null | undefined, wht: number): string {
  if (!(wht > 0)) return "";
  const pct = Number(whtPct) || 0;
  return ` · WHT ${pct > 0 ? `${Math.round(pct * 100) / 100}% ` : ""}${thb(wht)}`;
}

export function buildJobSheetExpense(input: {
  guideId: string;
  peakContactId: string;
  expenses: Expense[];
  guideFee: GuideFee;
  accounts: PeakAccountMap;
  /** The GUIDE_FEE account. Separate because PeakAccountMap only keys tour-expense
   *  categories — the guide fee is not one of them. */
  guideFeeAccount: PeakAccount | null;
  accountingDate: string;
  documentDate?: string | null;
  jobRef?: string | null;
  bookings?: Booking[];
  vatType?: string;
}): JobSheetExpenseDoc {
  const { guideId, peakContactId, expenses, guideFee, accounts, guideFeeAccount, accountingDate, jobRef, bookings, vatType } = input;
  if (!peakContactId) throw new JobSheetNotPostable("Guide is not mapped to a PEAK Contact");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accountingDate ?? "")) throw new JobSheetNotPostable("No accounting date set");

  const totals = jobSheetTotals(expenses, guideFee, jobRef, bookings);
  const lines: PeakExpenseLine[] = [];

  if (totals.guideFeeGross > 0) {
    const code = (guideFeeAccount?.code ?? "").trim();
    if (!code) throw new JobSheetNotPostable(`${categoryLabel("GUIDE_FEE")} has no PEAK account mapping`);
    lines.push({
      description: `${categoryLabel("GUIDE_FEE")}${jobRef ? ` — ${jobRef}` : ""}${whtNote(guideFee?.whtPct, round2(totals.whtOnFee))}`,
      quantity: 1,
      price: round2(totals.guideFeeGross),
      accountCode: code,
      vatType,
      // The fee's own withholding, not the whole of it. A review incentive is also
      // withheld on (2026-09-23) but never appears in THIS document — syncableExpenses
      // leaves review rows out — and a document must not carry tax for a line it does
      // not have. That withholding rides with the payment document, where the review
      // line is.
      withHoldingTaxAmount: round2(totals.whtOnFee),
    });
  }

  for (const e of syncableExpenses(expenses, accounts)) {
    const account = resolveExpenseAccount(e, accounts);
    // syncableExpenses only returns rows whose disposition is SYNC, which requires a
    // resolved account — so this cannot normally happen. Refuse loudly if it ever
    // does rather than post a line with a blank account code.
    if (!account?.code) {
      throw new JobSheetNotPostable(`"${e.description}" passed the readiness check with no PEAK account — refusing to post it to a blank account`);
    }
    lines.push({
      description: e.description,
      quantity: 1,
      price: round2(expenseAmount(e)),
      accountCode: account.code,
      vatType,
      withHoldingTaxAmount: 0,
    });
  }

  if (!lines.length) throw new JobSheetNotPostable("Nothing to post");

  const issued = compact(input.documentDate || accountingDate);
  return {
    lines,
    total: round2(lines.reduce((sum, l) => sum + l.price, 0)),
    expense: {
      issuedDate: issued,
      dueDate: issued,
      // Contact id only, never a name: PEAK would match-or-create from a name, and
      // our English legal names cannot match the Thai contacts, so every post would
      // fork the guide's ledger into a fresh duplicate supplier.
      contact: { id: peakContactId },
      products: lines,
      reference: jobRef ?? "",
      remark: `Folkpaths job sheet · ${guideId} · ${accountingDate}${totals.wht > 0 ? ` · WHT ${thb(round2(totals.wht))}` : ""}`,
    },
  };
}

// ── Idempotency ──────────────────────────────────────────────────────────────
// A stable fingerprint of everything that would be posted. Stored as
// lastPayloadHash after a successful sync; if it still matches, re-posting would
// create a duplicate document and must be refused. If it differs, the sheet
// changed after syncing and a human decides what to do — we never overwrite.
//
// Deliberately covers only what PEAK would see: amounts, accounts, dates, contact.
// An operator note or a receipt filename changing must not look like an accounting
// change and prompt a pointless "Update PEAK".
export function peakPayloadHash(input: {
  expenses: Expense[];
  guideFee: GuideFee;
  accountingDate?: string | null;
  peakContactId?: string | null;
  accounts?: PeakAccountMap;
}): string {
  const { expenses, guideFee, accountingDate, peakContactId, accounts = {} } = input;
  const rows = (expenses ?? [])
    .filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0)
    .map((e) => [
      expenseCategory(e) ?? "",
      resolveExpenseAccount(e, accounts)?.code ?? "",
      canonicalPaidBy(e),
      e.alreadyRecordedInPeak ? "1" : "0",
      Math.round(expenseAmount(e) * 100),
    ].join(":"))
    .sort(); // row order on the sheet is not an accounting change
  const reviews = (expenses ?? [])
    .filter(isReviewExpense)
    .map((e) => Math.round(expenseAmount(e) * 100))
    .sort((a, b) => a - b);
  const payload = [
    `contact=${peakContactId ?? ""}`,
    `date=${accountingDate ?? ""}`,
    `fee=${Math.round((guideFee?.price ?? 0) * (guideFee?.time ?? 0) * 100)}`,
    `wht=${guideFee?.whtPct ?? 0}`,
    `rows=${rows.join("|")}`,
    `rewards=${reviews.join("|")}`,
  ].join(";");
  return fnv1a(payload);
}

// Small, dependency-free 32-bit hash rendered as 8 hex chars. This is a change
// DETECTOR, not a security primitive — collisions only risk missing an "updated
// after sync" prompt, and the operator still confirms every write.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── Accounting dates ─────────────────────────────────────────────────────────
// The document date is the TOUR date by default — never the day someone happened
// to click Sync. Booking a July tour into August because that is when it was
// synced misstates the period.
export function defaultAccountingDates(tourDate: string, stored?: { accountingDate?: string | null; documentDate?: string | null }) {
  return {
    accountingDate: stored?.accountingDate || tourDate,
    documentDate: stored?.documentDate || tourDate,
  };
}
