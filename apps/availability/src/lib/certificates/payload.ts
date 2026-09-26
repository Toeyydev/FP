import { createHash } from "node:crypto";
import { expenseAmount, isReviewExpense, type Expense } from "@/lib/jobsheet";
import { canonicalPaidBy } from "@/lib/peak-sync";
import { evidenceState, type ExpenseWithEvidence } from "@/lib/reimbursement-evidence";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";
import type { ExpenseSource } from "@/lib/certificates/source";
import { requestedForCertificate, type RequestableRow } from "@/lib/certificates/request";

// What a certificate says, reduced to one string that always comes out the same way.
//
// Two questions get asked of a certificate later, and they are not the same question:
//
//   payloadHash  has the job sheet changed since this was approved?
//   pdfHash      is the file sitting in Drive the file that was uploaded?
//
// The first is answered here. It covers the rows the certificate speaks for and the
// facts printed on it, with the keys in a fixed order and money in satang, so that the
// same sheet hashes alike on any machine and a changed one does not. It is a change
// detector over CONTENT — it says nothing about who approved the document. Who approved
// it is a session, a role and an audit row, and nothing about a hash makes that truer.
//
// Row order is part of the payload on purpose. The sheet's own order is what an operator
// reads and what the document prints, and a certificate that quietly accepted a
// re-ordered sheet would be certifying a page nobody saw.

export type CertifiableRow = {
  index: number;
  identity: string;
  description: string;
  pax: number;
  price: number;
  amountSatang: number;
  category: string;
};

export type CertificatePayload = {
  v: 1;
  jobRef: string;
  tourDate: string;
  slotIdx: number;
  guideId: string;
  guideName: string;
  /** When the guide filed their expense report from their own account. Never certifiedAt. */
  guideReportedAt: string | null;
  /**
   * Where the rows came from — the guide's own report, or an admin recording them.
   *
   * In the fingerprint because it is a claim about a person. A document saying an admin
   * entered the figures and one saying the guide reported them are different documents,
   * and a hash that could not tell them apart would let one be presented as the other.
   */
  source: ExpenseSource;
  /** Who entered the rows, when an admin did. Never a name from a request. */
  recordedBy: { id: string; name: string; role: string; at: string } | null;
  rows: CertifiableRow[];
  totalSatang: number;
  reason: string;
  /**
   * Which signature image was on the document — whose it is, which version, and its
   * fingerprint. Never the image itself: a payload is a thing to hash and compare, and
   * half a megabyte of base64 in it would make the hash about the picture rather than
   * about the expenses.
   *
   * Hashed on purpose. Swapping the image under a certificate changes what the document
   * shows, and a fingerprint that ignored it would say nothing had changed.
   */
  signature: { userId: string; version: number; sha256: string } | null;
};

/** The reason these rows have no receipt. One sentence, kept with the document. */
export const NO_RECEIPT_REASON_TH =
  "ผู้ให้บริการเป็นผู้ประกอบการรายย่อยที่ไม่ออกใบเสร็จรับเงิน เช่น เรือข้ามฟาก รถโดยสารประจำทาง และน้ำดื่มจากร้านค้าริมทาง";

const satang = (n: number) => Math.round(n * 100);

/**
 * The rows a certificate may speak for: the guide's own money, no receipt attached, and
 * no waiver already on them.
 *
 * A row the company paid needs no certificate — its evidence is on the company's side.
 * A row with a receipt, or an older admin waiver, needs none either — unless an admin
 * has asked for one on it (lib/certificates/request). `evidenceState` already draws that line, and
 * this uses it rather than drawing a second one that could drift from it.
 */
export function certifiableRows(expenses: readonly Expense[] | null | undefined): CertifiableRow[] {
  const out: CertifiableRow[] = [];
  (expenses ?? []).forEach((e, index) => {
    if (isReviewExpense(e)) return;
    // Needed on its own (the guide's money, nothing behind it), or asked for by an admin
    // on a row whose older waiver or receipt would otherwise keep it off (lib/certificates/request).
    if (evidenceState(e as ExpenseWithEvidence).state !== "BLOCKED" && !requestedForCertificate(e as RequestableRow)) return;
    out.push({
      index,
      identity: financialIdentity(e as ProtectedRow),
      description: (e.description ?? "").trim(),
      pax: Number(e.pax ?? 0),
      price: Number(e.price ?? 0),
      amountSatang: satang(expenseAmount(e)),
      category: String(e.expenseType ?? "other"),
    });
  });
  return out;
}

