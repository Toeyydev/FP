import type { Prisma, PrismaClient, ExpenseCertificate, JobSheet } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Expense } from "@/lib/jobsheet";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";
import { type EvidenceWaiver } from "@/lib/reimbursement-evidence";
import { buildPayload, certifiableRows, checkDrift, duplicateIdentities, fileHash, ineligibleRows, payloadHash, type CertifiableRow, type CertificatePayload, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";
import { certificateFileName, certificateFolder, pdfRendererAvailable, renderPdf as defaultRenderPdf, type RenderPdf } from "@/lib/certificates/pdf";
import { canMove, MIN_VOID_REASON, moveRefusal, type CertificateState } from "@/lib/certificates/state";
import { downloadDriveFile, folkpathsDriveToken, saveBufferToDrive } from "@/lib/google-drive";

// Issuing, approving, filing and linking a certificate.
//
// The shape of this file is dictated by one fact: Drive is somebody else's computer, and
// a call to it can succeed while the transaction that was going to record it fails. So
// the database work is in transactions and the upload is deliberately outside one, with
// the intent written down before the call and a deterministic filename so that a retry
// lands on the same file instead of making a second.

export type Deps = {
  db?: PrismaClient;
  renderPdf?: RenderPdf;
  uploadPdf?: (o: { bytes: Buffer; name: string; folderPath: string[] }) => Promise<{ id: string; link: string }>;
  /** Read the filed bytes back, so the record is of the file that is actually there. */
  fetchPdf?: (o: { fileId: string; link: string }) => Promise<Buffer | null>;
  now?: () => Date;
};

export type Actor = { id: string; name: string; role: string };

export class CertificateRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "CertificateRefused";
  }
}

const refuse = (reasons: string[], status = 409): never => { throw new CertificateRefused(reasons, status); };

function facts(sheet: JobSheet, guideName: string): SheetFacts {
  return {
    jobRef: sheet.ref, tourDate: sheet.date, slotIdx: sheet.slotIdx,
    guideId: sheet.guideId, guideName,
    guideReportedAt: sheet.guideExpensesAt ?? null,
  };
}

/** Everything that must be true before a certificate may exist for this sheet. */
function eligibility(sheet: JobSheet, rows: CertifiableRow[]): string[] {
  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const out: string[] = [];
  // The guide's own act. Not certifiedAt — that is the operator's first save and says
  // nothing about the guide (lib/certifier).
  if (!sheet.guideExpensesAt) {
    out.push("This job sheet has no expense report from the guide. A certificate stands on the guide having filed their expenses from their own account, so there is nothing to certify yet.");
  }
  out.push(...ineligibleRows(expenses));
  out.push(...duplicateIdentities(rows, expenses));
  if (!rows.length) out.push("No row on this job sheet needs a certificate — every reimbursement either has a receipt or is not the guide's own money.");
  return out;
}

async function guideNameOf(db: PrismaClient | Prisma.TransactionClient, guideId: string): Promise<string> {
  const u = await db.user.findFirst({ where: { guideId }, select: { fullName: true, displayName: true } });
  return (u?.fullName || u?.displayName || guideId).trim();
}

/** Look up a job sheet by its natural key, or say so. */
async function loadSheet(db: PrismaClient | Prisma.TransactionClient, key: { guideId: string; date: string; slotIdx: number }): Promise<JobSheet> {
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key } });
  if (!sheet) refuse(["No such job sheet"], 404);
  return sheet!;
}

// ── 1. Issue a draft ─────────────────────────────────────────────────────────
//
// One transaction. The unique index on activeJobSheetId is what stops a second
// certificate existing for the same sheet, so two people pressing the button at once
// produce one certificate and one refusal, not two documents.

