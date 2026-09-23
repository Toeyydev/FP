import { randomUUID } from "node:crypto";
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
  /** Lease length and heartbeat, so a test can make a lease expire without waiting. */
  leaseMs?: number;
  heartbeatMs?: number;
  newToken?: () => string;
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

/** How long an upload lease is believed before somebody else may take it. */
export const UPLOAD_LEASE_MS = 60_000;
/** How often the holder tells the database it is still working. */
export const UPLOAD_HEARTBEAT_MS = 15_000;

/** Raised when this request no longer owns the upload it started. */
export class UploadFenced extends Error {
  constructor(public at: string) {
    super(`upload lease lost before ${at}`);
    this.name = "UploadFenced";
  }
}

/**
 * Filing the document: one file per attempt, and the winner never written again.
 *
 * The lease says who may proceed. It cannot say who may write, because a call to Drive
 * that has already left cannot be recalled — an attempt fenced out mid-flight can still
 * have its bytes land afterwards, including after the document has been linked and is
 * standing in for a receipt.
 *
 * So no two attempts ever share a file. Each writes its own, marked TEMP and carrying
 * its own token, and may only ever touch a file with that token on it. The database then
 * picks a winner under the fencing token, that one file is promoted to ACTIVE, and every
 * other candidate is moved to QUARANTINED. A late write from a fenced attempt lands in
 * its own losing file, where it belongs.
 */
