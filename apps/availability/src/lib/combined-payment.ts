// Whether ONE job can go into "Pay N jobs together · one ref".
//
// The Payments page counts the jobs it offers with this, and the preview and the post
// refuse with it — one rule in one place, so the page can never offer a job the server
// then turns away for a reason the page already had in front of it.
//
// Job-level only. What is wrong with the DOCUMENT — a row with no category, an account
// with no mapping, a guide with no PEAK contact — is the builder's to report
// (lib/peak-payment-document), and the preview lists it.
//
// Pure: no database, no network.
import { isApproved } from "@/lib/jobsheet";
import { paymentDocumentLock } from "@/lib/peak-payment-document";

export type CombinedBlockCode =
  | "no-job-sheet"
  | "payment-document"
  | "paid"
  | "has-slip"
  | "payroll"
  | "historical"
  | "in-peak-from-sheet"
  | "not-approved"
  | "not-paid"
  | "has-peak-ref";

export type CombinedBlock = {
  code: CombinedBlockCode;
  /** A sentence that reads after the job's number: "FOLK-BKK-… — <message>". */
  message: string;
  /** The PEAK document the job's own sheet created, when that is the reason. */
  documentNo?: string;
};

export type CombinedJobState = {
  sheet: { origin?: string | null; peakDocumentNo?: string | null; peakDocumentId?: string | null; approvalStatus?: string | null } | null;
  payment: {
    status?: string | null; peakPaymentRef?: string | null; peakRef?: string | null; eslipUrl?: string | null; slips?: unknown;
    /** The combined PEAK document the job is locked to, when the caller has read it. */
    document?: { status?: string | null; peakDocumentNo?: string | null } | null;
  } | null;
  /** The guide's whole-month payroll already covers this job (lib/payment-coverage). */
  coveredByPayroll: boolean;
  /** "YYYY-MM" — only for the message. */
  period: string;
};

/** Whether a job sheet already created its own PEAK expense document. */
export function sheetInPeak(sheet: CombinedJobState["sheet"]): boolean {
  return !!(sheet && ((sheet.peakDocumentId ?? "").trim() || (sheet.peakDocumentNo ?? "").trim()));
}

/**
 * The first reason this job cannot join a combined payment document, or null when it
 * can. The order is the order an operator would want to hear them: a job that is
 * already paid is "paid", not "in PEAK".
 */
export function combinedPaymentBlock(job: CombinedJobState): CombinedBlock | null {
  const { sheet, payment } = job;
  if (!sheet) return { code: "no-job-sheet", message: "has no job sheet — open and save it before paying" };

  const lock = paymentDocumentLock(payment, payment?.document);
  if (lock) return { code: "payment-document", message: lock };
  if (payment?.status === "PAID") return { code: "paid", message: "is already paid" };
  if ((payment?.eslipUrl ?? "") || (Array.isArray(payment?.slips) && payment!.slips.length > 0)) {
    return { code: "has-slip", message: "already has a slip — finish that payment with its own slips" };
  }
  if (job.coveredByPayroll) return { code: "payroll", message: `is already covered by the guide's ${job.period} payroll` };
  if (sheet.origin === "HISTORICAL_BACKFILL") {
    return { code: "historical", message: "was reconstructed from historical records and cannot be posted to PEAK" };
  }
  // Posted from its own job sheet: its cost is already in PEAK. Putting it in this
  // document as well would leave two documents booking the same job.
  if (sheetInPeak(sheet)) {
    const documentNo = (sheet.peakDocumentNo ?? "").trim();
    return {
      code: "in-peak-from-sheet",
      documentNo: documentNo || undefined,
      message: `is already in PEAK from its job sheet${documentNo ? ` (${documentNo})` : ""} — a second document would book this job twice. Leave it out of this payment, or, if that document has been voided in PEAK, record it with "Voided in PEAK…" on the job sheet first.`,
    };
  }
  // A PEAK payment books the job's figures as final and marks it paid. Until someone
  // has signed off the sheet's expenses those figures are not final — the job-sheet
  // sync refuses an unapproved sheet for the same reason (peakSyncEligibility).
  if (!isApproved(sheet.approvalStatus)) {
    return { code: "not-approved", message: "is not approved — approve the job sheet before paying it in a PEAK document" };
  }
  return null;
}

