// Payments v2 — the rules a guide payment must satisfy before it can exist.
//
// A payment is one bank transfer (FOLK-PMT-YYYYMM-NNN). It is the ONLY thing that makes
// a job PAID. It links, and never replaces:
//   Job No.   FOLK-BKK-YYYYMMDD-NN  why and how much Folkpaths owes the guide
//   EXP-…     the PEAK document     how the expense is booked
//   the slip  bank evidence         that money actually moved
//
// Reconciliation: Σ job payable + Σ signed adjustments = amount transferred, to the
// satang. An advance the guide still holds is an ADVANCE_SETTLEMENT of −฿70 — it lowers
// the transfer, never a job's expense.
//
// Pure: no database, no network. lib/payments-v2/service loads the facts and writes.
import { computeTotals, guideFeeOrStandard, isApproved, reviewRewardTotal, type Expense } from "@/lib/jobsheet";
import { guidePayoutTotal, tourCostBreakdown } from "@/lib/peak-sync";
import { advanceBlock, advanceGap, advanceGapReason, type AdvanceBlock, type JobAdvance } from "@/lib/advances/coverage";

export const ADJUSTMENT_TYPES = ["ADVANCE_SETTLEMENT", "PREVIOUS_OVERPAYMENT", "PREVIOUS_UNDERPAYMENT", "MANUAL_CORRECTION", "OTHER"] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];
export const ADJUSTMENT_LABEL: Record<AdjustmentType, string> = {
  ADVANCE_SETTLEMENT: "Advance settlement",
  PREVIOUS_OVERPAYMENT: "Previous overpayment",
  PREVIOUS_UNDERPAYMENT: "Previous underpayment",
  MANUAL_CORRECTION: "Manual correction",
  OTHER: "Other",
};
export const PAYMENT_SOURCES = ["MANUAL", "BANK_SLIP_MATCH", "SLIP_REVIEW", "PEAK_DOCUMENT"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];

