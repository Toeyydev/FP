import { canonicalPaidBy } from "@/lib/peak-sync";
import { expenseAmount, isReviewExpense } from "@/lib/jobsheet";
import { evidenceState, type EvidenceWaiver, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";

// An admin asking for a certificate to cover a row that would not otherwise need one.
//
// A row needs a certificate on its own when it is the guide's money with nothing behind
// it (lib/reimbursement-evidence: BLOCKED). Two kinds of guide-paid row have something
// behind them and so were never offered one:
//
//   WAIVED       an admin's older waiver with no certificate — "pay it anyway", standing on
//                a name and nothing else. The historical campaign exists to replace these
//                with a document.
//   HAS_RECEIPT  a receipt is attached. A certificate on top of it is usually redundant,
//                so it is only covered when an admin says so AND acknowledges the receipt.
//
// The request lives on the row, server-owned like the waiver it may replace, so that every
// step that re-reads the sheet — create, attest, link, the Job Sheet's own panel — sees the
// same set of rows through `certifiableRows` without being told about the campaign. It is
// bound to what the row said when it was made (its financial identity): a row repriced or
// repaid since is no longer the row the admin chose, and the request stops counting.
//
// Nothing here changes whether a row can be PAID. `evidenceState` does not read it.

export type CertificateRequest = {
  /** User.id of the admin who asked. From the session, never from a request body. */
  by: string;
  byName: string;
  /** ISO timestamp, server time. */
  at: string;
  /** financialIdentity of the row when the request was made. */
  identity: string;
  /** The row has a receipt, and the admin said a certificate should cover it anyway. */
  receiptAcknowledged: boolean;
  /** The waiver this row carried when it was asked for — kept, because linking replaces it. */
  supersedesWaiver?: EvidenceWaiver | null;
};

export type RequestableRow = ExpenseWithEvidence & { certificateRequest?: CertificateRequest | null };

/** Why a row may be opted in, or null when it cannot be. */
export type OptIn = "WAIVED" | "HAS_RECEIPT";

/** A request that is well-formed and still describes this row. */
export function liveRequest(e: RequestableRow): CertificateRequest | null {
  const r = e.certificateRequest;
  if (!r || typeof r !== "object") return null;
  if (!String(r.by ?? "").trim() || !String(r.at ?? "").trim()) return null;
  if (r.identity !== financialIdentity(e as ProtectedRow)) return null;
  return r;
}

/**
 * Whether an admin may ask for a certificate on this row, and on what footing.
 *
 * Only the guide's own money, with an amount, not a review reward. A waiver that already
 * names a certificate is that certificate's business — replacing or reissuing it goes
 * through withdrawing it, not through asking again.
 */
export function optInFor(e: RequestableRow): OptIn | null {
  if (isReviewExpense(e) || expenseAmount(e) <= 0) return null;
  if (canonicalPaidBy(e) !== "GUIDE_PERSONAL") return null;
  const s = evidenceState(e);
  if (s.state === "HAS_RECEIPT") return (e.evidenceWaiver?.certificateId ?? "").trim() ? null : "HAS_RECEIPT";
  if (s.state === "WAIVED" && !(s.waiver.certificateId ?? "").trim()) return "WAIVED";
  return null;
}

/** An opt-in row an admin has asked a certificate to cover, on terms that still hold. */
export function requestedForCertificate(e: RequestableRow): boolean {
  const r = liveRequest(e);
  if (!r) return false;
  const opt = optInFor(e);
  if (opt === "WAIVED") return true;
  if (opt === "HAS_RECEIPT") return r.receiptAcknowledged === true;
  return false;
}