export async function createCertificate(key: { guideId: string; date: string; slotIdx: number }, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const made = await db.$transaction(async (tx) => {
    const sheet = await loadSheet(tx, key);
    const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
    const rows = certifiableRows(expenses);
    const problems = eligibility(sheet, rows);
    if (problems.length) refuse(problems);

    const existing = await tx.expenseCertificate.findUnique({ where: { activeJobSheetId: sheet.id } });
    if (existing) refuse([`This job sheet already has certificate ${existing.certificateNo}. Withdraw it first, with a reason, if it needs replacing.`]);

    const name = await guideNameOf(tx, sheet.guideId);
    const payload = buildPayload(facts(sheet, name), rows);
    const issued = await tx.expenseCertificate.count({ where: { jobSheetId: sheet.id } });
    const certificateNo = `CERT-${sheet.ref ?? `${sheet.date}-${sheet.slotIdx}`}-${String(issued + 1).padStart(2, "0")}`;

    return tx.expenseCertificate.create({
      data: {
        certificateNo, jobSheetId: sheet.id, activeJobSheetId: sheet.id,
        guideId: sheet.guideId, jobRef: sheet.ref, tourDate: sheet.date, slotIdx: sheet.slotIdx,
        status: "READY_TO_ATTEST" satisfies CertificateState,
        payload: payload as unknown as Prisma.InputJsonValue,
        payloadHash: payloadHash(payload),
        coveredRows: rows as unknown as Prisma.InputJsonValue,
        totalSatang: payload.totalSatang,
        sourceGuideReportedAt: sheet.guideExpensesAt,
        sourceSheetUpdatedAt: sheet.updatedAt,
        createdById: actor.id,
        createdAt: now(),
      },
    });
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.created", entityType: "ExpenseCertificate", entityId: made.id,
    detail: { certificateNo: made.certificateNo, jobRef: made.jobRef, rows: (made.coveredRows as unknown as CertifiableRow[]).length, totalSatang: made.totalSatang, payloadHash: made.payloadHash } });
  return made;
}

// ── 2. Approve it ────────────────────────────────────────────────────────────
//
// One transaction, and the sheet is read again inside it. The certificate was built from
// the sheet as it was; if it has moved since, approving would put a person's name on a
// document that no longer describes anything.
//
// The attester is taken from `actor`, which every caller builds from the session. Nothing
// on this path reads a name, an id or a role out of a request body.

export async function attestCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const signed = await db.$transaction(async (tx) => {
    const cert = await tx.expenseCertificate.findUnique({ where: { id } });
    if (!cert) refuse(["No such certificate"], 404);
    const bad = moveRefusal(cert!.status as CertificateState, "ATTESTED");
    if (bad) refuse([bad]);

    const sheet = await tx.jobSheet.findUnique({ where: { id: cert!.jobSheetId } });
    if (!sheet) refuse(["The job sheet this certificate belongs to is gone"], 404);
    const expenses = (sheet!.expenses as unknown as Expense[]) ?? [];
    const rows = certifiableRows(expenses);
    const problems = eligibility(sheet!, rows);
    if (problems.length) refuse(problems);

    const name = await guideNameOf(tx, sheet!.guideId);
    const drift = checkDrift(
      { payloadHash: cert!.payloadHash, coveredRows: cert!.coveredRows as unknown as CertifiableRow[] },
      { facts: facts(sheet!, name), expenses },
    );
    if (drift.drifted) {
      refuse(["This job sheet has changed since the certificate was prepared, so it no longer describes the sheet:", ...drift.reasons, "Withdraw this certificate and issue a new one."]);
    }
    // The amounts on the document have to be the amounts on the sheet.
    const total = rows.reduce((t, r) => t + r.amountSatang, 0);
    if (total !== cert!.totalSatang) refuse([`The total has changed from ${(cert!.totalSatang / 100).toFixed(2)} to ${(total / 100).toFixed(2)}. Withdraw this certificate and issue a new one.`]);

    return tx.expenseCertificate.update({
      where: { id, status: cert!.status },
      data: {
        status: "ATTESTED" satisfies CertificateState,
        attestedByUserId: actor.id, attestedByName: actor.name, attestedByRole: actor.role, attestedAt: now(),
        sourceSheetUpdatedAt: sheet!.updatedAt, sourceGuideReportedAt: sheet!.guideExpensesAt,
      },
    });
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.attested", entityType: "ExpenseCertificate", entityId: signed.id,
    detail: { certificateNo: signed.certificateNo, jobRef: signed.jobRef, totalSatang: signed.totalSatang, payloadHash: signed.payloadHash,
      approval: "electronic certification by an authenticated user — session identity, role and this audit row; no cryptographic signature" } });
  return signed;
}

// ── 3. File it in Drive ──────────────────────────────────────────────────────
//
// The one step that is not a transaction, because it calls out to Drive.
//
// The order is: say we are about to upload, upload, then record what came back. If the
// last write fails, the row is left at ATTESTED with uploadStartedAt set — visibly
// half-finished rather than silently wrong — and pressing the button again re-renders
// the same payload to the same filename, which Drive replaces in place and returns the
// same file id for. Nothing is orphaned and nothing is duplicated.