export async function uploadCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const render = deps.renderPdf ?? defaultRenderPdf;
  const environment = deps.environment ?? certificateEnvironment();
  const leaseMs = deps.leaseMs ?? UPLOAD_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? UPLOAD_HEARTBEAT_MS;

  const cert = await db.expenseCertificate.findUnique({ where: { id } });
  if (!cert) refuse(["No such certificate"], 404);
  if (!["ATTESTED", "UPLOADED", "STALE"].includes(cert!.status)) refuse([moveRefusal(cert!.status as CertificateState, "UPLOADED") ?? "This certificate has not been attested yet."]);
  if (!deps.drive && !pdfRendererAvailable() && !deps.renderPdf) {
    refuse(["This deployment has no PDF renderer configured, so the certificate cannot be filed. The attestation is recorded and filing can be retried once it is."], 503);
  }

  // A new token on every claim and reclaim. This is what makes a previous holder's
  // writes fail, and what keeps its file separate from this one's.
  const token = deps.newToken ? deps.newToken() : randomUUID();
  const until = () => new Date(now().getTime() + leaseMs);
  const claimed = await db.expenseCertificate.updateMany({
    where: { id, status: cert!.status, OR: [{ uploadClaimToken: null }, { uploadLeaseUntil: null }, { uploadLeaseUntil: { lt: now() } }] },
    data: { uploadClaimToken: token, uploadLeaseUntil: until(), uploadStartedAt: now(), uploadAttempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    refuse(["This certificate is already being filed. Give it a moment and reload — filing twice would put two documents in Drive for one certificate."], 409);
  }

  const renew = async (): Promise<boolean> =>
    (await db.expenseCertificate.updateMany({ where: { id, uploadClaimToken: token }, data: { uploadLeaseUntil: until() } })).count === 1;
  const hold = async (at: string): Promise<void> => { if (!(await renew())) throw new UploadFenced(at); };

  const beat = setInterval(() => { void renew().catch(() => {}); }, heartbeatMs);
  (beat as unknown as { unref?: () => void }).unref?.();

  const folderPath = certificateFolder(cert!.tourDate);
  let drive = deps.drive;
  let mine: { id: string; temp: string } | null = null;

  /** Put this attempt's own files out of the way. Never anybody else's. */
  const quarantineMine = async (reason: string) => {
    if (!mine || !drive) return;
    for (const fileId of new Set([mine.id, mine.temp])) {
      await drive.quarantine({ fileId, reason, certificateId: cert!.id, attemptToken: token, at: now().toISOString() }).catch(() => {});
    }
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

    if (!drive) {
      const dToken = await folkpathsDriveToken(actor.id);
      if (!dToken) refuse(["Google Drive is not connected, so the certificate cannot be filed. The attestation is recorded and filing can be retried."], 503);
      drive = googleCertificateDrive(dToken!);
    }

    await hold("writing this attempt's candidate");

    // This attempt's own TEMP file. A retry under the SAME token reuses it; a retry
    // under a new token makes a new one and leaves every other file alone.
    let temp;
    try {
      temp = await drive.putAttempt({ certificateId: cert!.id, certificateNo: cert!.certificateNo, payloadHash: cert!.payloadHash, environment, attemptToken: token, name, bytes, folderPath });
    } catch (err) {
      if (err instanceof DuplicateCertificateFile) {
        await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_duplicate", entityType: "ExpenseCertificate", entityId: id,
          detail: { certificateNo: cert!.certificateNo, environment, state: err.state, fileCount: err.fileIds.length, fileIds: err.fileIds } });
        refuse([`Drive holds ${err.fileIds.length} ${err.state} files for this attempt. Filing cannot choose between them — have someone remove the wrong one before trying again.`], 409);
      }
      throw err;
    }
    mine = { id: temp.id, temp: temp.id };

    // Hash what is in the candidate, not what was sent to it.
    const tempBytes = await drive.read({ fileId: temp.id }).catch(() => null);
    if (!tempBytes || fileHash(tempBytes) !== pdfHash) {
      await quarantineMine(`read-back hash did not match (${tempBytes?.length ?? "unreadable"} bytes filed, ${bytes.length} sent)`);
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_quarantined", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, driveFileId: temp.id, attemptToken: token, environment,
          expectedPdfHash: pdfHash, actualPdfHash: tempBytes ? fileHash(tempBytes) : null, expectedBytes: bytes.length, filedBytes: tempBytes?.length ?? null } });
      refuse(["The document filed in Drive did not match the one that was rendered. It has been moved to Quarantine and nothing was recorded against it — try filing again."], 502);
    }

    await hold("creating the document");

    // The document is a NEW file, written from the bytes that were just read back and
    // checked. It is not the candidate promoted in place: a media upload aimed at the
    // candidate could still be in the air, and arriving after a promotion it would
    // rewrite the document. Nothing has ever held this file id.
    //
    // Idempotent on the attempt token, so a crash between creating it and recording it
    // finds the one that exists rather than making a second.
    const existing = await drive.findActiveByAttempt({ certificateId: cert!.id, environment, attemptToken: token, folderPath });
    if (existing.length > 1) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_duplicate", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, environment, state: "ACTIVE", fileCount: existing.length, fileIds: existing.map((f) => f.id) } });
      refuse([`Drive holds ${existing.length} documents for this attempt, so which one it means is unanswerable. Have someone remove the wrong one before trying again.`], 409);
    }
    const reused = existing[0] ?? null;
    const active = reused ?? await drive.createActive({
      certificateId: cert!.id, certificateNo: cert!.certificateNo, payloadHash: cert!.payloadHash,
      environment, attemptToken: token, name, bytes: tempBytes!, folderPath,
    });
    mine = { id: active.id, temp: temp.id };

    // A document found from an earlier attempt of this same token is not taken on trust
    // because the query that found it said the right things. Everything is asked of the
    // file itself, and anything that does not line up stops here rather than being
    // resolved by picking.
    if (reused) {
      const wrong: string[] = [];
      if (reused.state !== "ACTIVE") wrong.push("it is not the settled document");
      if (reused.attemptToken !== token) wrong.push("it belongs to a different attempt");
      if (cert!.driveFileId && cert!.driveFileId !== reused.id) wrong.push("the certificate already names a different document");
      if (cert!.driveRevisionId && reused.revisionId && reused.revisionId !== cert!.driveRevisionId) wrong.push("its revision has moved since it was recorded");
      if (wrong.length) {
        await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_candidate_rejected", entityType: "ExpenseCertificate", entityId: id,
          detail: { certificateNo: cert!.certificateNo, environment, attemptToken: token, foundFileId: reused.id, foundState: reused.state, problems: wrong } });
        refuse([`A document from an earlier attempt was found but cannot be used: ${wrong.join("; ")}. Have someone look at the folder before filing again.`], 409);
      }
    }

    // The document is downloaded and hashed before anything is recorded against it —
    // whether it was just created or found from an earlier attempt.
    const activeBytes = await drive.read({ fileId: active.id }).catch(() => null);
    if (!activeBytes || fileHash(activeBytes) !== pdfHash || (active.attemptToken && active.attemptToken !== token)) {
      await drive.quarantine({ fileId: active.id, reason: "the created document did not read back as the bytes it was created from", certificateId: cert!.id, attemptToken: token, at: now().toISOString() }).catch(() => {});
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_quarantined", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, driveFileId: active.id, attemptToken: token, environment, stage: "ACTIVE",
          expectedPdfHash: pdfHash, actualPdfHash: activeBytes ? fileHash(activeBytes) : null } });
      refuse(["The document created in Drive did not read back as what it was created from. It has been moved to Quarantine and nothing was recorded against it — try filing again."], 502);
    }

    // Only now does the database point at anything. Until this write, no row names this
    // file, so a crash before it leaves a document nobody relies on.
    const wrote = await db.expenseCertificate.updateMany({
      where: { id, uploadClaimToken: token },
      data: {
        status: "UPLOADED" satisfies CertificateState, pdfHash, driveFileId: active.id, driveUrl: active.link,
        uploadedAt: now(), uploadStartedAt: null, uploadClaimToken: null, uploadLeaseUntil: null,
        lastUploadError: null, driveEnvironment: environment, driveAttemptToken: token,
        driveRevisionId: active.revisionId ?? null, driveMd5: active.md5 ?? null,
      },
    });
    if (wrote.count === 0) throw new UploadFenced("recording the created document");

    // Won. The candidate has done its job and is kept as the trail; every other file for
    // this certificate — including a document this certificate settled on before — is
    // put away, so exactly one ACTIVE remains.
    await drive.retire({ fileId: temp.id, certificateId: cert!.id, attemptToken: token, at: now().toISOString(), reason: `bytes became document ${active.id}` }).catch(() => {});
    const others = (await drive.findAll({ certificateId: cert!.id, environment, folderPath })).filter((f) => f.id !== active.id);
    for (const f of others) {
      await drive.quarantine({ fileId: f.id, reason: `superseded by attempt ${token}`, certificateId: cert!.id, attemptToken: f.attemptToken ?? "", at: now().toISOString() }).catch(() => {});
    }

    const done = (await db.expenseCertificate.findUnique({ where: { id } }))!;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.uploaded", entityType: "ExpenseCertificate", entityId: id,
      detail: { certificateNo: done.certificateNo, driveFileId: active.id, retiredTempFileId: temp.id, pdfHash, bytes: bytes.length, environment,
        readBackVerified: true, attempt: done.uploadAttempts, attemptToken: token,
        revisionId: active.revisionId ?? null, readOnly: active.readOnly ?? false,
        reusedExistingDocument: Boolean(existing[0]) || undefined,
        supersededFiles: others.length ? others.map((f) => f.id) : undefined } });
    return done;
  } catch (err) {
    if (err instanceof UploadFenced) {
      // This attempt's own candidate is put away; nothing else is touched. Not the row,
      // not the winner's file, and above all not the new owner's claim.
      await quarantineMine(`attempt ${token} was fenced out before ${err.at}`);
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.upload_fenced", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, attemptToken: token, lostBefore: err.at, environment, quarantinedFileId: mine?.id ?? null,
          note: "this request's lease was taken over while it was working; its candidate was quarantined and nothing else changed" } });
      refuse(["Another request took over filing this certificate while this one was working, so nothing was changed. Reload to see where it got to."], 409);
    }
    const message = err instanceof CertificateRefused ? err.reasons[0]?.slice(0, 300) ?? null : String(err).slice(0, 300);
    await db.expenseCertificate.updateMany({ where: { id, uploadClaimToken: token }, data: { uploadStartedAt: null, uploadClaimToken: null, uploadLeaseUntil: null, lastUploadError: message } }).catch(() => {});
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/**
 * Is the document in Drive still the document that was checked?
 *
 * Asked before a certificate is relied on — at linking, and again at the point money
 * moves. Everything it looks at is a fact about the file as it is now: exactly one
 * ACTIVE file, the attempt on record, and bytes that hash to what was recorded.
 */
