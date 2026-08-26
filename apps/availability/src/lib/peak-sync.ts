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

import {
  expenseAmount,
  expenseCategory,
  isReviewExpense,
  computeTotals,
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
  // OTHER_TOUR_COST is the catch-all: what belongs in it can only be decided per
  // job, so it is never auto-approved. An operator clears it by recording the
  // account they chose on the row itself.
  if (cat === "other") return e.peakAccountCode ? "READY" : "NEEDS_REVIEW";
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
export type SyncDisposition = "SYNC" | "ALREADY_RECORDED" | "BLOCKED";

export function expenseDisposition(e: Expense, accounts: PeakAccountMap = {}): SyncDisposition {
  // An expense already booked in PEAK stays in this job's cost reporting but is
  // never re-sent — regardless of how well it is mapped.
  if (e.alreadyRecordedInPeak) return "ALREADY_RECORDED";
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
  return billed.length > 0 && billed.every((e) => expenseDisposition(e, accounts) !== "BLOCKED");
}

// ── Job-sheet money ──────────────────────────────────────────────────────────
// One place that computes every figure the Summary shows, so no caller can derive
// a total twice from overlapping sources.
export type JobSheetTotals = {
  totalTourExpenses: number;        // every billed tour-expense row, whoever paid
  guideFeeGross: number;            // agreed fee before tax
  wht: number;                      // withholding tax on the guide fee only
  netGuideFee: number;              // fee after WHT
  additionalGuidePayment: number;   // review rewards paid out with this job
  additionalOwnedByJob: number;     // …the part earned on THIS job (a cost of it)
  reimbursementDue: number;         // GUIDE_PERSONAL rows only
  companyDirectTotal: number;       // already paid by the company — never reimbursed
  advanceSpentTotal: number;        // paid from a guide advance — settled separately
  unspecifiedTotal: number;         // untagged rows: cannot be attributed yet
  totalCompanyCost: number;         // what this job cost the company
  netPayToGuide: number;            // what we transfer to the guide
  legacyPayout: number;             // what Payments still transfers today
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

  return {
    totalTourExpenses: cost.tourExpenses,
    guideFeeGross: t.gross,
    wht: t.wht,
    netGuideFee: t.netGuideFee,
    additionalGuidePayment,
    additionalOwnedByJob: cost.reviewOwn,
    reimbursementDue,
    companyDirectTotal: sumWhere((e) => canonicalPaidBy(e) === "COMPANY_DIRECT"),
    advanceSpentTotal: sumWhere((e) => canonicalPaidBy(e) === "GUIDE_ADVANCE"),
    unspecifiedTotal: sumWhere((e) => canonicalPaidBy(e) === "UNSPECIFIED"),
    // Unchanged on purpose (§1): tour expenses + gross fee + this job's own reward.
    totalCompanyCost: cost.jobExpenses,
    netPayToGuide,
    // What Payments/batches/my-pay still transfer: expenses + net fee, company-direct
    // rows included. Surfaced so the sheet can show the gap honestly instead of
    // quietly disagreeing with the screen that moves the money.
    legacyPayout: t.grandTotal,
    payoutDiffersFromPayments: Math.round(netPayToGuide * 100) !== Math.round(t.grandTotal * 100),
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
export type RecheckField = "totalTourExpenses" | "reimbursementDue" | "netPayToGuide";
export type Recheck = { field: RecheckField; short: string; detail: string; amount?: number };

export function figuresNeedRecheck(expenses: Expense[], totals: JobSheetTotals, accounts: PeakAccountMap = {}): Recheck[] {
  const out: Recheck[] = [];
  const rows = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);

  const untagged = rows.filter((e) => canonicalPaidBy(e) === "UNSPECIFIED");
  if (untagged.length) {
    out.push({
      field: "reimbursementDue",
      short: untagged.length === 1 ? "1 expense has no Paid By" : `${untagged.length} expenses have no Paid By`,
      detail: `Reimbursement Due and Net Pay exclude them, so both may be understated. Set Paid By on ${untagged.length === 1 ? "that row" : "those rows"} before paying.`,
      amount: totals.unspecifiedTotal,
    });
  }

  if (totals.payoutDiffersFromPayments) {
    out.push({
      field: "netPayToGuide",
      short: "Payments transfers a different amount",
      detail: `The Payments screen still pays ${thbLike(totals.legacyPayout)} — it includes expenses the company paid directly. Confirm which figure is correct before transferring.`,
      amount: Math.abs(totals.legacyPayout - totals.netPayToGuide),
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

  const unmapped = rows.filter((e) => !e.alreadyRecordedInPeak && expenseMappingStatus(e, accounts) !== "READY");
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

  if (!approved) reasons.push("Job sheet is not approved");
  if (!peakContactId) reasons.push("Guide is not mapped to a PEAK Contact");
  if (!accountingDate) reasons.push("No accounting date set");

  const billed = (expenses ?? []).filter((e) => !isReviewExpense(e) && expenseAmount(e) > 0);
  const needReview = billed.filter((e) => !e.alreadyRecordedInPeak && expenseMappingStatus(e, accounts) !== "READY");
  if (needReview.length) reasons.push(needReview.length === 1 ? "1 expense needs account review" : `${needReview.length} expenses need account review`);

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