export async function uploadCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const render = deps.renderPdf ?? defaultRenderPdf;

  const cert = await db.expenseCertificate.findUnique({ where: { id } });
  if (!cert) refuse(["No such certificate"], 404);
  if (cert!.status !== "ATTESTED" && cert!.status !== "UPLOADED") refuse([moveRefusal(cert!.status as CertificateState, "UPLOADED") ?? "This certificate has not been approved yet."]);
  if (!deps.uploadPdf && !deps.renderPdf && !pdfRendererAvailable()) {
    refuse(["This deployment has no PDF renderer configured, so the certificate cannot be filed. The approval is recorded and filing can be retried once it is."], 503);
  }

  // Written before the call, so a crash between here and the response is recoverable.
  await db.expenseCertificate.update({ where: { id }, data: { uploadStartedAt: now() } });

  const payload = cert!.payload as unknown as CertificatePayload;
  const html = renderCertificateHtml({
    certificateNo: cert!.certificateNo,
    payload,
    payloadHash: cert!.payloadHash,
    attestedByName: cert!.attestedByName ?? "",
    attestedByRole: cert!.attestedByRole ?? "",
    attestedAt: (cert!.attestedAt ?? new Date(0)).toISOString(),
    auditRef: cert!.id,
  });
  const bytes = await render(html);
  const pdfHash = fileHash(bytes);
  const name = certificateFileName(cert!.certificateNo);
  const folderPath = certificateFolder(cert!.tourDate);

  let filed: { id: string; link: string };
  if (deps.uploadPdf) {
    filed = await deps.uploadPdf({ bytes, name, folderPath });
  } else {
    const token = await folkpathsDriveToken(actor.id);
    if (!token) refuse(["Google Drive is not connected, so the certificate cannot be filed. The approval is recorded and filing can be retried."], 503);
    filed = await saveBufferToDrive({ refreshToken: token!, name, base64: bytes.toString("base64"), mimeType: "application/pdf", folderPath });
  }

  // Read it back and hash what is actually there. An upload that half-landed, or landed
  // against a name something else already had, would otherwise be recorded as this
  // document — and the hash would be of bytes nobody can fetch.
  const verify = deps.fetchPdf ?? (async ({ link }) => {
    const token = await folkpathsDriveToken(actor.id);
    if (!token) return null;
    const got = await downloadDriveFile(token, link);
    return got ? Buffer.from(got.base64, "base64") : null;
  });
  const filedBytes = await verify({ fileId: filed.id, link: filed.link }).catch(() => null);
  if (filedBytes && fileHash(filedBytes) !== pdfHash) {
    // Left at ATTESTED with the attempt recorded; filing can be retried, and the retry
    // replaces the file in place rather than adding a second.
    refuse([`The document filed in Drive does not match the one that was rendered (${filedBytes.length} bytes there, ${bytes.length} sent). Nothing has been recorded against it — try filing it again.`], 502);
  }
  const verified = Boolean(filedBytes);

  const done = await db.expenseCertificate.update({
    where: { id },
    data: { status: "UPLOADED" satisfies CertificateState, pdfHash, driveFileId: filed.id, driveUrl: filed.link, uploadedAt: now() },
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.uploaded", entityType: "ExpenseCertificate", entityId: id,
    detail: { certificateNo: done.certificateNo, driveFileId: filed.id, pdfHash, bytes: bytes.length,
      // Whether the bytes were read back and matched, or Drive would not return them.
      readBackVerified: verified } });
  return done;
}

// ── 4. Link it to the rows ───────────────────────────────────────────────────
//
// One transaction, and the last chance to notice the sheet has moved. The waiver written
// on each row names the certificate, so the row's evidence is only as good as the
// document — withdraw the document later and the row stops counting without anybody
// having to edit it, which matters because the save path refuses to edit a signed-for
// row at all.
//
// Rows are found by `financialIdentity`, the same function the save path uses. Neither
// can decide a row is "the same row" that the other would not.

