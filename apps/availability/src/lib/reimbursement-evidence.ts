import { canonicalPaidBy } from "@/lib/peak-sync";
import { expenseAmount, type Expense } from "@/lib/jobsheet";

// Whether a row the company is about to reimburse has anything behind it.
//
// Until now "the guide paid it" was the whole test. `paidBy: "guide"` meant the money
// went back to them in full and was left out of the withholding base, and no part of
// the system ever looked at whether a receipt existed — the field was stored and
// displayed, never read by a calculation.
//
// That matters beyond tidiness. A reimbursement is outside the withholding base
// BECAUSE it is the guide's own money coming back against evidence. A round number
// with nothing behind it is not that; it is pay, and pay is withheld on. So a row
// that claims reimbursement without evidence is refused until someone either attaches
// the receipt or takes responsibility for waiving it in writing.
//
// Waiving is deliberately narrow: an admin, a reason, a timestamp, and an audit row.
// A tour where the temple gives no printed ticket is a real case; "we lost it" is a
// decision someone should have to sign.

export type EvidenceWaiver = {
  /** User.id of the admin who accepted the row without a receipt. */
  by: string;
  /** ISO timestamp. */
  at: string;
  /** Why the row can be paid without one. Free text, kept with the sheet and audited. */
  reason: string;
  /**
   * The certificate that stands behind this waiver, when one does.
   *
   * A waiver written by an admin on its own is a person saying "pay it anyway", and it
   * stands on their name. A waiver that names a certificate stands on a DOCUMENT as
   * well — and a document can be withdrawn. So when this is set, the waiver is only
   * worth anything while that certificate is LINKED, which is checked by the caller
   * that knows about certificates (lib/certificates/evidence). Nothing here reads the
   * database, so this module stays pure.
   *
   * Older waivers have none, and keep the meaning they had when they were granted.
   */
  certificateId?: string | null;
  certificateNo?: string | null;
};

/** The waiver lives on the row itself — `expenses` is JSON, so this needs no migration. */
export type ExpenseWithEvidence = Expense & { evidenceWaiver?: EvidenceWaiver | null };

export const MIN_WAIVER_REASON = 10;

/**
 * Whether a missing receipt REFUSES a payment, or only reports itself.
 *
 * Off until the receipts exist. On the day this was written not one of the 409
 * reimbursement rows in production carried a receipt — ฿33,283 across 146 job
 * sheets — so a hard rule on day one would stop every guide being paid. The rule
 * is therefore complete but dormant: every gap is reported on the document, and
 * `REIMBURSEMENT_EVIDENCE_REQUIRED=1` turns reporting into refusing once guides
 * are attaching receipts.
 */
export const evidenceRequired = () => (process.env.REIMBURSEMENT_EVIDENCE_REQUIRED ?? "").trim() === "1";

export const EVIDENCE_POLICY =
  "ค่าใช้จ่ายที่ไกด์สำรองจ่ายต้องมีหลักฐานจึงจะเบิกคืนได้โดยไม่ถือเป็นค่าตอบแทน";

export type EvidenceState =
  | { state: "NOT_REQUIRED" }                          // not a reimbursement, or nothing to pay
  | { state: "HAS_RECEIPT" }
  | { state: "WAIVED"; waiver: EvidenceWaiver }
  | { state: "BLOCKED"; reason: string };

/**
 * Certificates whose state a waiver may rely on: id → status.
 *
 * Passed in rather than looked up, so `evidenceState` keeps taking a row and returning
 * an answer with no database behind it. A caller that has not loaded any certificates
 * passes nothing, and a waiver naming one is then treated as unproven — refusing to
 * assume a document is in force is the safe direction to be wrong in.
 */
export type CertificateStatuses = Readonly<Record<string, string>> | null | undefined;

export function evidenceState(e: ExpenseWithEvidence, certificates?: CertificateStatuses): EvidenceState {
  // Only money we are handing back to a guide needs a receipt. Company-direct rows and
  // advance-funded rows are the company's own spending, evidenced elsewhere.
  if (canonicalPaidBy(e) !== "GUIDE_PERSONAL") return { state: "NOT_REQUIRED" };
  if (expenseAmount(e) <= 0) return { state: "NOT_REQUIRED" };
  if ((e.receiptUrl ?? "").trim() || (e.receiptFileId ?? "").trim()) return { state: "HAS_RECEIPT" };
  const w = e.evidenceWaiver;
  const what = (e.description ?? "").trim() || "an expense row";
  if (w && (w.reason ?? "").trim().length >= MIN_WAIVER_REASON && (w.by ?? "").trim() && (w.at ?? "").trim()) {
    const certId = (w.certificateId ?? "").trim();
    if (!certId) return { state: "WAIVED", waiver: w };
    // A waiver that rests on a certificate is worth exactly what that certificate is
    // worth today. Approved-but-not-yet-filed, filed-but-not-yet-linked, or withdrawn
    // are all "not evidence" — see lib/certificates/state.
    const status = certificates?.[certId];
    if (status === "LINKED") return { state: "WAIVED", waiver: w };
    const named = (w.certificateNo ?? "").trim() || "its certificate";
    const why = status === "VOID" ? `${named} was withdrawn`
      : status === "STALE" ? `${named} no longer matches the document filed for it`
      : status ? `${named} is not in use as evidence yet (${status})`
      : `${named} could not be checked`;
    return { state: "BLOCKED", reason: `"${what}" is being reimbursed to the guide against ${named}, and ${why}. Until the certificate is in force there is nothing behind this row.` };
  }
  return { state: "BLOCKED", reason: `"${what}" is being reimbursed to the guide with no receipt attached. Attach it, or have an admin record why it can be paid without one — a reimbursement with no evidence is pay, and pay is withheld on.` };
}

/** Every row that cannot be paid yet, in sheet order. */
export function blockedReimbursements(expenses: ExpenseWithEvidence[] | null | undefined): { expense: ExpenseWithEvidence; reason: string }[] {
  const out: { expense: ExpenseWithEvidence; reason: string }[] = [];
  for (const e of expenses ?? []) {
    const s = evidenceState(e);
    if (s.state === "BLOCKED") out.push({ expense: e, reason: s.reason });
  }
  return out;
}

/** What an admin must supply to waive. Returns the reasons it cannot be accepted. */
export function checkWaiver(input: { reason: string; by: string | null | undefined }): string[] {
  const reasons: string[] = [];
  if (!(input.by ?? "").trim()) reasons.push("A waiver has to name who accepted it");
  if ((input.reason ?? "").trim().length < MIN_WAIVER_REASON) {
    reasons.push(`Say why this row can be paid without a receipt — at least ${MIN_WAIVER_REASON} characters, and it is kept with the job sheet`);
  }
  return reasons;
}
