// Sending a filed certificate to the PEAK expense document its job is in.
//
// The ledger (lib/certificates/peak-attach) decides what an answer means and keeps one
// row per certificate per document. This is the part that does the sending, in order:
//
//   1. only a LINKED certificate is evidence, so only a LINKED one is sent;
//   2. which EXP: the one recorded on the certificate, or found by identity
//      (lib/certificates/peak-link) and recorded now;
//   3. PEAK is READ first — the document must exist under that number, be the same
//      document (its id), and not be void. An EXP number is reused after a void, so the
//      number alone is never trusted;
//   4. the filed PDF is checked in Drive (one ACTIVE file, private, bytes that hash to
//      what was filed) and those same bytes are what is sent;
//   5. the ledger row is claimed — a second click, a second tab or the loop racing a
//      button lose to the unique index and send nothing;
//   6. one insertfile request. Only a refusal of the ENCODING is sent again in the other
//      encoding, because that refusal proves nothing was stored.
//
// It changes no amount, no line, no withholding and no payment state in PEAK: a file is
// put beside a document that already exists. PEAK cannot read back a document's files, so
// "PEAK accepted it" is the most this can ever record; a person who looks confirms it.
//
// Advance-paid costs (COMPANY_ADVANCE) are not in any EXP — they are booked by journal —
// and PEAK's API has no way to attach a file to a journal. Those are refused with the
// reason, and stay a manual attachment in PEAK.
import type { ExpenseCertificate, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getExpense, insertExpenseFileReply, insertFileEncodingRejected, type PeakExpenseState } from "@/lib/peak-api";
import { certificateFileName } from "@/lib/certificates/pdf";
import { checkFiledDocument } from "@/lib/certificates/service";
import { fileHash } from "@/lib/certificates/payload";
import { peakDocumentForJob, stampPeakLink } from "@/lib/certificates/peak-link";
import { googleCertificateDrive, type CertificateDrive } from "@/lib/certificates/drive";
import { folkpathsDriveToken } from "@/lib/google-drive";
import {
  AttachRefused, attachEnabled, claimAttachment, classifyPeakReply, reclaimRefused, recordAttempt,
  type Outcome, type RequestEncoding,
} from "@/lib/certificates/peak-attach";

type Actor = { actorId: string | null; actorRole: string | null };
type InsertReply = Awaited<ReturnType<typeof insertExpenseFileReply>>;

export type SendDeps = {
  db?: PrismaClient;
  readExpense?: (ref: { id?: string | null; code: string }) => ReturnType<typeof getExpense>;
  insert?: (input: Parameters<typeof insertExpenseFileReply>[0], encoding: "data-uri" | "plain") => Promise<InsertReply>;
  drive?: CertificateDrive;
  /** Skip the Drive privacy/identity check — tests that bring their own bytes only. */
  checkFile?: (cert: ExpenseCertificate) => Promise<{ ok: boolean; reasons: string[] }>;
};

export type SendResult =
  | { ok: true; state: string; rowId: string; documentNo: string; replayed: boolean }
  | { ok: false; status: number; reasons: string[] };

const refused = (status: number, ...reasons: string[]): SendResult => ({ ok: false, status, reasons });

/** Why this certificate cannot be sent, or null. Pure: what the record says, nothing remote. */
export function sendRefusal(cert: Pick<ExpenseCertificate, "status" | "kind" | "driveFileId" | "pdfHash">): string | null {
  if (cert.kind === "COMPANY_ADVANCE") {
    return "Advance-paid costs are booked by journal, not in an EXP, and PEAK's API cannot attach a file to a journal. Attach this certificate to the journal by hand in PEAK.";
  }
  if (cert.status !== "LINKED") return "Only a certificate that is filed and linked to its job sheet is evidence, so only that is sent to PEAK.";
  if (!cert.driveFileId || !cert.pdfHash) return "This certificate has no filed PDF to send.";
  return null;
}