export type DocumentCheck = { ok: boolean; reasons: string[]; action?: "drive_overwritten" | "drive_changed" | "drive_missing" | "drive_duplicate" };

export async function checkFiledDocument(cert: ExpenseCertificate, deps: Deps = {}, actorId?: string): Promise<DocumentCheck> {
  const environment = deps.environment ?? cert.driveEnvironment ?? certificateEnvironment();
  const folderPath = certificateFolder(cert.tourDate);
  let drive = deps.drive;
  if (!drive) {
    const t = await folkpathsDriveToken(actorId);
    if (!t) return { ok: false, reasons: ["Google Drive is not connected, so the filed document cannot be checked."] };
    drive = googleCertificateDrive(t);
  }
  const active = await drive.findActive({ certificateId: cert.id, environment, folderPath });
  if (active.length === 0) {
    return { ok: false, action: "drive_missing", reasons: ["The document is no longer in Drive where it was filed. File it again before relying on it."] };
  }
  if (active.length > 1) {
    return { ok: false, action: "drive_duplicate", reasons: [`Drive holds ${active.length} settled documents for this certificate, so which one it means is unanswerable. Have someone remove the wrong one, then file it again.`] };
  }
  const file = active[0];
  if (file.id !== cert.driveFileId || (cert.driveAttemptToken && file.attemptToken && file.attemptToken !== cert.driveAttemptToken)) {
    return { ok: false, action: "drive_overwritten", reasons: ["The document in Drive was written by a different attempt than the one on record, so what is filed there is not what was checked. File it again before relying on it."] };
  }
  if (cert.driveRevisionId && file.revisionId && file.revisionId !== cert.driveRevisionId) {
    return { ok: false, action: "drive_changed", reasons: ["The document in Drive has been edited since it was filed. File it again before relying on it."] };
  }
  const bytes = await drive.read({ fileId: file.id }).catch(() => null);
  if (bytes && cert.pdfHash && fileHash(bytes) !== cert.pdfHash) {
    return { ok: false, action: "drive_changed", reasons: ["The document in Drive is not the one that was filed — its contents have changed since. File it again before relying on it."] };
  }
  return { ok: true, reasons: [] };
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

    // The document is checked here, not taken on trust from the upload step — this is
    // the last moment before it starts standing in for a receipt.
    const check = await checkFiledDocument(cert!, deps, actor.id);
    if (!check.ok) {
      if (check.action) {
        await audit({ actorId: actor.id, actorRole: actor.role, action: `certificate.${check.action}`, entityType: "ExpenseCertificate", entityId: id,
          detail: { certificateNo: cert!.certificateNo, driveFileId: cert!.driveFileId, expectedAttempt: cert!.driveAttemptToken, expectedPdfHash: cert!.pdfHash, reasons: check.reasons } });
      }
      refuse(check.reasons, 409);
    }

    const sheet = await tx.jobSheet.findUnique({ where: { id: cert!.jobSheetId } });
    if (!sheet) refuse(["The job sheet this certificate belongs to is gone"], 404);
    const expenses = (sheet!.expenses as unknown as Expense[]) ?? [];
    const name = await guideNameOf(tx, sheet!.guideId);
    const drift = checkDrift(
      { payloadHash: cert!.payloadHash, coveredRows: cert!.coveredRows as unknown as CertifiableRow[] },
      { facts: facts(sheet!, name), expenses },
    );
    if (drift.drifted) refuse(["This job sheet has changed since the certificate was attested:", ...drift.reasons, "Withdraw this certificate and issue a new one — the document is never edited."]);

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
