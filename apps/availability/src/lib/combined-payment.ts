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
  | "not-approved";

export type CombinedBlock = {
  code: CombinedBlockCode;
  /** A sentence that reads after the job's number: "FOLK-BKK-… — <message>". */
  message: string;
  /** The PEAK document the job's own sheet created, when that is the reason. */
  documentNo?: string;
};

export type CombinedJobState = {
  sheet: { origin?: string | null; peakDocumentNo?: string | null; peakDocumentId?: string | null; approvalStatus?: string | null } | null;
  payment: { status?: string | null; peakPaymentRef?: string | null; peakRef?: string | null; eslipUrl?: string | null; slips?: unknown } | null;
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

  const lock = paymentDocumentLock(payment);
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
