// Is this job in PEAK Account yet? One answer, used by Payments and the job sheet.
//
// FolkOPS knows a job is in PEAK when it recorded the document itself:
//   - the job sheet was synced to PEAK (and that document was not voided);
//   - the job is in a combined PEAK document that PEAK created (awaiting payment or paid);
//   - an EXP-… ref was recorded on its payment, or on the payroll run that paid it.
// A document someone made by hand in PEAK without typing its EXP back into FolkOPS is
// invisible here — so "not in PEAK" means "FolkOPS has no PEAK document for it".
//
// Pure: no database, no network.
import { documentHoldsJobs, documentStatus } from "@/lib/peak-payment-document";

export type PeakJobState = "IN_PEAK" | "NOT_IN_PEAK" | "NOTHING_TO_POST";
export type PeakJobStatus = { state: PeakJobState; documentNo: string | null; source: "sheet" | "combined" | "payment" | "payroll" | null };

export function peakJobStatus(input: {
  sheet: { peakDocumentNo?: string | null; peakSyncStatus?: string | null } | null;
  /** EXP ref recorded on this job's own payment. */
  paymentRef?: string | null;
  /** The combined PEAK document the job is locked to, if any. */
  document?: { status?: string | null; peakDocumentNo?: string | null } | null;
  /** EXP ref of the payroll run that covers this job (only when it does cover it). */
  payrollRef?: string | null;
  /** What the job pays the guide. Nothing to pay, nothing to book. */
  amount: number;
}): PeakJobStatus {
  const sheetNo = (input.sheet?.peakDocumentNo ?? "").trim();
  if (sheetNo && input.sheet?.peakSyncStatus !== "VOIDED") return { state: "IN_PEAK", documentNo: sheetNo, source: "sheet" };
  const d = input.document;
  const docNo = (d?.peakDocumentNo ?? "").trim();
  const st = documentStatus(d?.status ?? null);
  if (docNo && d && documentHoldsJobs(d.status) && st !== "CREATING" && st !== "CREATE_UNCERTAIN") return { state: "IN_PEAK", documentNo: docNo, source: "combined" };
  const payRef = (input.paymentRef ?? "").trim();
  if (payRef) return { state: "IN_PEAK", documentNo: payRef, source: "payment" };
  const payrollRef = (input.payrollRef ?? "").trim();
  if (payrollRef) return { state: "IN_PEAK", documentNo: payrollRef, source: "payroll" };
  if (!(input.amount > 0)) return { state: "NOTHING_TO_POST", documentNo: null, source: null };
  return { state: "NOT_IN_PEAK", documentNo: null, source: null };
}

// The EXP number to print against ONE job: the document FolkOPS recorded for that job
// (peakJobStatus). Never borrowed from another job of the same guide, month, batch,
// transfer or paid date, nor from the guide's monthly payroll row unless that payroll
// paid this job — two rows side by side do not share a PEAK document.
export function jobPeakDocumentNo(status: Pick<PeakJobStatus, "documentNo"> & { state: string } | null | undefined): string | null {
  return status?.state === "IN_PEAK" ? (status.documentNo ?? "").trim() || null : null;
}
