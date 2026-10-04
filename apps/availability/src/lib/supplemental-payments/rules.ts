// Supplemental guide payments — the rules, with no database and no network.
//
// A guide was paid for a job, and later an amount turns out to have been left out: a
// review incentive, a bonus, an adjustment. The payment that already went is closed — its
// transfer, slip, date and figures are history and stay exactly as they are. The missing
// amount becomes its OWN obligation here, and is paid by its own GuidePayment (kind
// SUPPLEMENTAL) through Payments v2 like any other transfer.
//
// Owner decisions (2026-10-01):
//   * A review incentive is additional compensation for how the tour was delivered (a
//     guest review). It is a COST OF SERVICES (ต้นทุนการให้บริการ), booked to REVIEW_REWARD —
//     PEAK 510110 ค่ารีวิวลูกค้า — kept apart from the guide fee for reporting. It is not a
//     reimbursement, not a company advance, and not a general marketing/promotion expense
//     (owner accounting policy, confirmed 2026-10-01).
//   * No withholding rate is assumed — not the guide fee's, not 3%. The rate comes from
//     configured accounting policy (SUPPLEMENTAL_WHT_PCT_<TYPE>, lib/supplemental-payments/
//     policy); with none configured the operator must enter it, and the row records which.
//   * Bonus, adjustment and other: their account is chosen explicitly; nothing guesses one.
//   * An earlier Bonus (FOLK-BNS, read-only history) still unpaid is converted into a
//     supplemental payment, once, for exactly its amount — never paid twice.

export const SUPPLEMENTAL_TYPES = ["REVIEW_INCENTIVE", "BONUS", "ADJUSTMENT", "OTHER"] as const;
export type SupplementalType = (typeof SUPPLEMENTAL_TYPES)[number];

export const SUPPLEMENTAL_LABEL: Record<SupplementalType, { en: string; th: string }> = {
  REVIEW_INCENTIVE: { en: "Review incentive", th: "ค่ารีวิว" },
  BONUS: { en: "Bonus", th: "โบนัส" },
  ADJUSTMENT: { en: "Adjustment", th: "ปรับยอดเพิ่มเติม" },
  OTHER: { en: "Other", th: "อื่น ๆ" },
};

/** The account a review incentive books to. Fixed: it is the one every review incentive uses. */
export const REVIEW_INCENTIVE_CATEGORY = "REVIEW_REWARD";

export const FULL_JOB_NO = /^FOLK-[A-Z]{2,6}-\d{8}-\d{2,}$/;
export const PEAK_EXPENSE_REF = /^EXP-\d{6}-?\d{2,}$/;
export const MIN_REASON = 5;
/** One spelling per PEAK document: EXP-202507-0012 and EXP-2025070012 are the same number. */
export const normalizePeakRef = (ref: string | null | undefined) => (ref ?? "").trim().toUpperCase().replace(/^EXP-(\d{6})-/, "EXP-$1");
export const MIN_OVERRIDE_REASON = 10;

/**
 * Review incentives — owner policy 2026-10-06 (replaces the ฿1,000 threshold of 2026-10-04).
 *
 * The guide is paid in full: ฿50 for each review that names them. The company bears the
 * withholding on their behalf, once (ผู้จ่ายออกให้ครั้งเดียว), so the income on the 50 ทวิ and
 * the 510110 expense are the transfer plus the tax, and the tax goes into ภ.ง.ด.3:
 *
 *     transfer = reviews × 50          tax = transfer × 3%   (1% through e-Withholding)
 *     income   = expense = transfer + tax
 *
 * Every amount is taxed — there is no ฿1,000 threshold. A review names the guide, not a
 * booking, so it carries no job: it books into the month the guide worked (`workMonth`),
 * one unpaid incentive per guide and month, to which later reviews are added.
 */
export const REVIEW_RATE = 50;
export const REVIEW_WHT_PCT = 3;
export const REVIEW_EWHT_PCT = 1;
export const MAX_REVIEWS = 999;
export type WhtSource = "CONFIGURED" | "ENTERED" | "BELOW_THRESHOLD" | "POLICY";
export type WhtBearer = "GUIDE" | "COMPANY_ONCE";

