// "Pay N jobs together · one ref" → ONE PEAK document.
//
// A guide is often paid for several tours in a single bank transfer. PEAK must hold
// that as ONE payable-and-payment document — one contact, one payment reference, one
// payment date, one Paid By account, one slip — with a line per job and category, so
// the ledger shows the money that actually moved while every line still names the job
// it belongs to. Posting one document per job would split one transfer across N
// payments that no bank statement line matches.
//
// This file is pure: no database, no network. The route supplies the jobs and the
// saved account chart, and the side effects arrive through PayTogetherDeps — which is
// what lets the order of operations below be tested without either.
import { expenseAmount, expenseCategory, isReviewExpense, type Expense, type GuideFee } from "@/lib/jobsheet";
import { categoryLabel } from "@/lib/peak-accounts";
import {
  canonicalPaidBy, guidePayoutTotal, resolveExpenseAccount, type PeakAccount, type PeakAccountMap,
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

/** Thrown with EVERY reason at once — an operator fixing one problem per click, only to
 *  meet the next, is how a payment gets abandoned half-done. */
export class PaymentDocumentNotPostable extends Error {
  readonly code = "payment-document-not-postable";
  constructor(readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "PaymentDocumentNotPostable";
  }
}

export function paymentRefFor(paymentDate: string, seq: number): string {
  return `FOLK-PAY-${paymentDate.slice(0, 7).replace("-", "")}-${String(seq).padStart(2, "0")}`;
}

// ── The builder ──────────────────────────────────────────────────────────────

export function buildGuidePaymentDocument(input: {
  guideId: string;
  peakContactId: string | null | undefined;
  paymentRef: string;
  paymentDate: string;
  paymentMethodId: string;
  jobs: PaymentJob[];
  accounts: PaymentAccounts;
  vatType?: string;
}): GuidePaymentDocument {
  const { guideId, peakContactId, paymentRef, paymentDate, paymentMethodId, accounts, vatType } = input;
  const reasons = new Set<string>();

  if (!peakContactId) reasons.add("Guide is not mapped to a PEAK Contact — map them on one of their job sheets first");
  if (!(paymentMethodId ?? "").trim()) reasons.add("Choose the account the money was paid from (Paid By)");
  if (!DATE.test(paymentDate ?? "")) reasons.add("Choose a payment date");
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
  // The paid-before-tour bug, in accounting form: a transfer cannot settle a tour that
  // had not happened yet.
  if (DATE.test(paymentDate ?? "") && latest && paymentDate < latest) {
    reasons.add(`Payment date ${paymentDate} is before the tour on ${latest}`);
  }

  const lines: PeakPaymentLine[] = [];
  const traces: PaymentLineTrace[] = [];
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
    const gross = round2((Number(j.guideFee?.price) || 0) * (Number(j.guideFee?.time) || 0));
    const wht = round2(gross * ((Number(j.guideFee?.whtPct) || 0) / 100));
    if (gross > 0) {
      const code = (accounts.guideFee?.code ?? "").trim();
      if (!code) reasons.add(`${categoryLabel("GUIDE_FEE")} has no PEAK account mapping`);
      push("GUIDE_FEE", "GUIDE_FEE", code, gross, wht, `Guide fee - ${ref}`);
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
        // 2026-09-13), booked to the REVIEW_REWARD account (510110) with NO withholding.
        // TODO(accountant): confirm the WHT treatment of review rewards paid to a guide.
        // The guide fee withholds 3%; this line withholds nothing, which may be an
        // under-withholding (ภ.ง.ด.3). Until an accountant confirms, do not change the
        // rate here on a guess — change it here, once, when they answer.
        const code = (accounts.reviewReward?.code ?? "").trim();
        if (!code) reasons.add(`${categoryLabel("REVIEW_REWARD")} has no PEAK account mapping`);
        add("REVIEW_REWARD", "REVIEW_REWARD", code, "Review reward", amt);
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
      if (!key) { reasons.add(`"${desc}" on ${where} has no expense category`); continue; }
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
    for (const g of groups.values()) push(g.kind, g.category, g.code, round2(g.amount), 0, `${g.label} - ${ref}`);
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
  if (reasons.size) throw new PaymentDocumentNotPostable([...reasons]);

  const issuedDate = compact(latest);
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
      // delivered; the payment carries its own date. dueDate = issuedDate is what the
      // job-sheet document already posts successfully.
      issuedDate,
      dueDate: issuedDate,
      // Contact id only, never a name — see buildJobSheetExpense for why a name forks
      // the guide into a duplicate supplier.
      contact: { id: peakContactId },
      products: lines,
      reference: paymentRef,
      remark: `Folkpaths guide payment ${paymentRef} · ${guideId} · ${jobs.length} job${jobs.length === 1 ? "" : "s"}`,
      paidPayments: {
        paymentDate: compact(paymentDate),
        payments: [{ paymentMethod: { id: paymentMethodId }, amount: total }],
      },
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

// ── The order of operations ──────────────────────────────────────────────────

export type PayTogetherDeps = {
  /** Record the document as POSTING and lock every job to its paymentRef, atomically.
   *  Throws when any job is already paid or locked — before anything else happens. */
  claim(doc: GuidePaymentDocument): Promise<void>;
  /** Save the slip. Throws on failure. */
  uploadSlip(doc: GuidePaymentDocument): Promise<{ link: string }>;
  createExpense(expense: Record<string, unknown>): Promise<ExpenseWriteResult>;
  /** Mark every job locked to paymentRef PAID, pointing at the one document. */
  recordPosted(p: { paymentRef: string; documentNo: string; documentId: string | null; documentLink: string | null; slipLink: string }): Promise<void>;
  /** FAILED releases the jobs; UNCERTAIN leaves them locked. */
  recordFailed(p: { paymentRef: string; reason: string; uncertain: boolean }): Promise<void>;
  attachSlip(p: { documentId: string | null; documentNo: string }): Promise<{ ok: boolean; reason?: string }>;
  recordAttachment(p: { paymentRef: string; ok: boolean; reason: string | null }): Promise<void>;
};

export type PayTogetherResult =
  | {
      status: "POSTED"; paymentRef: string; documentNo: string; documentId: string | null; documentLink: string | null;
      slipLink: string; total: number; attachment: { ok: boolean; reason: string | null };
      /** PEAK has the document but FolkOPS could not record it. The jobs stay locked, so
       *  nothing can post twice; resolve it on the Payments page. */
      recordError: string | null;
    }
  | { status: "FAILED"; paymentRef: string; stage: "slip" | "peak"; reason: string }
  | { status: "UNCERTAIN"; paymentRef: string; reason: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * Claim → slip → ONE PEAK document → mark paid → attach the slip.
 *
 * The jobs are marked paid only after PEAK has created the document, and every one of
 * them is pointed at that same document. The slip attaches last and can fail on its
 * own: by then the money is booked in PEAK as paid, so reporting the whole payment as
 * failed would invite a second post of a transfer that already happened.
 */
export async function payJobsTogether(deps: PayTogetherDeps, doc: GuidePaymentDocument): Promise<PayTogetherResult> {
  const { paymentRef } = doc;
  await deps.claim(doc); // refusal propagates: nothing has happened yet

  let slipLink: string;
  try {
    ({ link: slipLink } = await deps.uploadSlip(doc));
  } catch (e) {
    const reason = `The slip could not be saved: ${msg(e)}`;
    await deps.recordFailed({ paymentRef, reason, uncertain: false }).catch(() => {});
    return { status: "FAILED", paymentRef, stage: "slip", reason };
  }

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
    await deps.recordFailed({ paymentRef, reason: outcome.reason, uncertain }).catch(() => {});
    return uncertain
      ? { status: "UNCERTAIN", paymentRef, reason: outcome.reason }
      : { status: "FAILED", paymentRef, stage: "peak", reason: outcome.reason };
  }

  const { documentNo, documentId, documentLink } = outcome;
  let recordError: string | null = null;
  try {
    await deps.recordPosted({ paymentRef, documentNo, documentId, documentLink, slipLink });
  } catch (e) {
    recordError = `PEAK created ${documentNo}, but FolkOPS could not record it: ${msg(e)}`;
  }

  let attachment: { ok: boolean; reason: string | null };
  try {
    const a = await deps.attachSlip({ documentId, documentNo });
    attachment = { ok: a.ok, reason: a.ok ? null : (a.reason ?? "PEAK did not confirm the attachment") };
  } catch (e) {
    attachment = { ok: false, reason: msg(e) };
  }
  await deps.recordAttachment({ paymentRef, ok: attachment.ok, reason: attachment.reason }).catch(() => {});

  return { status: "POSTED", paymentRef, documentNo, documentId, documentLink, slipLink, total: doc.total, attachment, recordError };
}

// ── Locks held by a payment document ─────────────────────────────────────────

/**
 * Whether a job is tied up in a combined PEAK payment document, and so must not be
 * paid, un-paid or posted by any other route. Returns the message to show, or null.
 */
export function paymentDocumentLock(
  tp: { peakPaymentRef?: string | null; peakRef?: string | null } | null | undefined,
): string | null {
  const ref = (tp?.peakPaymentRef ?? "").trim();
  if (!ref) return null;
  const doc = (tp?.peakRef ?? "").trim();
  return doc
    ? `This job was paid in PEAK document ${doc} (${ref}) together with the guide's other jobs. Change it in PEAK, then mark that payment voided on the Payments page.`
    : `This job is in PEAK payment ${ref}, which PEAK has not confirmed yet. Resolve it on the Payments page first.`;
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

/** What the dialog says about the jobs the operator unticked. Null when none. */
export function leftOutWarning(leftOut: number): string | null {
  if (leftOut <= 0) return null;
  return `${leftOut} unpaid job${leftOut === 1 ? " is" : "s are"} left out of this payment. Paid later on ${leftOut === 1 ? "its" : "their"} own, each transfer becomes a separate PEAK document and uses another PEAK API credit.`;
}