export async function linkCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const linked = await db.$transaction(async (tx) => {
    const cert = await tx.expenseCertificate.findUnique({ where: { id } });
    if (!cert) refuse(["No such certificate"], 404);
    const bad = moveRefusal(cert!.status as CertificateState, "LINKED");
    if (bad) refuse([bad]);
    if (!cert!.driveFileId || !cert!.pdfHash) refuse(["This certificate has not been filed in Drive yet, so there is no document for the rows to point at."]);

    const sheet = await tx.jobSheet.findUnique({ where: { id: cert!.jobSheetId } });
    if (!sheet) refuse(["The job sheet this certificate belongs to is gone"], 404);
    const expenses = (sheet!.expenses as unknown as Expense[]) ?? [];
    const name = await guideNameOf(tx, sheet!.guideId);
    const drift = checkDrift(
      { payloadHash: cert!.payloadHash, coveredRows: cert!.coveredRows as unknown as CertifiableRow[] },
      { facts: facts(sheet!, name), expenses },
    );
    if (drift.drifted) refuse(["This job sheet has changed since the certificate was approved:", ...drift.reasons, "Withdraw this certificate and issue a new one — the document is never edited."]);

    const covered = cert!.coveredRows as unknown as CertifiableRow[];
    const waiver: EvidenceWaiver = {
      by: actor.id, at: now().toISOString(),
      reason: `ใบรับรองแทนใบเสร็จเลขที่ ${cert!.certificateNo} — ${(cert!.payload as unknown as CertificatePayload).reason}`,
      certificateId: cert!.id, certificateNo: cert!.certificateNo,
    };
    // Matched on what the row says. A duplicate would make "which row" unanswerable, and
    // eligibility() has already refused that case — this re-checks rather than assuming.
    const byIdentity = new Map<string, number[]>();
    expenses.forEach((e, i) => {
      const key = financialIdentity(e as ProtectedRow);
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), i]);
    });
    const next = expenses.map((e) => ({ ...e })) as (Expense & { evidenceWaiver?: EvidenceWaiver })[];
    for (const row of covered) {
      const at = byIdentity.get(row.identity) ?? [];
      if (at.length !== 1) refuse([`"${row.description}" matches ${at.length} rows on this job sheet, so the certificate cannot say which one it covers.`]);
      next[at[0]].evidenceWaiver = waiver;
    }
    await tx.jobSheet.update({ where: { id: sheet!.id }, data: { expenses: next as unknown as Prisma.InputJsonValue } });
    return tx.expenseCertificate.update({ where: { id, status: cert!.status }, data: { status: "LINKED" satisfies CertificateState, linkedAt: now() } });
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.linked", entityType: "ExpenseCertificate", entityId: id,
    detail: { certificateNo: linked.certificateNo, jobRef: linked.jobRef, rows: (linked.coveredRows as unknown as CertifiableRow[]).length, totalSatang: linked.totalSatang, pdfHash: linked.pdfHash, driveFileId: linked.driveFileId } });
  return linked;
}

// ── 5. Withdraw it ───────────────────────────────────────────────────────────
//
// The rows keep their waiver, and the waiver keeps naming this certificate — so they
// stop counting as evidenced the moment this row says VOID, without editing a single
// expense row. Clearing activeJobSheetId frees the sheet for a replacement.

export async function voidCertificate(id: string, reason: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  if ((reason ?? "").trim().length < MIN_VOID_REASON) {
    refuse([`Say why this certificate is being withdrawn — at least ${MIN_VOID_REASON} characters, and it is kept with the document.`], 400);
  }
  const voided = await db.$transaction(async (tx) => {
    const cert = await tx.expenseCertificate.findUnique({ where: { id } });
    if (!cert) refuse(["No such certificate"], 404);
    if (!canMove(cert!.status as CertificateState, "VOID")) refuse([moveRefusal(cert!.status as CertificateState, "VOID") ?? "refused"]);
    return tx.expenseCertificate.update({
      where: { id, status: cert!.status },
      data: { status: "VOID" satisfies CertificateState, activeJobSheetId: null, voidedAt: now(), voidedById: actor.id, voidReason: reason.trim() },
    });
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.voided", entityType: "ExpenseCertificate", entityId: id,
    detail: { certificateNo: voided.certificateNo, jobRef: voided.jobRef, reason: reason.trim(), wasLinked: Boolean(voided.linkedAt),
      note: "the rows keep their waiver; it names this certificate, and a withdrawn certificate is not evidence" } });
  return voided;
}