/** The PEAK document, read from PEAK, that this certificate goes with — or why not. */
async function resolveDocument(cert: ExpenseCertificate, deps: SendDeps, actor: Actor):
  Promise<{ ok: true; expense: PeakExpenseState } | { ok: false; status: number; reasons: string[] }> {
  const db = deps.db ?? prisma;
  let documentNo = (cert.peakDocumentNo ?? "").trim();
  let documentId = (cert.peakDocumentId ?? "").trim() || null;
  if (!documentNo) {
    const found = await peakDocumentForJob({ guideId: cert.guideId, date: cert.tourDate, slotIdx: cert.slotIdx }, db);
    if (!found.found) return { ok: false, status: 409, reasons: [found.reason] };
    if (!found.link.documentNo) return { ok: false, status: 409, reasons: ["This job's PEAK document has no EXP number yet."] };
    const stamped = await stampPeakLink(cert, found.link, actor, db);
    if (stamped === "conflict") return { ok: false, status: 409, reasons: ["This certificate already names a different PEAK document. Nothing was sent."] };
    documentNo = found.link.documentNo;
    documentId = found.link.documentId;
  }
  const read = await (deps.readExpense ?? getExpense)({ id: documentId, code: documentNo });
  if (!read.ok) return { ok: false, status: 502, reasons: [`PEAK could not be read, so nothing was sent: ${read.desc ?? "unknown error"}`] };
  if (read.notFound || !read.expense) return { ok: false, status: 409, reasons: [`${documentNo} is not in PEAK. Nothing was sent.`] };
  const e = read.expense;
  if (e.code !== documentNo) return { ok: false, status: 409, reasons: [`PEAK holds ${e.code || "another number"} under the id on record, not ${documentNo}. Nothing was sent.`] };
  if (documentId && e.id && e.id !== documentId) return { ok: false, status: 409, reasons: [`${documentNo} in PEAK is a different document from the one on record (the number was reused). Nothing was sent.`] };
  if (e.isVoid) return { ok: false, status: 409, reasons: [`${documentNo} is void in PEAK. A certificate is not attached to a void document.`] };
  if (!e.id) return { ok: false, status: 502, reasons: [`PEAK returned ${documentNo} without its id. Nothing was sent.`] };
  if (!documentId) {
    // Recorded by hand (Record EXP…) with no id: the id PEAK just gave is written down, so
    // the ledger row and every later read name the document, not only its number.
    await db.expenseCertificate.updateMany({ where: { id: cert.id, peakDocumentId: null, peakDocumentNo: documentNo }, data: { peakDocumentId: e.id, peakDocumentLink: e.documentLink } });
  }
  return { ok: true, expense: e };
}

async function readFiledBytes(cert: ExpenseCertificate, deps: SendDeps): Promise<{ ok: true; bytes: Buffer } | { ok: false; reasons: string[] }> {
  const check = deps.checkFile ? await deps.checkFile(cert) : await checkFiledDocument(cert, deps.drive ? { drive: deps.drive } : {});
  if (!check.ok) return { ok: false, reasons: check.reasons };
  let drive = deps.drive;
  if (!drive) {
    const t = await folkpathsDriveToken();
    if (!t) return { ok: false, reasons: ["Google Drive is not connected, so the certificate cannot be read."] };
    drive = googleCertificateDrive(t);
  }
  const bytes = await drive.read({ fileId: cert.driveFileId! }).catch(() => null);
  // Hashed again on the copy about to leave: the check above read the file a moment ago.
  if (!bytes || fileHash(bytes) !== cert.pdfHash) return { ok: false, reasons: ["The PDF read from Drive is not the one that was filed. Nothing was sent; file the certificate again."] };
  return { ok: true, bytes };
}

/** Send one request and say what it means. A request that never left is a refusal: nothing can have been stored. */
async function sendOnce(deps: SendDeps, input: Parameters<typeof insertExpenseFileReply>[0], encoding: "data-uri" | "plain"): Promise<Outcome> {
  const reply = await (deps.insert ?? insertExpenseFileReply)(input, encoding);
  if (!reply.sent) {
    return { state: "REFUSED", resCode: null, resDesc: reply.transportError, why: "The request never left FolkOPS, so nothing can have reached PEAK." };
  }
  return classifyPeakReply({ httpStatus: reply.httpStatus, body: reply.body, transportError: reply.transportError });
}

async function send(rowId: string, token: string, bytes: Buffer, expense: PeakExpenseState, fileName: string, actor: Actor, deps: SendDeps) {
  const input = { transactionId: expense.id, transactionCode: expense.code, fileName, base64: bytes.toString("base64"), fileType: "document" as const, mime: "application/pdf" };
  const at = new Date();
  let encoding: RequestEncoding = "DATA_URI_BASE64";
  let outcome = await sendOnce(deps, input, "data-uri");
  // PEAK refused the encoding itself: nothing was stored, so the other reading is safe to try.
  if (outcome.state === "REFUSED" && insertFileEncodingRejected(outcome.resDesc)) {
    encoding = "PLAIN_BASE64";
    outcome = await sendOnce(deps, input, "plain");
  }
  return recordAttempt(rowId, token, { encoding, at }, outcome, actor, deps.db ?? prisma);
}

/**
 * Attach one certificate to its EXP. Safe to call twice: the second call finds the first's
 * ledger row and sends nothing.
 */
