// Where a certificate is in its life, and what may happen next.
//
//   DRAFT          the rows are chosen; nothing has been approved
//   READY_TO_ATTEST  everything checks out and it is waiting for a person
//   ATTESTED         approved by a named person from their own session
//   UPLOADED       the approved document is in Drive
//   LINKED         the rows on the job sheet point at it — and ONLY NOW is it evidence
//   VOID           withdrawn, with a reason; it can never come back
//
// The gap between ATTESTED and LINKED is not ceremony. A document can be approved, and the
// upload can fail; the upload can succeed and the database write fail. Until the rows and
// the file agree, nobody should be paid on the strength of it, so nothing short of LINKED
// counts. That is the whole reason the states are separate.

export const CERTIFICATE_STATES = ["DRAFT", "READY_TO_ATTEST", "ATTESTED", "UPLOADED", "LINKED", "STALE", "VOID"] as const;
export type CertificateState = (typeof CERTIFICATE_STATES)[number];

const NEXT: Record<CertificateState, CertificateState[]> = {
  DRAFT: ["READY_TO_ATTEST", "VOID"],
  READY_TO_ATTEST: ["ATTESTED", "DRAFT", "VOID"],
  ATTESTED: ["UPLOADED", "VOID"],
  // An upload that has to be retried comes back through UPLOADED, so a half-finished
  // one is not a dead end.
  UPLOADED: ["LINKED", "UPLOADED", "VOID"],
  // A linked certificate whose document has changed in Drive. It was evidence and is
  // not any more; filing it again is what brings it back.
  LINKED: ["STALE", "VOID"],
  STALE: ["ATTESTED", "VOID"],
  VOID: [],
};

export function canMove(from: CertificateState, to: CertificateState): boolean {
  return (NEXT[from] ?? []).includes(to);
}

export function moveRefusal(from: CertificateState, to: CertificateState): string | null {
  if (canMove(from, to)) return null;
  if (from === "VOID") return "This certificate was withdrawn. Issue a new one instead — a withdrawn document is kept as it was.";
  if (from === "LINKED") return "This certificate is already in use as evidence. Withdraw it, with a reason, before anything else.";
  if (from === "STALE") return "The document behind this certificate has changed, so it is not evidence any more. File it again, or withdraw it.";
  return `A certificate cannot go from ${LABEL[from]} to ${LABEL[to]}.`;
}

/** The only state in which a certificate stands in for a receipt. */
export const EVIDENCE_STATE: CertificateState = "LINKED";
export const isEvidence = (s: string | null | undefined): boolean => s === EVIDENCE_STATE;

/** Alive — occupying its job sheet's single active slot. */
export const isActive = (s: string | null | undefined): boolean => s !== "VOID" && CERTIFICATE_STATES.includes(s as CertificateState);

export const LABEL: Record<CertificateState, string> = {
  DRAFT: "Draft",
  READY_TO_ATTEST: "Ready to approve",
  ATTESTED: "Approved",
  UPLOADED: "Filed in Drive",
  LINKED: "In use as evidence",
  STALE: "Document changed — not evidence",
  VOID: "Withdrawn",
};

export const LABEL_TH: Record<CertificateState, string> = {
  DRAFT: "ฉบับร่าง",
  READY_TO_ATTEST: "พร้อมรับรอง",
  ATTESTED: "รับรองแล้ว",
  UPLOADED: "จัดเก็บใน Drive แล้ว",
  LINKED: "ใช้เป็นหลักฐานแล้ว",
  STALE: "เอกสารเปลี่ยน — ใช้เป็นหลักฐานไม่ได้",
  VOID: "ยกเลิกแล้ว",
};

/**
 * What this system does, in the words it is allowed to use.
 *
 * There is no key, no certificate authority and no cryptographic signature anywhere in
 * this feature. Calling it one would be claiming a guarantee that is not there, so the
 * wording is fixed here and a repository test refuses the other phrasing outright.
 */
export const APPROVAL_TERM_TH = "รับรองเอกสารทางอิเล็กทรอนิกส์";
export const APPROVAL_TERM_EN = "electronic certification by an authenticated user";
export const FORBIDDEN_TERM_TH = "ลายเซ็นดิจิทัล";

/** A reason has to say something. Withdrawing a document is a decision, not a click. */
export const MIN_VOID_REASON = 10;
