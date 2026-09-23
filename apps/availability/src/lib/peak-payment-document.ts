// "Pay N jobs together · one ref" → ONE PEAK document, in two stages.
//
// A guide is often paid for several tours in a single bank transfer. PEAK must hold
// that as ONE expense document — one contact, one reference, a line per job and
// category — so the ledger shows one payable that one bank statement line settles,
// while every line still names the job it belongs to.
//
// Creating the expense document is not the same thing as paying it:
//   stage 1  createCombinedDocument — ONE unpaid expense in PEAK → its EXP number.
//            Nothing is paid, no slip, no guide notice. The jobs are locked to it.
//   stage 2  payCombinedDocument — after the operator has reviewed that EXP in PEAK
//            and made the transfer, the payment is recorded against the SAME EXP.
//            Only then are the jobs PAID and the guide told.
//
// This file is pure: no database, no network. The routes supply the jobs and the
// saved account chart, and the side effects arrive through CreateDocumentDeps and
// PayDocumentDeps — which is what lets the order of operations be tested without either.
import { computeTotals, expenseAmount, expenseCategory, isReviewExpense, thb, type Expense, type GuideFee } from "@/lib/jobsheet";
import { categoryLabel } from "@/lib/peak-accounts";
import {
  canonicalPaidBy,
  guidePayoutTotal,
  resolveExpenseAccount,
  whtNote,
  type PeakAccount,
  type PeakAccountMap,
  tourCostBreakdown,
} from "@/lib/peak-sync";

const round2 = (n: number) => Math.round(n * 100) / 100;
const compact = (d: string) => d.replace(/-/g, ""); // 2026-09-13 -> 20260913
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Inputs ───────────────────────────────────────────────────────────────────

export type PaymentJob = {
  date: string;
  slotIdx: number;
  /** FOLK-BKK-… — required: it is the only thing tying a PEAK line back to its job. */
  ref: string | null;
  expenses: Expense[];
  guideFee: GuideFee;
  origin?: string | null;
};

export type PaymentAccounts = {
  guideFee: PeakAccount | null;
  reviewReward: PeakAccount | null;
  /** Tour-expense category defaults from the saved chart — includes `other` only when
   *  an Other Tour Cost default has been saved. A row's own account always wins. */
  categories: PeakAccountMap;
};

// ── Output ───────────────────────────────────────────────────────────────────

/** Exactly the product fields PEAK's Expenses/allinone accepts — nothing extra. */
export type PeakPaymentLine = {
  description: string;
  quantity: number;
  price: number;
  accountCode: string;
  vatType?: string;
  withHoldingTaxAmount: number;
};

export type PaymentLineKind = "GUIDE_FEE" | "REIMBURSEMENT" | "REVIEW_REWARD";

/** What each line was built from. Stored with the document, never sent to PEAK. */
export type PaymentLineTrace = {
  description: string; // exactly as sent to PEAK
  jobRef: string;
  date: string;
  slotIdx: number;
  kind: PaymentLineKind;
  category: string | null; // accounting category code, e.g. OTHER_TOUR_COST
  accountCode: string;
  price: number;
  wht: number;
};

export type GuidePaymentDocument = {
  paymentRef: string;
  expense: Record<string, unknown>;
  lines: PeakPaymentLine[];
  traces: PaymentLineTrace[];
  gross: number;  // Σ line prices
  wht: number;    // Σ withholding
  total: number;  // net paid = gross − wht = Σ each job's payout = the transfer
  jobs: { date: string; slotIdx: number; ref: string; payout: number }[];
  issuedDate: string;
};

/** A row the transfer pays that the document cannot book: it has no expense category.
 *  Listed row by row so the operator can go straight to each one — never filled in
 *  automatically, because the category decides the account the cost books to. */
export type MissingCategoryRow = {
  jobRef: string;       // the job's number, or "date slot n" for a sheet without one
  date: string;
  slotIdx: number;
  rowNo: number;        // the row's number as the job sheet shows it
  description: string;
  amount: number;
};

/** Thrown with EVERY reason at once — an operator fixing one problem per click, only to
 *  meet the next, is how a payment gets abandoned half-done. */
export class PaymentDocumentNotPostable extends Error {
  readonly code = "payment-document-not-postable";
  constructor(readonly reasons: string[], readonly missingCategories: MissingCategoryRow[] = []) {
    super(reasons.join("; "));
    this.name = "PaymentDocumentNotPostable";
  }
}

export function paymentRefFor(paymentDate: string, seq: number): string {
  return `FOLK-PAY-${paymentDate.slice(0, 7).replace("-", "")}-${String(seq).padStart(2, "0")}`;
}

// ── The builder ──────────────────────────────────────────────────────────────

/**
 * Stage 1: the unpaid expense document for these jobs. No payment date, no Paid By
 * account and no slip belong here — nothing is being paid yet.
 */