export type SheetFacts = {
  jobRef: string | null;
  tourDate: string;
  slotIdx: number;
  guideId: string;
  guideName: string;
  guideReportedAt: Date | null;
};

export function buildPayload(
  sheet: SheetFacts,
  rows: readonly CertifiableRow[],
  signature: { userId: string; version: number; sha256: string } | null = null,
  origin: { source: ExpenseSource; recordedBy: CertificatePayload["recordedBy"] } = { source: "GUIDE_REPORTED", recordedBy: null },
): CertificatePayload {
  return {
    v: 1,
    jobRef: sheet.jobRef ?? "",
    tourDate: sheet.tourDate,
    slotIdx: sheet.slotIdx,
    guideId: sheet.guideId,
    guideName: sheet.guideName,
    guideReportedAt: sheet.guideReportedAt ? sheet.guideReportedAt.toISOString() : null,
    source: origin.source,
    recordedBy: origin.recordedBy ? { ...origin.recordedBy } : null,
    rows: rows.map((r) => ({ ...r })),
    totalSatang: rows.reduce((t, r) => t + r.amountSatang, 0),
    reason: NO_RECEIPT_REASON_TH,
    signature: signature ? { ...signature } : null,
  };
}

/** The payload as one string, with every key in a fixed place. */
export function canonicalString(p: CertificatePayload): string {
  const row = (r: CertifiableRow) =>
    [r.index, r.identity, r.description, r.pax, satang(r.price), r.amountSatang, r.category].map((v) => String(v)).join("~");
  return [
    `v=${p.v}`,
    `job=${p.jobRef}`,
    `date=${p.tourDate}`,
    `slot=${p.slotIdx}`,
    `guide=${p.guideId}`,
    `guideName=${p.guideName}`,
    `reported=${p.guideReportedAt ?? ""}`,
    `source=${p.source}`,
    `recordedBy=${p.recordedBy ? `${p.recordedBy.id}:${p.recordedBy.at}` : ""}`,
    `rows=${p.rows.map(row).join("|")}`,
    `total=${p.totalSatang}`,
    `reason=${p.reason}`,
    `sig=${p.signature ? `${p.signature.userId}:${p.signature.version}:${p.signature.sha256}` : ""}`,
  ].join(";");
}

/** SHA-256 of the canonical string. A content fingerprint, not a claim about a person. */
export function payloadHash(p: CertificatePayload): string {
  return createHash("sha256").update(canonicalString(p), "utf8").digest("hex");
}

