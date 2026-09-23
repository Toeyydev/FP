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
import { folkpathsDriveToken } from "@/lib/google-drive";
import { certificateEnvironment, DuplicateCertificateFile, googleCertificateDrive, type CertificateDrive } from "@/lib/certificates/drive";

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
  /** Where certificate files live. Supplied by tests; built from the session otherwise. */
  drive?: CertificateDrive;
  /** Which deployment is filing. Part of a file's marker, so environments never collide. */
  environment?: string;
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

/** How long a claim on an upload is believed before it is treated as abandoned. */
export const UPLOAD_CLAIM_MS = 5 * 60_000;

export async function uploadCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const render = deps.renderPdf ?? defaultRenderPdf;
  const environment = deps.environment ?? certificateEnvironment();

  const cert = await db.expenseCertificate.findUnique({ where: { id } });
  if (!cert) refuse(["No such certificate"], 404);
  if (cert!.status !== "ATTESTED" && cert!.status !== "UPLOADED") refuse([moveRefusal(cert!.status as CertificateState, "UPLOADED") ?? "This certificate has not been attested yet."]);
  if (!deps.drive && !pdfRendererAvailable() && !deps.renderPdf) {
    refuse(["This deployment has no PDF renderer configured, so the certificate cannot be filed. The attestation is recorded and filing can be retried once it is."], 503);
  }

  // The claim, in the database, before anything reaches Drive. Two people pressing at
  // once both read the same row above; only one of them matches this WHERE, so only one
  // uploads. A filename could not do this — Drive lets two files share one, which is the
  // whole reason this workflow does not key on names.
  const stale = new Date(now().getTime() - UPLOAD_CLAIM_MS);
  const claimed = await db.expenseCertificate.updateMany({
    where: { id, status: cert!.status, OR: [{ uploadStartedAt: null }, { uploadStartedAt: { lt: stale } }] },
    data: { uploadStartedAt: now(), uploadAttempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    refuse(["This certificate is already being filed. Give it a moment and reload — filing twice would put two documents in Drive for one certificate."], 409);
  }

  const release = async (error: string | null) => {
    await db.expenseCertificate.updateMany({ where: { id }, data: { uploadStartedAt: null, lastUploadError: error } }).catch(() => {});
  };

  try {
    const payload = cert!.payload as unknown as CertificatePayload;
    const html = renderCertificateHtml({
      certificateNo: cert!.certificateNo, payload, payloadHash: cert!.payloadHash,
      attestedByName: cert!.attestedByName ?? "", attestedByRole: cert!.attestedByRole ?? "",
      attestedAt: (cert!.attestedAt ?? new Date(0)).toISOString(), auditRef: cert!.id,
    });
    const bytes = await render(html);
    const pdfHash = fileHash(bytes);
    const name = certificateFileName(cert!.certificateNo);
    const folderPath = certificateFolder(cert!.tourDate);

    let drive = deps.drive;
    if (!drive) {
      const token = await folkpathsDriveToken(actor.id);
      if (!token) refuse(["Google Drive is not connected, so the certificate cannot be filed. The attestation is recorded and filing can be retried."], 503);
      drive = googleCertificateDrive(token!);
    }

    // Found by the marker on the file, never by its name — so a retry after a failed
    // database write resumes the file that is already there.
    let filed;
    try {
      filed = await drive.put({ certificateId: cert!.id, certificateNo: cert!.certificateNo, payloadHash: cert!.payloadHash, environment, name, bytes, folderPath });
    } catch (err) {
      if (err instanceof DuplicateCertificateFile) {
        await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_duplicate", entityType: "ExpenseCertificate", entityId: id,
          detail: { certificateNo: cert!.certificateNo, environment, fileCount: err.fileIds.length, fileIds: err.fileIds } });
        refuse([`Drive holds ${err.fileIds.length} files for this certificate. Filing cannot choose between them — have someone remove the wrong one before trying again.`], 409);
      }
      throw err;
    }

    // Hash what is actually there, not what was sent.
    const filedBytes = await drive.read({ fileId: filed.id }).catch(() => null);
    if (filedBytes && fileHash(filedBytes) !== pdfHash) {
      // Not left sitting in the folder looking like the document. Moved aside, marked,
      // and its marker cleared so the next attempt does not find and update it.
      await drive.quarantine({ fileId: filed.id, reason: `read-back hash did not match (${filedBytes.length} bytes filed, ${bytes.length} sent)`, folderPath }).catch(() => {});
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_quarantined", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, driveFileId: filed.id, expectedBytes: bytes.length, filedBytes: filedBytes.length, environment } });
      refuse(["The document filed in Drive did not match the one that was rendered. It has been moved to Quarantine and nothing was recorded against it — try filing again."], 502);
    }

    const done = await db.expenseCertificate.update({
      where: { id },
      data: {
        status: "UPLOADED" satisfies CertificateState, pdfHash, driveFileId: filed.id, driveUrl: filed.link,
        uploadedAt: now(), uploadStartedAt: null, lastUploadError: null, driveEnvironment: environment,
      },
    });
    await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.uploaded", entityType: "ExpenseCertificate", entityId: id,
      detail: { certificateNo: done.certificateNo, driveFileId: filed.id, pdfHash, bytes: bytes.length, environment,
        readBackVerified: Boolean(filedBytes), attempt: done.uploadAttempts,
        resumed: cert!.uploadAttempts > 0 ? "an earlier attempt had already put a file there; this replaced its bytes rather than adding a second" : undefined } });
    return done;
  } catch (err) {
    if (!(err instanceof CertificateRefused)) await release(String(err).slice(0, 300));
    else await release(err.reasons[0]?.slice(0, 300) ?? null);
    throw err;
  }
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
