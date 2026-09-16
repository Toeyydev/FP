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
import { guidePayoutTotal } from "@/lib/peak-sync";

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

export type AdjustmentInput = { type: string; amount: number; description: string; jobNo?: string | null };

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
};

export type Reconciliation = {
  jobTotal: number;
  adjustmentTotal: number;
  expectedTransfer: number;
  amountTransferred: number;
  difference: number; // amountTransferred − expectedTransfer
  balanced: boolean;
};

export type ResolvedJob = { jobNo: string; date: string; slotIdx: number; accountingDate: string; figures: JobFigures };

export type PaymentCheck = {
  reasons: string[];
  reconciliation: Reconciliation;
  jobs: ResolvedJob[];
  accountingPeriod: string | null;
  periods: string[];
};

/** "6,499.00 − 70.00 = 6,429.00" — the line an operator reads before recording. */
export function reconciliationLine(r: Reconciliation): string {
  const f = (v: number) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const adj = r.adjustmentTotal === 0 ? "" : ` ${r.adjustmentTotal < 0 ? "−" : "+"} ${f(r.adjustmentTotal)}`;
  return `${f(r.jobTotal)}${adj} = ${f(r.expectedTransfer)}${r.balanced ? " ✓" : ` · transferred ${f(r.amountTransferred)} (${r.difference > 0 ? "+" : "−"}${f(r.difference)})`}`;
}

const blank = (s: string | null | undefined) => !(s ?? "").trim();
const tooShort = (s: string | null | undefined) => (s ?? "").trim().length < MIN_REASON;

/** Every reason the payment cannot be recorded — all at once — plus its reconciliation. */
export function checkPayment(req: PaymentRequest, facts: JobFacts[], ctx: { today: string; bankRefUsedBy?: string | null; slipUsedBy?: string | null }): PaymentCheck {
  const reasons: string[] = [];
  if (blank(req.guideId)) reasons.push("Choose the guide being paid");
  if (!PAYMENT_SOURCES.includes(req.source)) reasons.push("Unknown payment source");
  if (!req.jobs.length) reasons.push("Choose at least one job");

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

  // One accounting month per payment, unless someone says why.
  const periods = [...new Set(resolved.map((j) => j.accountingDate.slice(0, 7)))].sort();
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
    if ((a.type === "ADVANCE_SETTLEMENT" || a.type === "PREVIOUS_OVERPAYMENT") && a.amount > 0) reasons.push(`${n}: ${ADJUSTMENT_LABEL[a.type as AdjustmentType].toLowerCase()} lowers the transfer — enter it as a negative amount`);
    if (a.type === "PREVIOUS_UNDERPAYMENT" && a.amount < 0) reasons.push(`${n}: a previous underpayment raises the transfer — enter it as a positive amount`);
    if (a.jobNo && !FULL_JOB_NO.test(a.jobNo.trim())) reasons.push(`${n}: use the full Job No. it relates to`);
    adjSatang += toSatang(a.amount);
  }

  const jobSatang = resolved.reduce((s, j) => s + toSatang(j.figures.payable), 0);
  const amountOk = Number.isFinite(req.amountTransferred) && req.amountTransferred > 0 && hasAtMostTwoDecimals(req.amountTransferred);
  if (!amountOk) reasons.push("Enter the amount transferred, in baht and satang");
  const transferSatang = amountOk ? toSatang(req.amountTransferred) : 0;
  const expected = jobSatang + adjSatang;
  if (resolved.length && expected <= 0) reasons.push("After adjustments nothing is left to transfer");
  const reconciliation: Reconciliation = {
    jobTotal: fromSatang(jobSatang),
    adjustmentTotal: fromSatang(adjSatang),
    expectedTransfer: fromSatang(expected),
    amountTransferred: fromSatang(transferSatang),
    difference: fromSatang(transferSatang - expected),
    balanced: amountOk && transferSatang === expected,
  };
  if (amountOk && !reconciliation.balanced && tooShort(req.mismatchReason)) {
    reasons.push(`Jobs + adjustments come to ${reconciliationLine({ ...reconciliation, balanced: true }).replace(" ✓", "")}, but ${reconciliation.amountTransferred.toFixed(2)} was transferred — correct it, add the adjustment, or give the reason`);
  }

  // Evidence.
  if (!req.hasSlip && tooShort(req.noSlipReason)) reasons.push("Attach the bank slip, or give the reason there is none");
  if (ctx.slipUsedBy) reasons.push(`This slip is already the evidence for ${ctx.slipUsedBy}`);
  const bankRef = (req.bankRef ?? "").trim();
  if (bankRef.length > 120) reasons.push("The bank reference is too long");
  if (bankRef && ctx.bankRefUsedBy) reasons.push(`Bank reference ${bankRef} is already recorded on ${ctx.bankRefUsedBy}`);

  return { reasons, reconciliation, jobs: resolved, accountingPeriod: periods[0] ?? null, periods };
}