/** A full Job No.: FOLK-BKK-20260819-02. A short "0819-02" is not a reference. */
export const FULL_JOB_NO = /^FOLK-[A-Z]{2,6}-\d{8}-\d{2,}$/;
export const PAYMENT_NO = /^FOLK-PMT-\d{6}-\d{3,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON = 5;

export const toSatang = (v: number) => Math.round(v * 100);
export const fromSatang = (s: number) => s / 100;
const r2 = (v: number) => fromSatang(toSatang(v));
const hasAtMostTwoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
export const bangkokToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
/** The payment date as an instant: noon in Bangkok, so it is the same calendar date everywhere. */
export const paidAtFor = (paymentDate: string) => new Date(`${paymentDate}T12:00:00+07:00`);

/** FOLK-PMT-YYYYMM-NNN — numbered within the month the money moved. */
export function paymentNoFor(paymentDate: string, seq: number): string {
  return `FOLK-PMT-${paymentDate.slice(0, 4)}${paymentDate.slice(5, 7)}-${String(seq).padStart(3, "0")}`;
}

export type JobFigures = { feeGross: number; wht: number; feeNet: number; reimbursement: number; reviewReward: number; payable: number };

/**
 * What one approved job sheet pays, split the way accounting reads it. Zero is a value:
 * a ฿0 fee pays no fee and withholds nothing — it never becomes the standard fee.
 * Reimbursement is only money the guide fronted (company-direct and advance-funded rows
 * are not owed back); review rewards are compensation, paid without withholding.
 */
export function jobFigures(expenses: Expense[] | null | undefined, guideFee: unknown): JobFigures {
  const fee = guideFeeOrStandard(guideFee);
  const t = computeTotals(expenses ?? [], fee);
  const p = guidePayoutTotal(expenses ?? [], fee);
  const reviewReward = r2(reviewRewardTotal(expenses ?? []));
  return {
    feeGross: r2(t.gross),
    wht: r2(t.wht),
    feeNet: r2(t.netGuideFee),
    reimbursement: r2(p.payoutExpenses - reviewReward),
    reviewReward,
    payable: r2(p.payout),
  };
}

export type AdjustmentInput = { type: string; amount: number; description: string; jobNo?: string | null;
  /** Phase 3: the GuideAdvance this settlement clears. Required for ADVANCE_SETTLEMENT. */
  advanceId?: string | null };

export type PaymentRequest = {
  guideId: string;
  jobs: { jobNo: string; date: string; slotIdx: number }[];
  paymentDate: string;
  amountTransferred: number;
  adjustments?: AdjustmentInput[];
  bankRef?: string | null;
  hasSlip: boolean;
  noSlipReason?: string | null;
  mismatchReason?: string | null;
  periodOverrideReason?: string | null;
  source: PaymentSource;
  /** PEAK_DOCUMENT: the combined document (FOLK-PAY-…) whose locked jobs this payment settles. */
  peakPaymentRef?: string | null;
  /**
   * Supplemental payments (lib/supplemental-payments) this transfer pays, by id. A transfer
   * pays jobs OR supplemental payments, never both: an amount left out of a closed payout
   * is paid on its own, so the earlier transfer is never re-read as larger than it was.
   */
  supplements?: string[];
  /**
   * Paid in several bank transfers (a mistyped amount topped up, or split on purpose). Each
   * is a transfer in its own right; together they are this one payment: their amounts add
   * up to `amountTransferred`, and `paymentDate` is the last of their dates.
   */
  transfers?: TransferPart[];
};

export type TransferPart = { amount: number; date: string; bankRef?: string | null; hasSlip: boolean };
export const MAX_TRANSFERS = 10;

/** What the rules need to know about one supplemental payment, loaded by the service. */
export type SupplementFacts = {
  id: string;
  guideId: string;
  type: string;
  label: string;
  accountingCategory: string;
  grossAmount: number;
  wht: number;
  netAmount: number;
  whtSource?: string | null;
  /** COMPANY_ONCE: a review incentive whose tax the company bears (owner policy 2026-10-06). */
  whtBearer?: string | null;
  /** "YYYY-MM" a review incentive books into — the month the guide worked. */
  workMonth?: string | null;
  voided: boolean;
  /** FOLK-PMT-… of the ACTIVE payment already holding it, if any. */
  activePaymentNo: string | null;
};

/** Everything the rules need to know about one job, loaded by the service. */
export type JobFacts = {
  date: string;
  slotIdx: number;
  sheet: { ref: string | null; approvalStatus: string | null; accountingDate: string | null; expenses: unknown; guideFee: unknown } | null;
  payment: { status: string | null; guidePaymentId: string | null; peakPaymentRef: string | null } | null;
  /** FOLK-PMT-… of the ACTIVE payment already holding this job, if any. */
  activePaymentNo: string | null;
  /** The month payroll (legacy) already paid it. */
  paidByPayroll: boolean;
  /** The combined PEAK document holding the job, when it is locked to one. */
  document: { paymentRef: string; peakDocumentNo: string | null; status: string } | null;
  /** The job's live company advances (lib/advances/coverage). Not loaded reads as none. */
  advances?: JobAdvance[];
};

/** A refusal a screen or report can act on without reading the sentence. */
export type PaymentBlock = AdvanceBlock;

export type Reconciliation = {
  jobTotal: number;
  /** Σ net of the supplemental payments this transfer pays (0 for a job payment). */
  supplementTotal?: number;
  adjustmentTotal: number;
  expectedTransfer: number;
  amountTransferred: number;
  difference: number; // amountTransferred − expectedTransfer
  balanced: boolean;
};

export type ResolvedJob = { jobNo: string; date: string; slotIdx: number; accountingDate: string; figures: JobFigures };

export type ResolvedSupplement = Omit<SupplementFacts, "voided" | "activePaymentNo">;

export type PaymentCheck = {
  reasons: string[];
  /** The refusals above that have a machine-readable form. Every one is also in `reasons`. */
  blocks: PaymentBlock[];
  reconciliation: Reconciliation;
  jobs: ResolvedJob[];
  supplements: ResolvedSupplement[];
  accountingPeriod: string | null;
  periods: string[];
};

/** "6,499.00 − 70.00 = 6,429.00" — the line an operator reads before recording. */
export function reconciliationLine(r: Reconciliation): string {
  const f = (v: number) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const adj = r.adjustmentTotal === 0 ? "" : ` ${r.adjustmentTotal < 0 ? "−" : "+"} ${f(r.adjustmentTotal)}`;
  const base = r.supplementTotal ? (r.jobTotal ? r.jobTotal + r.supplementTotal : r.supplementTotal) : r.jobTotal;
  return `${f(base)}${adj} = ${f(r.expectedTransfer)}${r.balanced ? " ✓" : ` · transferred ${f(r.amountTransferred)} (${r.difference > 0 ? "+" : "−"}${f(r.difference)})`}`;
}

const blank = (s: string | null | undefined) => !(s ?? "").trim();
const tooShort = (s: string | null | undefined) => (s ?? "").trim().length < MIN_REASON;

/** Every reason the payment cannot be recorded — all at once — plus its reconciliation. */
export function checkPayment(req: PaymentRequest, facts: JobFacts[], ctx: { today: string; bankRefUsedBy?: string | null; slipUsedBy?: string | null; supplements?: SupplementFacts[];
  /** Per transfer part (same order): the payment that already holds its bank reference or slip, if any. */
  partsUsedBy?: (string | null)[] }): PaymentCheck {
  const reasons: string[] = [];
  const wanted = req.supplements ?? [];
  if (blank(req.guideId)) reasons.push("Choose the guide being paid");
  if (!PAYMENT_SOURCES.includes(req.source)) reasons.push("Unknown payment source");
  if (!req.jobs.length && !wanted.length) reasons.push("Choose at least one job");
  if (req.jobs.length && wanted.length) reasons.push("A supplemental payment is paid on its own — record the jobs in a separate payment");
  if (wanted.length && req.source !== "MANUAL") reasons.push("A supplemental payment is recorded by hand, with its own slip");

  // Supplemental payments: this guide's, not withdrawn, not paid already.
  const supplements: ResolvedSupplement[] = [];
  const seenSupplement = new Set<string>();
  for (const id of wanted) {
    if (seenSupplement.has(id)) { reasons.push("A supplemental payment is selected twice"); continue; }
    seenSupplement.add(id);
    const f = (ctx.supplements ?? []).find((x) => x.id === id);
    if (!f) { reasons.push("A supplemental payment was not found — reload and try again"); continue; }
    const name = `${f.label} ${f.netAmount.toFixed(2)}`;
    if (f.guideId !== req.guideId) { reasons.push(`${name} belongs to another guide`); continue; }
    if (f.voided) { reasons.push(`${name} was voided`); continue; }
    if (f.activePaymentNo) { reasons.push(`${name} is already paid by ${f.activePaymentNo} — reverse that payment before paying it again`); continue; }
    if (!(f.netAmount > 0)) { reasons.push(`${name} pays nothing`); continue; }
    const { voided: _v, activePaymentNo: _a, ...rest } = f;
    supplements.push(rest);
  }

  const seen = new Set<string>();
  const resolved: ResolvedJob[] = [];
  for (const j of req.jobs) {
    const key = `${j.date}|${j.slotIdx}`;
    const label = (j.jobNo ?? "").trim() || `${j.date} slot ${j.slotIdx}`;
    if (seen.has(key)) { reasons.push(`${label} is selected twice`); continue; }
    seen.add(key);
    if (!FULL_JOB_NO.test((j.jobNo ?? "").trim())) { reasons.push(`${label}: use the full Job No. (FOLK-BKK-YYYYMMDD-NN)`); continue; }
    const f = facts.find((x) => x.date === j.date && x.slotIdx === j.slotIdx);
    if (!f?.sheet) { reasons.push(`${label} has no job sheet — a payment pays an approved job sheet`); continue; }
    if ((f.sheet.ref ?? "").trim() !== j.jobNo.trim()) { reasons.push(`${label} does not match the job sheet on ${j.date} (${f.sheet.ref ?? "no Job No."})`); continue; }
    if (!isApproved(f.sheet.approvalStatus)) reasons.push(`${label} is not approved — approve the job sheet first`);
    if (f.activePaymentNo) reasons.push(`${label} is already paid by ${f.activePaymentNo} — reverse that payment before paying it again`);
    else if (f.payment?.status === "PAID") reasons.push(`${label} is already marked paid (recorded before payments existed) — it cannot be paid a second time`);
    if (f.paidByPayroll) reasons.push(`${label} was paid by the guide's monthly payroll`);
    const heldBy = f.payment?.peakPaymentRef ?? null;
    if (heldBy && !(req.source === "PEAK_DOCUMENT" && req.peakPaymentRef === heldBy)) {
      reasons.push(`${label} is in combined PEAK document ${f.document?.peakDocumentNo ?? heldBy} — record the payment on that document`);
    }
    if (req.source === "PEAK_DOCUMENT" && heldBy !== req.peakPaymentRef) reasons.push(`${label} is not held by ${req.peakPaymentRef ?? "that document"}`);
    const figures = jobFigures(f.sheet.expenses as Expense[], f.sheet.guideFee);
    if (!(figures.payable > 0)) reasons.push(`${label} pays nothing — there is nothing to transfer for it`);
    const accountingDate = (f.sheet.accountingDate ?? "").trim() || j.date;
    resolved.push({ jobNo: j.jobNo.trim(), date: j.date, slotIdx: j.slotIdx, accountingDate, figures });
  }

  // One accounting month per payment, unless someone says why. A supplemental payment books
  // into the month it is paid: it has no tour of its own to take a month from.
  // A review incentive books into the month the guide worked (owner policy 2026-10-06).
  const supplementPeriod = DATE.test(req.paymentDate ?? "") ? [...new Set(supplements.map((x) => x.workMonth || req.paymentDate.slice(0, 7)))] : [];
  const periods = [...new Set([...resolved.map((j) => j.accountingDate.slice(0, 7)), ...supplementPeriod])].sort();
  if (periods.length > 1 && tooShort(req.periodOverrideReason)) reasons.push(`These jobs book into ${periods.join(" and ")} — pay each month separately, or give the reason they belong in one transfer`);

  // The actual transfer date: real, not in the future, not before the work was done.
  if (!DATE.test(req.paymentDate ?? "") || Number.isNaN(Date.parse(`${req.paymentDate}T00:00:00Z`))) reasons.push("Enter the date the money actually left the bank");
  else {
    if (req.paymentDate > ctx.today) reasons.push(`The payment date ${req.paymentDate} is in the future`);
    const latest = [...req.jobs.map((j) => j.date)].sort().pop();
    if (latest && req.paymentDate < latest) reasons.push(`The payment date ${req.paymentDate} is before the tour on ${latest}`);
  }

  // Adjustments: typed, signed, described.
  let adjSatang = 0;
  for (const [i, a] of (req.adjustments ?? []).entries()) {
    const n = `Adjustment ${i + 1}`;
    if (!ADJUSTMENT_TYPES.includes(a.type as AdjustmentType)) { reasons.push(`${n}: choose its type`); continue; }
    if (!Number.isFinite(a.amount) || a.amount === 0 || !hasAtMostTwoDecimals(a.amount)) { reasons.push(`${n}: enter a non-zero amount in baht and satang`); continue; }
    if (blank(a.description)) reasons.push(`${n}: describe it`);
    if (a.type === "ADVANCE_SETTLEMENT" && !(a.advanceId ?? "").trim()) reasons.push(`${n}: choose the advance this settles — an advance settlement clears a recorded advance, not a free amount`);
    if ((a.type === "ADVANCE_SETTLEMENT" || a.type === "PREVIOUS_OVERPAYMENT") && a.amount > 0) reasons.push(`${n}: ${ADJUSTMENT_LABEL[a.type as AdjustmentType].toLowerCase()} lowers the transfer — enter it as a negative amount`);
    if (a.type === "PREVIOUS_UNDERPAYMENT" && a.amount < 0) reasons.push(`${n}: a previous underpayment raises the transfer — enter it as a positive amount`);
    if (a.jobNo && !FULL_JOB_NO.test(a.jobNo.trim())) reasons.push(`${n}: use the full Job No. it relates to`);
    adjSatang += toSatang(a.amount);
  }

  const jobSatang = resolved.reduce((s, j) => s + toSatang(j.figures.payable), 0);
  const supplementSatang = supplements.reduce((s, x) => s + toSatang(x.netAmount), 0);
  const amountOk = Number.isFinite(req.amountTransferred) && req.amountTransferred > 0 && hasAtMostTwoDecimals(req.amountTransferred);
  if (!amountOk) reasons.push("Enter the amount transferred, in baht and satang");
  const transferSatang = amountOk ? toSatang(req.amountTransferred) : 0;
  const expected = jobSatang + supplementSatang + adjSatang;
  if ((resolved.length || supplements.length) && expected <= 0) reasons.push("After adjustments nothing is left to transfer");
  const reconciliation: Reconciliation = {
    jobTotal: fromSatang(jobSatang),
    ...(supplements.length ? { supplementTotal: fromSatang(supplementSatang) } : {}),
    adjustmentTotal: fromSatang(adjSatang),
    expectedTransfer: fromSatang(expected),
    amountTransferred: fromSatang(transferSatang),
    difference: fromSatang(transferSatang - expected),
    balanced: amountOk && transferSatang === expected,
  };
  if (amountOk && !reconciliation.balanced && tooShort(req.mismatchReason)) {
    reasons.push(`${supplements.length ? "Supplemental payments" : "Jobs"} + adjustments come to ${reconciliationLine({ ...reconciliation, balanced: true }).replace(" ✓", "")}, but ${reconciliation.amountTransferred.toFixed(2)} was transferred — correct it, add the adjustment, or give the reason`);
  }

  // A row whose payer nobody recorded cannot be paid on a guess. Paying it might
  // reimburse money the guide never spent; dropping it might swallow money they did.
  // It is counted in the tour's cost, left out of the transfer, and the transfer waits.
  for (const f of facts) {
    if (!f.sheet) continue;
    const split = tourCostBreakdown((f.sheet.expenses as Expense[]) ?? [], guideFeeOrStandard(f.sheet.guideFee));
    if (split.unresolved > 0) {
      const where = f.sheet.ref || `${f.date} slot ${f.slotIdx + 1}`;
      reasons.push(`${where} has ${split.unresolved.toFixed(2)} of expenses with no Paid By — set it on the job sheet (Guide Personal, Guide Advance or Company Direct) before paying`);
    }
  }

  // A row counted as paid from a company advance, on a job with no advance on record, is
  // out of the transfer with nothing to show the company paid it. Paying the job now would
  // settle it at the smaller figure and the amount would be gone. The transfer waits until
  // the advance is recorded or the payer is corrected (lib/advances/coverage).
  //
  // Not when a PEAK document's payment is being recorded (PEAK_DOCUMENT): by then PEAK has
  // confirmed the payment, and refusing to record a transfer that happened would leave it
  // in PEAK and nowhere here. That path is held earlier, before the transfer is offered and
  // before PEAK is touched (lib/peak-payment-server paymentBlockers).
  const blocks: PaymentBlock[] = [];
  for (const f of facts) {
    if (req.source === "PEAK_DOCUMENT") break;
    if (!f.sheet || !req.jobs.some((j) => j.date === f.date && j.slotIdx === f.slotIdx)) continue;
    const gap = advanceGap((f.sheet.expenses as Expense[]) ?? [], f.advances);
    if (!gap) continue;
    const where = f.sheet.ref || `${f.date} slot ${f.slotIdx + 1}`;
    reasons.push(advanceGapReason(where, gap));
    blocks.push(advanceBlock({ jobNo: f.sheet.ref, date: f.date, slotIdx: f.slotIdx }, gap));
  }

  // Several transfers: each one real and dated by the bank; together, exactly this payment.
  const parts = req.transfers ?? [];
  if (parts.length) {
    if (parts.length < 2) reasons.push("Several transfers means two or more — for one transfer, leave the list out");
    if (parts.length > MAX_TRANSFERS) reasons.push(`At most ${MAX_TRANSFERS} transfers in one payment`);
    let sum = 0;
    const refs = new Set<string>();
    const latestTour = [...req.jobs.map((j) => j.date)].sort().pop();
    for (const [i, p] of parts.entries()) {
      const n = `Transfer ${i + 1}`;
      if (!Number.isFinite(p.amount) || p.amount <= 0 || !hasAtMostTwoDecimals(p.amount)) reasons.push(`${n}: enter the amount the bank sent, in baht and satang`);
      else sum += toSatang(p.amount);
      if (!DATE.test(p.date ?? "")) reasons.push(`${n}: enter the date the bank sent it`);
      else {
        if (p.date > ctx.today) reasons.push(`${n}: ${p.date} is in the future`);
        if (latestTour && p.date < latestTour) reasons.push(`${n}: ${p.date} is before the tour on ${latestTour}`);
      }
      const ref = (p.bankRef ?? "").trim();
      if (ref) {
        if (refs.has(ref)) reasons.push(`${n}: bank reference ${ref} is given twice — each transfer has its own`);
        refs.add(ref);
      }
      if (!p.hasSlip && tooShort(req.noSlipReason)) reasons.push(`${n}: attach its slip, or give the reason there is none`);
      if (ctx.partsUsedBy?.[i]) reasons.push(`${n}: its ${ref ? `bank reference ${ref}` : "slip"} is already recorded on ${ctx.partsUsedBy[i]}`);
    }
    if (Number.isFinite(req.amountTransferred) && sum !== toSatang(req.amountTransferred)) reasons.push(`The transfers add up to ${(sum / 100).toFixed(2)}, not the ${Number(req.amountTransferred).toFixed(2)} given as transferred`);
    const last = parts.map((p) => p.date).filter((d) => DATE.test(d ?? "")).sort().pop();
    if (last && req.paymentDate !== last) reasons.push(`The payment date is the last transfer's date, ${last} — the day the guide had been paid in full`);
    if ((req.supplements ?? []).length && req.jobs.length) reasons.push("A payment made in several transfers carries its jobs only — record the review incentive in a payment of its own");
  }

  // Evidence.
  if (!parts.length && !req.hasSlip && tooShort(req.noSlipReason)) reasons.push("Attach the bank slip, or give the reason there is none");
  if (ctx.slipUsedBy) reasons.push(`This slip is already the evidence for ${ctx.slipUsedBy}`);
  const bankRef = (req.bankRef ?? "").trim();
  if (bankRef.length > 120) reasons.push("The bank reference is too long");
  if (bankRef && ctx.bankRefUsedBy) reasons.push(`Bank reference ${bankRef} is already recorded on ${ctx.bankRefUsedBy}`);

  return { reasons, blocks, reconciliation, jobs: resolved, supplements, accountingPeriod: periods[0] ?? null, periods };
}

/**
 * A payment recorded long after the money moved is bookkeeping, not news: recording what was
 * paid in February must not tell a guide today that "a payment is on the way". Dated more than
 * this many days before today (Bangkok) and the guide is not notified; the record is the same.
 */
export const HISTORICAL_PAYMENT_DAYS = 7;
export function isHistoricalPayment(paymentDate: string | null | undefined, now = Date.now()): boolean {
  if (!paymentDate || !/^\d{4}-\d{2}-\d{2}/.test(paymentDate)) return false;
  const today = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - HISTORICAL_PAYMENT_DAYS * 86400_000).toISOString().slice(0, 10);
  return paymentDate.slice(0, 10) < cutoff;
}