/** SHA-256 of the bytes that were uploaded. Says the file is the file, nothing more. */
export function fileHash(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Short form for a screen. Enough to compare two by eye, never enough to reconstruct. */
export const shortHash = (h: string | null | undefined) => (h ?? "").slice(0, 12);

export type DriftResult = { drifted: boolean; reasons: string[] };

/**
 * Has the sheet moved under a certificate that was already approved?
 *
 * The payload is rebuilt from the sheet as it stands now and compared by hash. Anything
 * that changes what the document says — a row edited, added, removed, reordered, a payer
 * changed, a receipt attached — changes the hash, and the certificate no longer describes
 * the sheet. It is not repaired and the PDF is never edited: it is voided and a new one
 * issued, so the old document keeps saying what it said when it was approved.
 */
export function checkDrift(
  stored: {
    payloadHash: string; coveredRows: CertifiableRow[];
    signature?: CertificatePayload["signature"];
    /** The origin this certificate was issued under. Fixed, so it is carried, not rebuilt. */
    origin?: {
      source: ExpenseSource;
      recordedBy: CertificatePayload["recordedBy"];
      /** The guide-report fact AS AT ISSUE, for a document that does not stand on it. */
      guideReportedAt?: string | null;
    };
  },
  sheetNow: { facts: SheetFacts; expenses: Expense[] },
): DriftResult {
  const reasons: string[] = [];
  const nowRows = certifiableRows(sheetNow.expenses);
  // Rebuilt with the signature the certificate already carries, because this asks one
  // question only: has the JOB SHEET moved? A signature replaced since would make every
  // rebuild differ and report the sheet as changed when nothing on it had. Whether the
  // image is still the attested one is a different question, asked where it is answerable
  // — against what is registered now, at the moment the image goes on the page.
  // Whether the guide has since filed a report is only this document's business if the
  // document claims they did.
  //
  //   GUIDE_REPORTED   the page says "the guide reported at X". If X moves, the document
  //                    is wrong about the thing it asserts, and that is drift.
  //
  //   ADMIN_RECORDED   the page says an admin entered the rows. The guide filing a week
  //                    later changes nothing about that — those are still the admin's
  //                    figures, recorded at the time stated — so comparing against the
  //                    sheet's current value would report a change in a fact this
  //                    document never depended on, and refuse to link a certificate that
  //                    is entirely correct. The snapshot is compared with itself.
  const origin = stored.origin ?? { source: "GUIDE_REPORTED" as ExpenseSource, recordedBy: null };
  const facts: SheetFacts = origin.source === "ADMIN_RECORDED"
    ? { ...sheetNow.facts, guideReportedAt: origin.guideReportedAt ? new Date(origin.guideReportedAt) : null }
    : sheetNow.facts;
  const now = buildPayload(facts, nowRows, stored.signature ?? null, origin);
  if (payloadHash(now) === stored.payloadHash) return { drifted: false, reasons };

  const was = new Map(stored.coveredRows.map((r) => [r.identity, r]));
  const is = new Map(nowRows.map((r) => [r.identity, r]));
  for (const [id, r] of was) if (!is.has(id)) reasons.push(`"${r.description}" (${r.pax}×${r.price}) is no longer on the sheet as the certificate describes it`);
  for (const [id, r] of is) if (!was.has(id)) reasons.push(`"${r.description}" (${r.pax}×${r.price}) now needs a receipt and the certificate does not cover it`);
  for (const [id, r] of was) {
    const n = is.get(id);
    if (n && n.index !== r.index) reasons.push(`"${r.description}" has moved from row ${r.index + 1} to row ${n.index + 1}`);
  }
  if (!reasons.length) reasons.push("the job sheet has changed since this certificate was approved");
  return { drifted: true, reasons };
}

/**
 * Two rows on one sheet that read the same cannot be told apart, and a certificate that
 * covered one of them would be attaching a record to whichever came first.
 *
 * The save path refuses the same case for the same reason (lib/protected-expense-fields).
 * Both use `financialIdentity`, so neither can decide a row is "the same row" that the
 * other would not.
 */
export function duplicateIdentities(rows: readonly CertifiableRow[], all: readonly Expense[] | null | undefined): string[] {
  const count = new Map<string, number>();
  for (const e of all ?? []) {
    if (isReviewExpense(e) || expenseAmount(e) <= 0) continue;
    const id = financialIdentity(e as ProtectedRow);
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if ((count.get(r.identity) ?? 0) <= 1 || seen.has(r.identity)) continue;
    seen.add(r.identity);
    out.push(`"${r.description}" (${r.pax}×${r.price}) appears ${count.get(r.identity)} times on this job sheet. Nothing can tell those rows apart, so a certificate cannot say which one it covers — make the rows say what each one is for first.`);
  }
  return out;
}

/** Rows a certificate must never cover, with why. Checked again at every stage. */
export function ineligibleRows(expenses: readonly Expense[] | null | undefined): string[] {
  const out: string[] = [];
  (expenses ?? []).forEach((e, i) => {
    if (isReviewExpense(e) || expenseAmount(e) <= 0) return;
    if (canonicalPaidBy(e) === "UNSPECIFIED") {
      out.push(`Row ${i + 1} "${(e.description ?? "").trim() || "an expense"}" has no Paid By. Until somebody says whose money it was, there is nothing to certify.`);
    }
  });
  return out;
}