/** Transfer, company-borne tax and income for a number of reviews — each to the satang. */
export function reviewIncentiveFigures(reviews: number, eWithholding = false): { gross: number; wht: number; net: number; whtPct: number } {
  const whtPct = eWithholding ? REVIEW_EWHT_PCT : REVIEW_WHT_PCT;
  const net = reviews * REVIEW_RATE * 100;
  const wht = Math.floor((net * whtPct * 100 + 5000) / 10000);
  return { gross: fromSatang(net + wht), wht: fromSatang(wht), net: fromSatang(net), whtPct };
}

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A review count is a whole number of reviews, at least one. */
export const validReviewCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_REVIEWS;
/** The work month: a real month, not after this one (Bangkok). */
export function workMonthProblem(m: string | null | undefined, now: Date = new Date()): string | null {
  if (!YM.test((m ?? "").trim())) return "Choose the month the guide worked the tours these reviews are for";
  const thisMonth = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 7);
  if (m!.trim() > thisMonth) return `${m} has not happened yet — choose the month the guide worked`;
  return null;
}

const toSatang = (v: number) => Math.round(v * 100);
const fromSatang = (s: number) => s / 100;
const hasAtMostTwoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

export type SupplementalJob = { jobNo: string; date: string; slotIdx: number };

/** Gross, the tax withheld on it, and what the guide receives — each to the satang. */
export function supplementalFigures(gross: number, whtPct: number): { gross: number; wht: number; net: number } {
  // Integers only: satang × rate-in-hundredths, rounded once, half away from zero.
  const g = toSatang(gross);
  const pctHundredths = Math.round(whtPct * 100);
  const w = Math.floor((g * pctHundredths + 5000) / 10000);
  return { gross: fromSatang(g), wht: fromSatang(w), net: fromSatang(g - w) };
}

/** Is this a withholding rate at all: 0–100, baht-and-satang precision? */
export const validPct = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 100 && hasAtMostTwoDecimals(p);

export type CreateInput = {
  guideId: string;
  type: string;
  grossAmount: number;
  /** Ignored when a rate is configured for the type; required (explicit, 0 allowed) when none is. */
  whtPct?: number | null;
  accountingCategory?: string | null;
  reason: string;
  note?: string | null;
  jobs: SupplementalJob[];
  originalPaymentId?: string | null;
  duplicateOverrideReason?: string | null;
  /** The earlier Bonus this converts. Type must be BONUS and the amount exactly the bonus's. */
  legacyBonusId?: string | null;
  /** Review incentive: how many reviews named the guide (the amount is worked out from it). */
  reviewCount?: number | null;
  /** Review incentive: "YYYY-MM" the guide worked. */
  workMonth?: string | null;
  /** Review incentive paid through e-Withholding Tax: 1% instead of 3%. */
  eWithholding?: boolean | null;
};

export type LegacyBonus = { id: string; guideId: string; amount: number; period: string; paid: boolean;
  /** The live supplemental payment it was already converted into, if any. */
  convertedTo: { id: string; paidBy: string | null } | null };

/** What the rules need to know, loaded by the service. */
export type CreateFacts = {
  guideExists: boolean;
  /** Each requested job's sheet, or null when there is none for this guide. */
  sheets: { date: string; slotIdx: number; ref: string | null; reviewReward: number; reviewPaidBy: string | null }[];
  /** The configured withholding rate for this type, or null when none is configured. */
  configuredWhtPct: number | null;
  /** The bonus named by legacyBonusId, when one is. */
  legacyBonus: LegacyBonus | null;
  /** This guide's earlier bonuses still unpaid and not yet converted — a new bonus of the same amount may be one of them. */
  openLegacyBonuses: { id: string; amount: number; period: string }[];
  /** The categories with a PEAK account mapped — the accounts a payment may book to. */
  categories: string[];
  original: { guideId: string; paymentNo: string; status: string } | null;
  /** Non-void supplemental payments for this guide and type, for the duplicate check. */
  existing: { id: string; jobs: SupplementalJob[]; grossAmount: number; originalPaymentId: string | null; paidBy: string | null; createdAt: Date; whtBearer?: string | null; workMonth?: string | null }[];
};