/**
 * The first reason an ALREADY-PAID job cannot go into one PEAK document with the other
 * jobs its transfer paid — or null when it can. The same checks as combinedPaymentBlock,
 * turned round for jobs whose money has already moved: the job must be paid on its own
 * record (a whole-month payroll run is its own PEAK matter), and must have no PEAK
 * document yet — not a typed EXP ref, not a synced sheet, not a combined document.
 */
export function paidJobPeakBlock(job: CombinedJobState): CombinedBlock | null {
  const { sheet, payment } = job;
  if (!sheet) return { code: "no-job-sheet", message: "has no job sheet — open and save it first" };
  const lock = paymentDocumentLock(payment, payment?.document);
  if (lock) return { code: "payment-document", message: lock };
  if (payment?.status !== "PAID") {
    return job.coveredByPayroll
      ? { code: "payroll", message: `was paid by the guide's ${job.period} payroll — record that payroll's EXP ref on Payments` }
      : { code: "not-paid", message: "is not paid yet — create its PEAK document with \"Pay N jobs together\" instead" };
  }
  if ((payment.peakRef ?? "").trim()) return { code: "has-peak-ref", message: `already has a PEAK document (${payment.peakRef})` };
  if (sheet.origin === "HISTORICAL_BACKFILL") return { code: "historical", message: "was reconstructed from historical records and cannot be posted to PEAK" };
  if (sheetInPeak(sheet)) {
    const documentNo = (sheet.peakDocumentNo ?? "").trim();
    return { code: "in-peak-from-sheet", documentNo: documentNo || undefined, message: `is already in PEAK from its job sheet${documentNo ? ` (${documentNo})` : ""}` };
  }
  if (!isApproved(sheet.approvalStatus)) return { code: "not-approved", message: "is not approved — approve the job sheet before putting it in a PEAK document" };
  return null;
}

/** The calendar date in Bangkok of an instant, "YYYY-MM-DD". */
export const bangkokDateOf = (at: Date | string) => new Date(new Date(at).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

export type PaidTransferJob = { ref: string; paidAt: Date | string | null; eslipUrl?: string | null; slips?: unknown };

/**
 * The one transfer that already paid these jobs — its date and its slip — or every reason
 * they were not one transfer. One transfer is one PEAK document (owner rule), so jobs paid
 * on different days, or with different slips, go into separate documents. A job with no
 * slip of its own may share a transfer with one that has it (one slip uploaded for the lot).
 */
export function paidTransferOf(jobs: PaidTransferJob[]): { paidDate: string | null; slipLink: string | null; reasons: string[] } {
  const reasons: string[] = [];
  const dates = new Set<string>();
  const links = new Set<string>();
  for (const j of jobs) {
    if (!j.paidAt) reasons.push(`${j.ref} has no paid date on record`);
    else dates.add(bangkokDateOf(j.paidAt));
    if ((j.eslipUrl ?? "").trim()) links.add(j.eslipUrl!.trim());
    for (const s of Array.isArray(j.slips) ? (j.slips as { url?: string | null }[]) : []) if ((s?.url ?? "").trim()) links.add(s.url!.trim());
  }
  if (dates.size > 1) reasons.push(`These jobs were paid on different days (${[...dates].sort().join(", ")}) — one transfer is one PEAK document, so put each day's jobs in separately`);
  if (links.size > 1) reasons.push(`These jobs were paid with ${links.size} different slips — one transfer is one PEAK document, so put each transfer's jobs in separately`);
  return { paidDate: dates.size === 1 ? [...dates][0] : null, slipLink: links.size === 1 ? [...links][0] : null, reasons };
}