export async function attachCertificateToPeak(certificateId: string, actor: Actor, deps: SendDeps = {}): Promise<SendResult> {
  if (!attachEnabled()) return refused(503, "Attaching certificates to PEAK is switched off (CERTIFICATE_PEAK_ATTACH). Nothing was sent.");
  const db = deps.db ?? prisma;
  const cert = await db.expenseCertificate.findUnique({ where: { id: certificateId } });
  if (!cert) return refused(404, "No such certificate");
  const why = sendRefusal(cert);
  if (why) return refused(409, why);

  const doc = await resolveDocument(cert, deps, actor);
  if (!doc.ok) return refused(doc.status, ...doc.reasons);
  const existing = await db.peakAttachment.findUnique({ where: { certificateId_peakDocumentId: { certificateId: cert.id, peakDocumentId: doc.expense.id! } } });
  if (existing) return { ok: true, state: existing.state, rowId: existing.id, documentNo: doc.expense.code, replayed: true };

  const file = await readFiledBytes(cert, deps);
  if (!file.ok) return refused(409, ...file.reasons);

  const fileName = certificateFileName(cert.certificateNo);
  try {
    const claim = await claimAttachment({
      certificateId: cert.id, certificateNo: cert.certificateNo, peakDocumentId: doc.expense.id!, peakDocumentNo: doc.expense.code,
      peakPaymentRef: cert.peakPaymentRef, pdfHash: cert.pdfHash!, fileName,
    }, actor.actorId, db);
    if (!claim.claimed || !claim.token) return { ok: true, state: claim.row.state, rowId: claim.row.id, documentNo: doc.expense.code, replayed: true };
    const row = await send(claim.row.id, claim.token, file.bytes, doc.expense, fileName, actor, deps);
    return { ok: true, state: row?.state ?? "CLAIMED", rowId: claim.row.id, documentNo: doc.expense.code, replayed: false };
  } catch (e) {
    if (e instanceof AttachRefused) return refused(e.status, ...e.reasons);
    throw e;
  }
}

/** Send a REFUSED attempt again, on the same ledger row (admin only — the route checks). */
export async function retryRefusedAttachment(rowId: string, actor: { id: string; role: string }, deps: SendDeps = {}): Promise<SendResult> {
  if (!attachEnabled()) return refused(503, "Attaching certificates to PEAK is switched off (CERTIFICATE_PEAK_ATTACH). Nothing was sent.");
  const db = deps.db ?? prisma;
  const row = await db.peakAttachment.findUnique({ where: { id: rowId }, include: { certificate: true } });
  if (!row) return refused(404, "No such attachment record");
  if (row.state !== "REFUSED") return refused(409, "Only a refused attempt can be sent again. An uncertain one is settled by looking in PEAK.");
  const cert = row.certificate;
  const why = sendRefusal(cert);
  if (why) return refused(409, why);
  const read = await (deps.readExpense ?? getExpense)({ id: row.peakDocumentId, code: row.peakDocumentNo ?? "" });
  if (!read.ok || !read.expense) return refused(409, `PEAK could not confirm ${row.peakDocumentNo ?? "the document"}: ${read.ok ? "not found" : read.desc}. Nothing was sent.`);
  if (read.expense.isVoid || read.expense.id !== row.peakDocumentId) return refused(409, `${row.peakDocumentNo} is void or no longer the same document in PEAK. Nothing was sent.`);
  if (row.pdfHash !== cert.pdfHash) return refused(409, "The filed PDF is not the one this attempt was made for. Nothing was sent.");
  const file = await readFiledBytes(cert, deps);
  if (!file.ok) return refused(409, ...file.reasons);
  try {
    const claim = await reclaimRefused(rowId, actor, db);
    const after = await send(rowId, claim.token, file.bytes, read.expense, row.fileName, { actorId: actor.id, actorRole: actor.role }, deps);
    return { ok: true, state: after?.state ?? "CLAIMED", rowId, documentNo: read.expense.code, replayed: false };
  } catch (e) {
    if (e instanceof AttachRefused) return refused(e.status, ...e.reasons);
    throw e;
  }
}

/** PEAK allows two file uploads a minute per token; one a minute leaves room for a button. */
export const ATTACH_MIN_GAP_MS = 60_000;
/** A certificate that could not be sent (no EXP yet, EXP void, Drive check failed) is looked at again after this. */
export const SKIP_BACKOFF_MS = 60 * 60_000;
const skippedUntil = new Map<string, number>();

/**
 * The background step (FP sync loop): attach at most one certificate per call, and none if
 * any attachment was attempted in the last minute. Only certificates with no ledger row at
 * all are picked — a refused or uncertain attempt is never sent again without a person.
 * One that cannot be sent yet is skipped for an hour; nothing is written for it.
 */
export async function attachNextCertificate(db: PrismaClient = prisma, deps: SendDeps = {}, now = Date.now()): Promise<SendResult | null> {
  if (!attachEnabled()) return null;
  const recent = await db.peakAttachment.findFirst({ where: { createdAt: { gt: new Date(now - ATTACH_MIN_GAP_MS) } }, select: { id: true } });
  if (recent) return null;
  const due = await db.expenseCertificate.findMany({
    where: { status: "LINKED", kind: "GUIDE_PAID", driveFileId: { not: null }, pdfHash: { not: null }, attachments: { none: {} } },
    orderBy: { linkedAt: "asc" },
    select: { id: true },
    take: 50,
  });
  const actor = { actorId: null, actorRole: "SYSTEM" };
  for (const c of due) {
    if ((skippedUntil.get(c.id) ?? 0) > now) continue;
    const r = await attachCertificateToPeak(c.id, actor, { ...deps, db });
    if (r.ok) { skippedUntil.delete(c.id); return r; }
    skippedUntil.set(c.id, now + SKIP_BACKOFF_MS);
    if (r.status === 502 || r.status === 503) return r; // PEAK or Drive is down: stop for this minute
  }
  return null;
}

/** Tests only. */
export const resetAttachBackoff = () => skippedUntil.clear();