export type CreateCheck = {
  reasons: string[];
  /** Matches that look like this payment already exists. Refused unless overridden with a reason. */
  duplicates: string[];
  figures: { gross: number; wht: number; net: number; whtPct: number; whtSource: WhtSource; whtBearer: WhtBearer } | null;
  /** A company-borne review incentive: what it is for. */
  review: { reviewCount: number; workMonth: string; eWithholding: boolean } | null;
  accountingCategory: string | null;
};

const blank = (s: string | null | undefined) => !(s ?? "").trim();
const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const thb = (v: number) => `฿${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthOf = (d: Date) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 7);

/** Every reason this supplemental payment cannot be created — all at once — and what it would be. */
export function checkCreate(input: CreateInput, facts: CreateFacts, now: Date = new Date()): CreateCheck {
  if (input.type === "REVIEW_INCENTIVE") return checkReviewIncentive(input, facts, now);
  const reasons: string[] = [];
  const type = input.type as SupplementalType;
  if (blank(input.guideId) || !facts.guideExists) reasons.push("Choose the guide this is paid to");
  if (!SUPPLEMENTAL_TYPES.includes(type)) reasons.push("Choose the type of payment");
  const label = SUPPLEMENTAL_TYPES.includes(type) ? SUPPLEMENTAL_LABEL[type].en : "This payment";

  const amountOk = Number.isFinite(input.grossAmount) && input.grossAmount > 0 && input.grossAmount <= 1_000_000 && hasAtMostTwoDecimals(input.grossAmount);
  if (!amountOk) reasons.push("Enter the amount in baht and satang — more than zero");
  if ((input.reason ?? "").trim().length < MIN_REASON) reasons.push("Say why this extra payment is being made");

  // Jobs: optional, but each one named must be this guide's job, by its full number.
  const seen = new Set<string>();
  for (const j of input.jobs ?? []) {
    const name = (j.jobNo ?? "").trim() || `${j.date} slot ${j.slotIdx}`;
    if (seen.has(key(j))) { reasons.push(`${name} is chosen twice`); continue; }
    seen.add(key(j));
    if (!FULL_JOB_NO.test((j.jobNo ?? "").trim())) { reasons.push(`${name}: use the full Job No. (FOLK-BKK-YYYYMMDD-NN)`); continue; }
    const sheet = facts.sheets.find((s) => key(s) === key(j));
    if (!sheet || (sheet.ref ?? "").trim() !== j.jobNo.trim()) { reasons.push(`${name} is not one of this guide's jobs`); continue; }
  }

  // The payout it was left out of: this guide's, and one that actually went.
  if (input.originalPaymentId) {
    if (!facts.original) reasons.push("The original payment was not found");
    else {
      if (facts.original.guideId !== input.guideId) reasons.push(`${facts.original.paymentNo} was paid to another guide`);
      if (facts.original.status !== "RECORDED") reasons.push(`${facts.original.paymentNo} was reversed — it is not a payout this could have been left out of`);
    }
  }

  // Withholding: configured policy when there is one; otherwise the operator states it.
  // Never a rate borrowed from the guide fee, and never a default nobody chose.
  let whtPct: number | null = null;
  let whtSource: WhtSource = "ENTERED";
  if (SUPPLEMENTAL_TYPES.includes(type)) {
    if (facts.configuredWhtPct !== null) { whtPct = facts.configuredWhtPct; whtSource = "CONFIGURED"; }
    else if (validPct(input.whtPct)) whtPct = input.whtPct;
    else reasons.push(`No withholding rate is configured for a ${label.toLowerCase()} — enter the rate your accountant confirmed (0 if none is withheld)`);
  }

  // Converting an earlier bonus: that bonus, this guide, exactly its amount, once, and only
  // if the old flow never paid it.
  if (input.legacyBonusId) {
    const b = facts.legacyBonus;
    if (type !== "BONUS") reasons.push("An earlier bonus converts into a bonus");
    if (!b) reasons.push("The earlier bonus was not found");
    else {
      if (b.guideId !== input.guideId) reasons.push("That earlier bonus belongs to another guide");
      if (b.paid) reasons.push(`That earlier bonus (${b.period}) already has a payment slip — it was paid in the old bonus flow and must not be paid again`);
      if (b.convertedTo) reasons.push(`That earlier bonus (${b.period}) was already converted${b.convertedTo.paidBy ? ` and paid in ${b.convertedTo.paidBy}` : " into an unpaid supplemental payment"}`);
      if (amountOk && toSatang(b.amount) !== toSatang(input.grossAmount)) reasons.push(`An earlier bonus converts for exactly its own amount (${thb(b.amount)})`);
    }
  }

  // Account: fixed for a review incentive; chosen, and mapped in PEAK, for the rest.
  let accountingCategory: string | null = null;
  if (type === "REVIEW_INCENTIVE") accountingCategory = REVIEW_INCENTIVE_CATEGORY;
  else if (SUPPLEMENTAL_TYPES.includes(type)) {
    const c = (input.accountingCategory ?? "").trim();
    if (!c) reasons.push("Choose the account this payment books to");
    else if (!facts.categories.includes(c)) reasons.push(`${c} has no PEAK account mapped — choose a mapped account`);
    else accountingCategory = c;
  }

  // Duplicates. Never silent: each match is named, and creating anyway needs a reason.
  const duplicates: string[] = [];
  if (SUPPLEMENTAL_TYPES.includes(type)) {
    const where = (e: CreateFacts["existing"][number]) => (e.paidBy ? `payment ${e.paidBy}` : `an unpaid supplemental payment created ${e.createdAt.toISOString().slice(0, 10)}`);
    for (const e of facts.existing) {
      const overlap = (input.jobs ?? []).filter((j) => e.jobs.some((x) => key(x) === key(j)));
      if (overlap.length) {
        for (const j of overlap) duplicates.push(`${label} for ${j.jobNo} is already recorded in ${where(e)}`);
        continue;
      }
      // Guide-level amounts: the same amount for the same payout, or in the same month.
      const sameAmount = amountOk && toSatang(e.grossAmount) === toSatang(input.grossAmount);
      const bothGuideLevel = !(input.jobs ?? []).length && !e.jobs.length;
      const sameOriginal = !!input.originalPaymentId && e.originalPaymentId === input.originalPaymentId;
      if (sameAmount && (sameOriginal || (bothGuideLevel && monthOf(e.createdAt) === monthOf(now)))) {
        duplicates.push(`A ${label.toLowerCase()} of ${thb(input.grossAmount)} for this guide is already recorded in ${where(e)}`);
      }
    }
    // A new bonus that may be an earlier one still waiting: convert that one instead.
    if (type === "BONUS" && !input.legacyBonusId) {
      for (const b of facts.openLegacyBonuses) {
        if (amountOk && toSatang(b.amount) === toSatang(input.grossAmount)) duplicates.push(`An earlier bonus of ${thb(b.amount)} (${b.period}) for this guide is still unpaid — convert that bonus instead of adding a new one`);
      }
    }
    // A review incentive the job sheet itself already carries — paid with the job, or
    // still waiting on it. Paying it here as well would pay it twice.
    if (type === "REVIEW_INCENTIVE") {
      for (const j of input.jobs ?? []) {
        const s = facts.sheets.find((x) => key(x) === key(j));
        if (s && s.reviewReward > 0) {
          duplicates.push(`${j.jobNo} already carries a review incentive of ${thb(s.reviewReward)} on its job sheet${s.reviewPaidBy ? `, paid in ${s.reviewPaidBy}` : ", to be paid with the job"}`);
        }
      }
    }
  }
  if (duplicates.length && (input.duplicateOverrideReason ?? "").trim().length < MIN_OVERRIDE_REASON) {
    reasons.push("This looks like a payment that already exists — check the matches above, or give the reason it is a separate payment");
  }

  const figures = amountOk && whtPct !== null ? { ...supplementalFigures(input.grossAmount, whtPct), whtPct, whtSource, whtBearer: "GUIDE" as const } : null;
  if (figures && !(figures.net > 0)) reasons.push("After withholding nothing is left to pay");
  return { reasons, duplicates, figures, accountingCategory, review: null };
}