export function buildGuidePaymentDocument(input: {
  guideId: string;
  peakContactId: string | null | undefined;
  paymentRef: string;
  jobs: PaymentJob[];
  accounts: PaymentAccounts;
  vatType?: string;
  /** "YYYY-MM-DD" (Bangkok) the document is created — its due date. Omitted: due on the issued date. */
  createdOn?: string;
}): GuidePaymentDocument {
  const { guideId, peakContactId, paymentRef, accounts, vatType } = input;
  const reasons = new Set<string>();

  if (!peakContactId) reasons.add("Guide is not mapped to a PEAK Contact — map them on one of their job sheets first");
  if (!input.jobs?.length) reasons.add("Select at least one job");

  // Stable order: the document reads job by job, in the order the tours ran.
  const jobs = [...(input.jobs ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.slotIdx - b.slotIdx);

  const seen = new Set<string>();
  for (const j of jobs) {
    const k = `${j.date}|${j.slotIdx}`;
    if (seen.has(k)) reasons.add(`The job on ${j.date} slot ${j.slotIdx} is selected twice`);
    seen.add(k);
  }

  // One document has one issued date, and it books the cost into one period. Jobs from
  // two months in one document would put one month's tours into the other's books.
  const months = [...new Set(jobs.map((j) => j.date.slice(0, 7)))];
  if (months.length > 1) reasons.add(`These jobs span ${months.join(" and ")} — pay each month separately so each document books into its own period`);

  const latest = jobs.length ? jobs[jobs.length - 1].date : "";

  const lines: PeakPaymentLine[] = [];
  const traces: PaymentLineTrace[] = [];
  const missingCategories: MissingCategoryRow[] = [];
  const outJobs: GuidePaymentDocument["jobs"] = [];
  let expected = 0;

  for (const j of jobs) {
    const where = j.ref || `${j.date} slot ${j.slotIdx}`;
    if (j.origin === "HISTORICAL_BACKFILL") {
      reasons.add(`${where} was reconstructed from historical records and cannot be posted to PEAK`);
    }
    if (!(j.ref ?? "").trim()) reasons.add(`${where} has no job sheet number — every PEAK line must name its job`);
    const ref = (j.ref ?? "").trim();
    const expenses = j.expenses ?? [];
    const groups = new Map<string, { kind: PaymentLineKind; category: string | null; code: string; label: string; amount: number }>();
    const push = (kind: PaymentLineKind, category: string | null, code: string, price: number, lineWht: number, description: string) => {
      lines.push({ description, quantity: 1, price, accountCode: code, vatType, withHoldingTaxAmount: lineWht });
      traces.push({ description, jobRef: ref, date: j.date, slotIdx: j.slotIdx, kind, category, accountCode: code, price, wht: lineWht });
    };
    const add = (kind: PaymentLineKind, category: string | null, code: string, label: string, amount: number) => {
      const k = `${kind}|${category}|${code}`;
      const g = groups.get(k) ?? { kind, category, code, label, amount: 0 };
      g.amount += amount;
      groups.set(k, g);
    };

    // The amount the Payments page transfers for this job. The document is built to
    // equal it, and checked against it below — the slip and the ledger must agree.
    const payout = round2(guidePayoutTotal(expenses, j.guideFee).payout);
    expected = round2(expected + payout);
    outJobs.push({ date: j.date, slotIdx: j.slotIdx, ref, payout });

    // Guide fee: posted GROSS with its withholding, so PEAK files the WHT the company
    // owes the Revenue Department. Posting the net figure would erase that tax from
    // the books while the transfer still matches.
    // One split, computed once: the fee's own withholding and the review incentive's,
    // taken from the same figures the transfer is built on so the document's tax can
    // never disagree with what was actually withheld.
    const jobTotals = computeTotals(expenses, j.guideFee as GuideFee);
    const gross = round2((Number(j.guideFee?.price) || 0) * (Number(j.guideFee?.time) || 0));
    const wht = round2(jobTotals.whtOnFee);
    const reviewWht = round2(jobTotals.whtOnReview);
    if (gross > 0) {
      const code = (accounts.guideFee?.code ?? "").trim();
      if (!code) reasons.add(`${categoryLabel("GUIDE_FEE")} has no PEAK account mapping`);
      push("GUIDE_FEE", "GUIDE_FEE", code, gross, wht, `Guide fee - ${ref}${whtNote(j.guideFee?.whtPct, wht)}`);
    }

    // Everything else still owed to the guide, grouped per job + category + account.
    // Company-direct and advance rows were never the guide's money, so they are not in
    // this transfer and not in this document.
    //
    // `rowNo` is the row's number as the job sheet shows it: the expense table numbers
    // every non-review row, including rows with no amount.
    let rowNo = 0;
    for (const e of expenses) {
      const review = isReviewExpense(e);
      if (!review) rowNo++;
      const amt = expenseAmount(e);
      if (!amt) continue;
      const desc = (e.description ?? "").trim() || "an expense row";

      if (isReviewExpense(e)) {
        // Included because the reward is part of the money transferred (owner decision,
        // 2026-09-13), booked to the REVIEW_REWARD account (510110) — and withheld on
        // at the guide's rate since 2026-09-23, when the owner answered the question
        // this line used to carry: a review incentive is extra pay for the guide's
        // work, so it belongs in the ภ.ง.ด.3 base beside the fee.
        const code = (accounts.reviewReward?.code ?? "").trim();
        if (!code) reasons.add(`${categoryLabel("REVIEW_REWARD")} has no PEAK account mapping`);
        add("REVIEW_REWARD", "REVIEW_REWARD", code, "Review incentive", amt);
        continue;
      }

      const paid = canonicalPaidBy(e);
      if (paid === "COMPANY_DIRECT" || paid === "GUIDE_ADVANCE") continue;
      // Who paid decides whether this money belongs in the transfer at all: a guide's
      // own money is reimbursed, company money is not. Unknown is not a default — the
      // Payments page counts such a row as owed, but a PEAK document would book it as a
      // reimbursement nobody confirmed. Refused, like the job-sheet sync refuses it.
      if (paid === "UNSPECIFIED") {
        const raw = (e.paidBy ?? "").trim();
        reasons.add(`${where} row ${rowNo} "${desc}": ${raw ? `Paid By "${raw}" is not recognised` : "Paid By is not set"} — set it on the job sheet (Guide Personal, Guide Advance or Company Direct)`);
        continue;
      }

      if (e.alreadyRecordedInPeak) {
        reasons.add(`"${desc}" on ${where} is marked as already in PEAK but is still being paid to the guide — it cannot be both`);
        continue;
      }
      const key = expenseCategory(e);
      if (!key) {
        missingCategories.push({ jobRef: where, date: j.date, slotIdx: j.slotIdx, rowNo, description: desc, amount: round2(amt) });
        reasons.add(`${where} row ${rowNo} "${desc}" (${thb(round2(amt))}) has no expense category — set it on the job sheet`);
        continue;
      }
      const category = categoryCode(key);
      // A row's own account first, then the saved category default — the same
      // resolution the job-sheet document uses, so a job books to one account either way.
      const code = (resolveExpenseAccount(e, accounts.categories)?.code ?? "").trim();
      if (!code) {
        reasons.add(key === "other"
          ? `${categoryLabel(category)} "${desc}" on ${where} has no PEAK account — choose one on the row, or set an Other Tour Cost default under PEAK sync`
          : `${categoryLabel(category)} has no PEAK account mapping`);
        continue;
      }
      add("REIMBURSEMENT", category, code, `Reimbursement / ${categoryLabel(category)}`, amt);
    }
    for (const g of groups.values()) {
      const lineWht = g.kind === "REVIEW_REWARD" ? reviewWht : 0;
      push(g.kind, g.category, g.code, round2(g.amount), lineWht, `${g.label} - ${ref}${lineWht > 0 ? whtNote(j.guideFee?.whtPct, lineWht) : ""}`);
    }
  }

  const gross = round2(lines.reduce((s, l) => s + l.price, 0));
  const wht = round2(lines.reduce((s, l) => s + l.withHoldingTaxAmount, 0));
  const total = round2(gross - wht);

  if (jobs.length && !lines.length) reasons.add("Nothing to pay on these jobs");
  if (!reasons.size && total !== expected) {
    // Cannot happen while this mirrors guidePayoutTotal. If the two ever drift, the
    // document would book a different amount from the transfer — refuse instead.
    reasons.add(`The document total ${total.toFixed(2)} does not match the jobs' payout ${expected.toFixed(2)}`);
  }
  // ── The invariant, checked against the result rather than trusted ───────────
  //
  // Money the company already spent on the guide's behalf — a ticket bought from an
  // advance, an invoice paid direct to a vendor — is a cost of the tour and must not
  // be in this document: PEAK books it once already, through the advance ledger or
  // the supplier invoice, and booking it here pays for it twice.
  //
  // The loop above skips those rows. This checks that it did, by adding the lines back
  // up and comparing them with what the payer split says the job owes. A future edit
  // that drops the skip fails here instead of quietly paying an advance a second time.
  for (const j of input.jobs) {
    const where = j.ref || `${j.date} slot ${j.slotIdx + 1}`;
    const split = tourCostBreakdown(j.expenses ?? [], j.guideFee);
    const mine = traces.filter((t) => t.date === j.date && t.slotIdx === j.slotIdx);
    const booked = round2(mine.reduce((sum, t) => sum + (Number(t.price) || 0), 0));
    if (booked !== split.grossPayable) {
      const notOwed = round2(split.fundedByAdvance + split.fundedByCompany);
      reasons.add(
        `${where} would book ${thb(booked)} but only ${thb(split.grossPayable)} is owed to the guide` +
        (notOwed > 0 ? ` — ${thb(notOwed)} of this job was already paid by the company (advance or direct) and must not be transferred again` : "") +
        ". Nothing was created.",
      );
    }
  }

  if (reasons.size) throw new PaymentDocumentNotPostable([...reasons], missingCategories);

  const issuedDate = compact(latest);
  // Due the day it is created, never before it is issued. Due on the tour date, a
  // document created weeks after the tour showed "เกินเวลาชำระ" (overdue) in PEAK the
  // moment it existed (owner decision 2026-09-15). PEAK requires dueDate ≥ issuedDate.
  const created = DATE.test(input.createdOn ?? "") ? compact(input.createdOn!) : "";
  const dueDate = created > issuedDate ? created : issuedDate;
  return {
    paymentRef,
    lines,
    traces,
    gross,
    wht,
    total,
    jobs: outJobs,
    issuedDate,
    expense: {
      // Dated when the last tour ran, so the cost books into the month the service was
      // delivered; the payment, recorded later, carries its own date.
      issuedDate,
      dueDate,
      // Contact id only, never a name — see buildJobSheetExpense for why a name forks
      // the guide into a duplicate supplier.
      contact: { id: peakContactId },
      products: lines,
      reference: paymentRef,
      remark: `Folkpaths guide payment ${paymentRef} · ${guideId} · ${jobs.length} job${jobs.length === 1 ? "" : "s"}${wht > 0 ? ` · WHT ${thb(wht)} · transfer ${thb(total)}` : ""}`,
      // Deliberately no paidPayments: this creates an UNPAID expense. The payment is
      // recorded against this same document in stage 2 (payCombinedDocument).
    },
  };
}

const CATEGORY_CODE: Record<string, string> = {
  entrance: "ENTRANCE_TICKET",
  transport: "TRANSPORTATION",
  meal: "MEAL_REFRESHMENT",
  other: "OTHER_TOUR_COST",
};
const categoryCode = (key: string) => CATEGORY_CODE[key] ?? key.toUpperCase();

// ── What a PEAK write means ──────────────────────────────────────────────────

export type ExpenseWriteResult = { ok: boolean; code?: string; id?: string; link?: string; desc?: string; uncertain?: boolean };

export type WriteOutcome =
  | { status: "POSTED"; documentNo: string; documentId: string | null; documentLink: string | null }
  | { status: "FAILED"; reason: string }
  | { status: "UNCERTAIN"; reason: string };

/**
 * FAILED means PEAK answered and refused: nothing was created, so the jobs can be
 * released and paid again. UNCERTAIN means the request may have reached PEAK and the
 * answer was lost: releasing the jobs then would let the next click create a SECOND
 * document for the same transfer, so they stay locked until a person looks in PEAK.
 */
export function classifyExpenseWrite(r: ExpenseWriteResult): WriteOutcome {
  const code = (r.code ?? "").trim();
  if (r.ok && code) return { status: "POSTED", documentNo: code, documentId: r.id ?? null, documentLink: r.link ?? null };
  const reason = (r.desc ?? "").trim() || "PEAK returned no document number and no reason";
  return r.uncertain ? { status: "UNCERTAIN", reason } : { status: "FAILED", reason };
}

/** PEAK's insertfile documents only "image" and "document" as file types. */
export function attachmentFileType(mime: string): "image" | "document" {
  return /^image\//i.test(mime ?? "") ? "image" : "document";
}

// ── Where a combined document is ─────────────────────────────────────────────

export type PaymentDocumentStatus =
  | "CREATING" | "CREATE_UNCERTAIN" | "FAILED" | "AWAITING_PAYMENT"
  | "PAYING" | "PAYMENT_UNCERTAIN" | "PAID" | "VOIDED";

/** A stored status as the two-stage flow reads it. The one-step flow this replaced
 *  wrote POSTING / POSTED / UNCERTAIN, and a row it left behind must still read right. */
export function documentStatus(raw: string | null | undefined): PaymentDocumentStatus | null {
  switch (raw) {
    case "POSTING": return "CREATING";
    case "UNCERTAIN": return "CREATE_UNCERTAIN";
    case "POSTED": return "PAID";
    case "CREATING": case "CREATE_UNCERTAIN": case "FAILED": case "AWAITING_PAYMENT":
    case "PAYING": case "PAYMENT_UNCERTAIN": case "PAID": case "VOIDED":
      return raw;
    default: return null;
  }
}

/** Whether a document still holds its jobs. FAILED and VOIDED let them go. */
export const documentHoldsJobs = (raw: string | null | undefined) => {
  const st = documentStatus(raw);
  return st !== null && st !== "FAILED" && st !== "VOIDED";
};

// ── Stage 1: create the expense document ─────────────────────────────────────

export type CreateDocumentDeps = {
  /** Record the document as CREATING and lock every job to its paymentRef, atomically.
   *  Throws when any job is already paid, locked or otherwise not payable — before
   *  anything is sent to PEAK. */
  claim(doc: GuidePaymentDocument): Promise<void>;
  /** POST the unpaid expense. */
  createExpense(expense: Record<string, unknown>): Promise<ExpenseWriteResult>;
  /** PEAK created it: store the EXP and move to AWAITING_PAYMENT. The jobs stay unpaid. */
  recordCreated(p: { paymentRef: string; documentNo: string; documentId: string | null; documentLink: string | null }): Promise<void>;
  /** FAILED releases the jobs; UNCERTAIN (CREATE_UNCERTAIN) keeps them locked. */
  recordCreateFailed(p: { paymentRef: string; reason: string; uncertain: boolean }): Promise<void>;
};

export type CreateDocumentResult =
  | {
      status: "AWAITING_PAYMENT"; paymentRef: string; documentNo: string; documentId: string | null; documentLink: string | null;
      gross: number; wht: number; total: number; lines: number;
      /** PEAK has the document but FolkOPS could not record it. The jobs stay locked, so
       *  nothing can create a second one; resolve it on the Payments page. */
      recordError: string | null;
    }
  | { status: "FAILED"; paymentRef: string; reason: string }
  | { status: "UNCERTAIN"; paymentRef: string; reason: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Claim → ONE unpaid PEAK expense → AWAITING_PAYMENT.
 *
 * Never retried here. When PEAK may have created the document and the answer was lost,
 * the jobs stay locked (CREATE_UNCERTAIN) until a person looks in PEAK — pressing again
 * could otherwise leave two documents for one transfer.
 */
export async function createCombinedDocument(deps: CreateDocumentDeps, doc: GuidePaymentDocument): Promise<CreateDocumentResult> {
  const { paymentRef } = doc;
  await deps.claim(doc); // refusal propagates: nothing has happened yet

  let outcome: WriteOutcome;
  try {
    outcome = classifyExpenseWrite(await deps.createExpense(doc.expense));
  } catch (e) {
    // We cannot prove the request never left, so this is the careful answer.
    outcome = { status: "UNCERTAIN", reason: msg(e) };
  }

  if (outcome.status !== "POSTED") {
    const uncertain = outcome.status === "UNCERTAIN";
    // A failure to write this down leaves the jobs locked — the safe direction.
    await deps.recordCreateFailed({ paymentRef, reason: outcome.reason, uncertain }).catch(() => {});
    return uncertain ? { status: "UNCERTAIN", paymentRef, reason: outcome.reason } : { status: "FAILED", paymentRef, reason: outcome.reason };
  }

  const { documentNo, documentId, documentLink } = outcome;
  let recordError: string | null = null;
  try {
    await deps.recordCreated({ paymentRef, documentNo, documentId, documentLink });
  } catch (e) {
    recordError = `PEAK created ${documentNo}, but FolkOPS could not record it: ${msg(e)}`;
  }
  return { status: "AWAITING_PAYMENT", paymentRef, documentNo, documentId, documentLink, gross: doc.gross, wht: doc.wht, total: doc.total, lines: doc.lines.length, recordError };
}

// ── Stage 2: record the payment against that same document ───────────────────

/** Thrown with every reason a payment cannot be recorded yet. Nothing has happened. */
export class PaymentNotRecordable extends Error {
  readonly code = "payment-not-recordable";
  constructor(readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "PaymentNotRecordable";
  }
}

export type PaymentInput = {
  paymentDate: string;
  paymentMethodId: string;
  amount: number;
};

/**
 * The payment to record against an AWAITING_PAYMENT document, or every reason it
 * cannot be. The amount is the document's own net total — never typed, so the payment
 * can only ever settle the document exactly.
 */
export function buildPaymentInput(input: {
  document: { status: string | null | undefined; peakDocumentNo: string | null | undefined; total: number; jobs: { date: string }[] };
  /** The EXP the operator was looking at. Must be the document's, or nothing is paid. */
  expectedDocumentNo: string;
  paymentDate: string;
  paymentMethodId: string;
  today: string;
}): PaymentInput {
  const { document, paymentDate, paymentMethodId, today } = input;
  const reasons: string[] = [];
  const status = documentStatus(document.status);
  const docNo = (document.peakDocumentNo ?? "").trim();
  if (status === "PAID") reasons.push(`This payment is already recorded against ${docNo || "its PEAK document"}`);
  else if (status !== "AWAITING_PAYMENT") reasons.push(`There is no PEAK document awaiting payment here (status ${status ?? "unknown"})`);
  if (!docNo) reasons.push("The PEAK document number is missing — this document cannot be paid");
  else if (input.expectedDocumentNo.trim() !== docNo) reasons.push(`This payment is for ${docNo}, not ${input.expectedDocumentNo.trim() || "an unnamed document"} — reload Payments`);
  if (!(paymentMethodId ?? "").trim()) reasons.push("Choose the account the money was paid from (Paid By)");
  if (!DATE.test(paymentDate ?? "")) reasons.push("Choose the payment date");
  const latest = [...document.jobs.map((j) => j.date)].sort().pop() ?? "";
  // The paid-before-tour bug, in accounting form: a transfer cannot settle a tour that
  // had not happened yet — nor can it be dated in the future.
  if (DATE.test(paymentDate ?? "") && latest && paymentDate < latest) reasons.push(`Payment date ${paymentDate} is before the tour on ${latest}`);
  if (DATE.test(paymentDate ?? "") && paymentDate > today) reasons.push(`Payment date ${paymentDate} is in the future`);
  if (!(document.total > 0)) reasons.push("Nothing to pay on this document");
  if (reasons.length) throw new PaymentNotRecordable(reasons);
  return { paymentDate, paymentMethodId: paymentMethodId.trim(), amount: round2(document.total) };
}

/** What PEAK holds on the expense right now (lib/peak-api PeakExpenseState). */
export type PeakExpenseView = {
  id?: string | null;
  code: string;
  reference: string | null;
  contactId: string | null;
  status: string | null;
  isVoid: boolean;
  paymentAmount: number | null;
  remainAmount: number | null;
  remainWhtAmount: number | null;
  /** The withholding on the document, and summed from its lines (lib/peak-api). */
  whtAmount?: number | null;
  lineWhtAmount?: number | null;
  payments: number;
};

export type PaymentPlan = { amount: number; withholdingTaxAmount: number | null };

const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 0.005;

/**
 * Whether the EXP in PEAK is exactly the document FolkOPS created and still owes
 * exactly what FolkOPS will pay — and so what to send. Every doubt is a refusal before
 * any payment is sent, naming what PEAK showed, so a person can look.
 *
 * PEAK's documentation does not say how withholding tax is carried when an expense with
 * withholding on its lines is paid. So this accepts only the readings that reconcile
 * exactly with the document and are unambiguous:
 *   - PEAK still owes the gross and holds the withholding apart → pay the net and name
 *     that withholding;
 *   - PEAK owes the gross, reports no withholding still open, but the document itself
 *     carries exactly this withholding (on the document or summed from its lines) →
 *     pay the net and name that withholding. This is what PEAK returned for an unpaid
 *     combined document in production (2026-09-15): the withholding is only "open"
 *     once a payment names it;
 *   - PEAK holds no withholding and owes the net → pay the net.
 * Anything else is refused. After the payment, the document is PAID only if PEAK then
 * reports nothing outstanding (classifyPaymentWrite).
 */
export function peakPaymentPlan(input: {
  expense: PeakExpenseView;
  documentNo: string;
  /** PEAK's id for the document FolkOPS created. An EXP number can be reused; the id cannot. */
  documentId?: string | null;
  paymentRef: string;
  peakContactId: string | null;
  gross: number;
  wht: number;
  net: number;
}): { ok: true; plan: PaymentPlan } | { ok: false; reasons: string[] } {
  const { expense: e, documentNo, gross, wht, net } = input;
  const reasons: string[] = [];
  if ((e.code ?? "").trim() !== documentNo) reasons.push(`PEAK returned ${e.code || "no document"} for ${documentNo}`);
  if (input.documentId && (e.id ?? "") !== input.documentId) reasons.push(`PEAK returned a different document than the ${documentNo} FolkOPS created (PEAK can reuse a voided document's number) — nothing was paid`);
  if (e.isVoid) reasons.push(`${documentNo} is voided in PEAK — it cannot be paid`);
  if (/draft/i.test(e.status ?? "")) reasons.push(`${documentNo} is still a draft in PEAK — approve it in PEAK first, then record the payment`);
  if (e.reference && e.reference.trim() !== input.paymentRef) reasons.push(`${documentNo} in PEAK carries reference ${e.reference}, not ${input.paymentRef}`);
  if (e.contactId && input.peakContactId && e.contactId !== input.peakContactId) reasons.push(`${documentNo} in PEAK is for a different contact than this guide`);
  if (e.payments > 0 || (e.paymentAmount ?? 0) > 0.005) reasons.push(`PEAK already shows a payment on ${documentNo} — look at it in PEAK before recording anything`);
  let plan: PaymentPlan | null = null;
  if (e.remainAmount == null) reasons.push(`PEAK did not say how much is outstanding on ${documentNo}`);
  else if (wht > 0 && near(e.remainWhtAmount, wht) && near(e.remainAmount, gross)) plan = { amount: round2(net), withholdingTaxAmount: round2(wht) };
  else if (wht > 0 && (e.remainWhtAmount ?? 0) <= 0.005 && near(e.remainAmount, gross) && (near(e.whtAmount ?? null, wht) || near(e.lineWhtAmount ?? null, wht))) plan = { amount: round2(net), withholdingTaxAmount: round2(wht) };
  else if ((e.remainWhtAmount ?? 0) <= 0.005 && near(e.remainAmount, net)) plan = { amount: round2(net), withholdingTaxAmount: null };
  else {
    const fig = (v: number | null | undefined) => (v == null ? "not given" : thb(v));
    reasons.push(`PEAK shows ${thb(e.remainAmount)} outstanding on ${documentNo} (withholding on the document ${fig(e.whtAmount)}, on its lines ${fig(e.lineWhtAmount)}, still open ${fig(e.remainWhtAmount)}); FolkOPS expects ${thb(net)} to pay${wht > 0 ? ` after ${thb(wht)} withholding (gross ${thb(gross)})` : ""} — check the document in PEAK`);
  }
  if (reasons.length || !plan) return { ok: false, reasons };
  return { ok: true, plan };
}

export type PaymentWriteResult = { ok: boolean; desc?: string; uncertain?: boolean; remainPaymentAmount?: number | null; remainWhtAmount?: number | null };

export type PaymentOutcome =
  | { status: "PAID" }
  | { status: "FAILED"; reason: string }
  | { status: "UNCERTAIN"; reason: string };

/**
 * Refused, recorded, or unknown. "Recorded" also needs PEAK to report the document
 * fully settled: a payment PEAK accepted that still leaves money outstanding is not a
 * paid document, and paying again could record the transfer twice — so it waits for a
 * person, exactly like a lost answer.
 */
export function classifyPaymentWrite(r: PaymentWriteResult): PaymentOutcome {
  if (r.ok) {
    if (r.remainPaymentAmount == null) return { status: "UNCERTAIN", reason: "PEAK accepted the payment but did not report what remains outstanding — look at the document in PEAK" };
    if (r.remainPaymentAmount > 0.005 || (r.remainWhtAmount ?? 0) > 0.005) {
      return { status: "UNCERTAIN", reason: `PEAK recorded a payment but still shows ${thb(r.remainPaymentAmount)} outstanding${(r.remainWhtAmount ?? 0) > 0.005 ? ` and ${thb(r.remainWhtAmount!)} withholding` : ""} — look at the document in PEAK` };
    }
    return { status: "PAID" };
  }
  const reason = (r.desc ?? "").trim() || "PEAK did not confirm the payment and gave no reason";
  return r.uncertain ? { status: "UNCERTAIN", reason } : { status: "FAILED", reason };
}

export type PayDocumentDeps = {
  /** AWAITING_PAYMENT → PAYING for exactly this document, atomically, after checking
   *  every job is still locked to it, unpaid and unchanged. Throws PaymentClaimRefused. */
  claimPayment(p: { paymentRef: string; paymentDate: string; paymentMethodId: string; paymentMethodName: string | null }): Promise<void>;
  /** Read the EXP back from PEAK and decide what to send (peakPaymentPlan). Read-only. */
  checkExpense(): Promise<{ ok: true; plan: PaymentPlan } | { ok: false; reasons: string[] }>;
  /** Save the slip. Throws on failure. */
  uploadSlip(): Promise<{ link: string }>;
  /** Record the payment against the EXISTING PEAK document. Never creates a document. */
  payExpense(p: { documentNo: string; documentId: string | null; paymentDate: string; paymentMethodId: string } & PaymentPlan): Promise<PaymentWriteResult>;
  /** PEAK recorded it: every job locked to this document becomes PAID, atomically. */
  recordPaid(p: { paymentRef: string; slipLink: string }): Promise<void>;
  /** FAILED returns the document to AWAITING_PAYMENT; UNCERTAIN (PAYMENT_UNCERTAIN) keeps it. */
  recordPaymentFailed(p: { paymentRef: string; reason: string; uncertain: boolean }): Promise<void>;
  attachSlip(p: { documentId: string | null; documentNo: string }): Promise<{ ok: boolean; reason?: string }>;
  recordAttachment(p: { paymentRef: string; ok: boolean; reason: string | null }): Promise<void>;
  /** Tell the guide — once, and only after the jobs are recorded as paid. */
  notifyGuide(p: { paymentRef: string; slipLink: string }): Promise<void>;
};

export type PayDocumentResult =
  | {
      status: "PAID"; paymentRef: string; documentNo: string; slipLink: string; amount: number;
      attachment: { ok: boolean; reason: string | null };
      /** PEAK recorded the payment but FolkOPS could not mark the jobs. They stay locked
       *  and unpaid; resolve it on the Payments page — never pay again. */
      recordError: string | null;
      notified: boolean;
    }
  | { status: "FAILED"; paymentRef: string; stage: "check" | "slip" | "peak"; reason: string; reasons?: string[] }
  | { status: "UNCERTAIN"; paymentRef: string; reason: string };

/**
 * Claim → read the EXP back → slip → pay the SAME EXP → mark paid → attach the slip →
 * tell the guide.
 *
 * The jobs are marked paid only after PEAK has recorded the payment, and never when its
 * answer is lost: then the document waits (PAYMENT_UNCERTAIN) for a person to look at
 * the EXP in PEAK. No step here can create an expense document.
 */
export async function payCombinedDocument(
  deps: PayDocumentDeps,
  input: { paymentRef: string; documentNo: string; documentId: string | null; paymentMethodName: string | null } & PaymentInput,
): Promise<PayDocumentResult> {
  const { paymentRef, documentNo, documentId, paymentDate, paymentMethodId, amount } = input;
  await deps.claimPayment({ paymentRef, paymentDate, paymentMethodId, paymentMethodName: input.paymentMethodName }); // refusal propagates

  // The document in PEAK must still be exactly the one FolkOPS created, unpaid, owing
  // exactly this. Nothing is uploaded or paid until it is.
  let plan: PaymentPlan;
  try {
    const check = await deps.checkExpense();
    if (!check.ok) {
      const reason = check.reasons.join("; ");
      await deps.recordPaymentFailed({ paymentRef, reason, uncertain: false }).catch(() => {});
      return { status: "FAILED", paymentRef, stage: "check", reason, reasons: check.reasons };
    }
    plan = check.plan;
  } catch (e) {
    const reason = `Could not read ${documentNo} from PEAK: ${msg(e)} — nothing was paid`;
    await deps.recordPaymentFailed({ paymentRef, reason, uncertain: false }).catch(() => {});
    return { status: "FAILED", paymentRef, stage: "check", reason };
  }

  let slipLink: string;
  try {
    ({ link: slipLink } = await deps.uploadSlip());
  } catch (e) {
    const reason = `The slip could not be saved: ${msg(e)}`;
    await deps.recordPaymentFailed({ paymentRef, reason, uncertain: false }).catch(() => {});
    return { status: "FAILED", paymentRef, stage: "slip", reason };
  }

  let outcome: PaymentOutcome;
  try {
    outcome = classifyPaymentWrite(await deps.payExpense({ documentNo, documentId, paymentDate, paymentMethodId, ...plan }));
  } catch (e) {
    outcome = { status: "UNCERTAIN", reason: msg(e) };
  }
  if (outcome.status !== "PAID") {
    const uncertain = outcome.status === "UNCERTAIN";
    await deps.recordPaymentFailed({ paymentRef, reason: outcome.reason, uncertain }).catch(() => {});
    return uncertain ? { status: "UNCERTAIN", paymentRef, reason: outcome.reason } : { status: "FAILED", paymentRef, stage: "peak", reason: outcome.reason };
  }

  let recordError: string | null = null;
  try {
    await deps.recordPaid({ paymentRef, slipLink });
  } catch (e) {
    recordError = `PEAK recorded the payment on ${documentNo}, but FolkOPS could not mark the jobs paid: ${msg(e)}`;
  }

  let attachment: { ok: boolean; reason: string | null };
  try {
    const a = await deps.attachSlip({ documentId, documentNo });
    attachment = { ok: a.ok, reason: a.ok ? null : (a.reason ?? "PEAK did not confirm the attachment") };
  } catch (e) {
    attachment = { ok: false, reason: msg(e) };
  }
  await deps.recordAttachment({ paymentRef, ok: attachment.ok, reason: attachment.reason }).catch(() => {});

  // The guide hears about a payment only once FolkOPS itself shows it paid.
  let notified = false;
  if (!recordError) {
    try { await deps.notifyGuide({ paymentRef, slipLink }); notified = true; } catch { /* best-effort, as everywhere else */ }
  }
  return { status: "PAID", paymentRef, documentNo, slipLink, amount, attachment, recordError, notified };
}

// ── Locks held by a payment document ─────────────────────────────────────────

/**
 * Whether a job is tied up in a combined PEAK payment document, and so must not be
 * paid, un-paid or posted by any other route. Returns the message to show, or null.
 * `document` is the combined document the job is locked to, when the caller has it.
 */
export function paymentDocumentLock(
  tp: { peakPaymentRef?: string | null; peakRef?: string | null; status?: string | null } | null | undefined,
  document?: { status?: string | null; peakDocumentNo?: string | null } | null,
): string | null {
  const ref = (tp?.peakPaymentRef ?? "").trim();
  if (!ref) return null;
  const st = documentStatus(document?.status);
  const docNo = (document?.peakDocumentNo ?? tp?.peakRef ?? "").trim();
  if (st === "AWAITING_PAYMENT" || st === "PAYING") {
    return `Included in combined PEAK document ${docNo || ref} (${ref}) · Awaiting payment. Record the payment on the Payments page — do not pay or post this job on its own.`;
  }
  if (st === "PAYMENT_UNCERTAIN") {
    return `Included in combined PEAK document ${docNo || ref} (${ref}). PEAK has not confirmed its payment — look at ${docNo || "the document"} in PEAK, then record what you find on the Payments page.`;
  }
  if (st === "PAID" || (!st && docNo && tp?.status === "PAID")) {
    return `This job was paid in PEAK document ${docNo} (${ref}) together with the guide's other jobs. Change it in PEAK, then mark that payment voided on the Payments page.`;
  }
  if (!st && docNo) {
    // Called without the document: a job carrying a document number was paid through it.
    return `This job was paid in PEAK document ${docNo} (${ref}) together with the guide's other jobs. Change it in PEAK, then mark that payment voided on the Payments page.`;
  }
  return `This job is in PEAK payment ${ref}, which PEAK has not confirmed yet. Resolve it on the Payments page first.`;
}

// ── PEAK credits ─────────────────────────────────────────────────────────────
//
// PEAK bills per successful document-creating POST: one Expenses/allinone call is one
// transaction however many jobs it pays. Reads, ClientToken and Expenses/insertfile are
// not billed (PEAK reference: "PEAK API transaction counting"). So one transfer should
// be one document, and paying a guide's jobs one at a time costs one document each.

/**
 * The warning to show before paying ONE job on its own while the guide still has other
 * unpaid jobs — or null when there is nothing to warn about. `payableCount` counts the
 * guide's unpaid jobs that can still be paid together, including this one.
 */
export function separatePaymentWarning(guide: string, payableCount: number): string | null {
  if (payableCount <= 1) return null;
  return [
    `Pay this job on its own?`,
    ``,
    `${guide} has ${payableCount} unpaid jobs. Every separate transfer is its own PEAK document, and each document created uses a PEAK API credit.`,
    ``,
    `If these jobs are going in one transfer, cancel and use "Pay ${payableCount} jobs together · one ref" — 1 PEAK document for all ${payableCount}.`,
  ].join("\n");
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * The warning to show before "Sync to PEAK" posts one job sheet as a document of its own
 * while the guide has other unpaid jobs that month — or null when there are none.
 *
 * A job posted from its sheet can no longer go into "Pay N jobs together", so the
 * transfer that pays the month would need more than one document. It is a question,
 * not a block: syncing one job on its own is sometimes exactly what the operator means.
 */
export function separateSyncWarning(otherUnpaid: number, period: string): string | null {
  if (otherUnpaid <= 0) return null;
  const month = MONTH_NAMES[Number(period.slice(5, 7)) - 1];
  const when = month ? `${month} ${period.slice(0, 4)}` : period;
  return `This guide has ${otherUnpaid} other unpaid job${otherUnpaid === 1 ? "" : "s"} in ${when}. Syncing this job now will create a separate PEAK document and may prevent one-document payment later.`;
}

/** What the dialog says about the jobs the operator unticked. Null when none. */
export function leftOutWarning(leftOut: number): string | null {
  if (leftOut <= 0) return null;
  return `${leftOut} unpaid job${leftOut === 1 ? " is" : "s are"} left out of this payment. Paid later on ${leftOut === 1 ? "its" : "their"} own, each transfer becomes a separate PEAK document and uses another PEAK API credit.`;
}
