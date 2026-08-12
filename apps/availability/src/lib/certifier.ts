// The authorized job-sheet certifier — the person who prepares/certifies the
// internal job sheet before it becomes accounting evidence (e.g. attached in
// PEAK). ONE fixed certifier today; extend this object (not the UI) for future
// certifiers. The signature is the repo's existing static asset
// public/approver-signature.png (transparent RGBA) — served read-only, so
// guides have no path to replace or edit it. Not a cryptographic signature:
// the document simply says "Certified by".
export const JOB_SHEET_CERTIFIER = {
  id: "hathaiwan-jaiplod",
  nameTh: "หทัยวรรณ ใจปลอด",
  signatureUrl: "/approver-signature.png?v=2", // ?v busts stale PWA/browser caches of the pre-fix asset
  signatureFile: "approver-signature.png", // under public/ — for server-side inlining into the PDF
} as const;

// The certification date printed under the signature: the sheet's FIRST
// successful operator save (JobSheet.certifiedAt — stamped once, server-side).
// Historical sheets saved before the field existed fall back to the operator's
// expense-approval time. NEVER the tour date, and never a value that drifts
// when the sheet is reopened or re-saved.
export function certificationDate(sheet: { certifiedAt?: string | Date | null; approvedAt?: string | Date | null }): Date | null {
  const v = sheet.certifiedAt ?? sheet.approvedAt ?? null;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// "13 Aug 2026" — the document-facing format, always in Thailand time. The full
// timestamp stays stored for audit; only the display is day-granular.
export function fmtCertDate(d: Date | null): string {
  return d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Bangkok" }) : "";
}