/**
 * A review incentive (owner policy 2026-10-06): reviews × ฿50 to the guide in full, the tax
 * borne by the company. It names the guide and the month they worked — never a booking or
 * job, which a review that mentions the guide cannot point to.
 */
function checkReviewIncentive(input: CreateInput, facts: CreateFacts, now: Date): CreateCheck {
  const reasons: string[] = [];
  if (blank(input.guideId) || !facts.guideExists) reasons.push("Choose the guide this is paid to");
  const countOk = validReviewCount(input.reviewCount);
  if (!countOk) reasons.push(`Enter how many reviews named the guide — a whole number from 1 to ${MAX_REVIEWS}`);
  const monthProblem = workMonthProblem(input.workMonth, now);
  if (monthProblem) reasons.push(monthProblem);
  if ((input.jobs ?? []).length) reasons.push("A review incentive is for the guide and the month they worked — it does not name jobs");
  if (input.originalPaymentId || input.legacyBonusId) reasons.push("A review incentive is paid on its own terms — it is not linked to an earlier payment or bonus");
  if ((input.reason ?? "").trim().length < MIN_REASON) reasons.push("Say where the reviews came from (e.g. GetYourGuide reviews naming the guide)");
  const workMonth = (input.workMonth ?? "").trim();
  // One open incentive per guide and month: later reviews are added to it, not paid apart.
  const open = facts.existing.find((e) => e.whtBearer === "COMPANY_ONCE" && e.workMonth === workMonth && !e.paidBy);
  if (!monthProblem && open) reasons.push(`There is already an unpaid review incentive for ${workMonth} — add these reviews to it instead`);
  if (!facts.categories.includes(REVIEW_INCENTIVE_CATEGORY)) reasons.push(`${REVIEW_INCENTIVE_CATEGORY} has no PEAK account mapped`);
  const eWithholding = !!input.eWithholding;
  const figures = countOk ? { ...reviewIncentiveFigures(input.reviewCount as number, eWithholding), whtSource: "POLICY" as const, whtBearer: "COMPANY_ONCE" as const } : null;
  return {
    reasons, duplicates: [], figures, accountingCategory: REVIEW_INCENTIVE_CATEGORY,
    review: countOk && !monthProblem ? { reviewCount: input.reviewCount as number, workMonth, eWithholding } : null,
  };
}

export type PaymentState = "UNPAID" | "PAID" | "VOID";
export type AccountingState = "NOT_PAID" | "ACCOUNTING_PENDING" | "RECONCILED" | "VOID";

/** Where a supplemental payment stands. Derived from the row and its lines — never stored. */
export function supplementalState(row: { voidedAt?: Date | string | null; peakRef?: string | null }, activePaymentNo: string | null): { payment: PaymentState; accounting: AccountingState } {
  if (row.voidedAt) return { payment: "VOID", accounting: "VOID" };
  if (!activePaymentNo) return { payment: "UNPAID", accounting: "NOT_PAID" };
  return { payment: "PAID", accounting: (row.peakRef ?? "").trim() ? "RECONCILED" : "ACCOUNTING_PENDING" };
}

export const STATE_LABEL: Record<PaymentState | AccountingState, string> = {
  UNPAID: "Unpaid · ยังไม่จ่าย",
  PAID: "Paid · จ่ายแล้ว",
  VOID: "Void · ยกเลิก",
  NOT_PAID: "—",
  ACCOUNTING_PENDING: "Accounting pending · รอบันทึกบัญชี",
  RECONCILED: "Reconciled · บันทึกบัญชีแล้ว",
};
