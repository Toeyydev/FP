import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, ExpenseCertificate, JobSheet } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Expense } from "@/lib/jobsheet";
import { financialIdentity, type ProtectedRow } from "@/lib/protected-expense-fields";
import { type EvidenceWaiver } from "@/lib/reimbursement-evidence";
import { buildPayload, certifiableRows, checkDrift, duplicateIdentities, fileHash, ineligibleRows, payloadHash, type CertifiableRow, type CertificatePayload, type SheetFacts } from "@/lib/certificates/payload";
import { renderCertificateHtml } from "@/lib/certificates/document";
import { certificateFileName, pdfRendererAvailable, renderPdf as defaultRenderPdf, type RenderPdf } from "@/lib/certificates/pdf";
import { certificateFolder, folderPathOf, folderPathString, folderPermissionProblems, permissionProblems } from "@/lib/certificates/access";
import { allowedHolders, CONFIG_INVALID_EN, CONFIG_INVALID_TH, sanitisedConfigAudit, validateDriveAllowlist, type AllowlistResult } from "@/lib/certificates/drive-allowlist";
import { canMove, MIN_VOID_REASON, moveRefusal, type CertificateState } from "@/lib/certificates/state";
import { folkpathsDriveToken } from "@/lib/google-drive";
import { certificateEnvironment, DuplicateCertificateFile, googleCertificateDrive, type CertificateDrive } from "@/lib/certificates/drive";
import { blocksDocument, registeredSignature, resolveSignature, stampOf, type SignatureDeps, type SignatureStamp } from "@/lib/certificates/signature";
import { attesterRefusal } from "@/lib/certificates/attester";
import { defaultSource, sourceRefusal, type ExpenseSource } from "@/lib/certificates/source";

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
  /** Where the attester's signature image comes from. Supplied by tests; Drive otherwise. */
  signature?: SignatureDeps;
};

export type Actor = { id: string; name: string; role: string };

export class CertificateRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "CertificateRefused";
  }
}

// A function declaration rather than a const arrow, so TypeScript narrows after it.
function refuse(reasons: string[], status = 409): never { throw new CertificateRefused(reasons, status); }

function facts(sheet: JobSheet, guideName: string): SheetFacts {
  return {
    jobRef: sheet.ref, tourDate: sheet.date, slotIdx: sheet.slotIdx,
    guideId: sheet.guideId, guideName,
    guideReportedAt: sheet.guideExpensesAt ?? null,
  };
}

/**
 * Is this folder, and this file, private to the admins?
 *
 * Asked of Drive rather than of our own record of Drive. The folder is asked about as
 * well as the file, because a file inherits whatever the folder above it was shared
 * with, and a file that was never shared with anybody sitting in a folder the guides can
 * open is not private in any sense that matters.
 *
 * Everything it cannot determine is a problem. There is no path through this that turns
 * a failed lookup into a pass.
 */
async function privacyProblems(drive: CertificateDrive, folderPath: string[], fileId: string | null, list: Extract<AllowlistResult, { ok: true }>): Promise<string[]> {
  const account = await drive.accountEmail().catch(() => null);
  if (!account) {
    return ["Which Google account files these documents could not be read, so who can see them cannot be checked."];
  }
  const allowed = allowedHolders(account, list);
  const out: string[] = [];

  const folderId = await drive.folderId({ folderPath }).catch(() => null);
  if (!folderId) {
    out.push(`The folder ${folderPathString(folderPath)} could not be found in Drive, so who can see it cannot be checked.`);
  } else {
    out.push(...folderPermissionProblems(await drive.permissions({ fileId: folderId }).catch(() => null), allowed, folderPath));
  }

  if (fileId) out.push(...permissionProblems(await drive.permissions({ fileId }).catch(() => null), allowed));
  return out;
}

/** Everything that must be true before a certificate may exist for this sheet. */
/** The origin a certificate was issued under, read back from what it stored. */
/**
 * The sheet as this document describes it.
 *
 * For an admin-recorded certificate the guide-report fact is the one it was ISSUED with,
 * not the one the sheet carries now — the document never claimed anything about a report
 * that arrived later, and reading today's value here would silently reword it.
 */
function factsFor(cert: ExpenseCertificate, sheet: JobSheet, guideName: string): SheetFacts {
  const base = facts(sheet, guideName);
  return (cert.source as ExpenseSource) === "ADMIN_RECORDED"
    ? { ...base, guideReportedAt: cert.sourceGuideReportedAt }
    : base;
}

function originOf(cert: ExpenseCertificate): { source: ExpenseSource; recordedBy: CertificatePayload["recordedBy"]; guideReportedAt: string | null } {
  return {
    source: (cert.source as ExpenseSource) ?? "GUIDE_REPORTED",
    recordedBy: cert.recordedById
      ? { id: cert.recordedById, name: cert.recordedByName ?? "", role: cert.recordedByRole ?? "", at: (cert.recordedAt ?? new Date(0)).toISOString() }
      : null,
    // What was true when it was issued, so an admin-recorded document is compared with
    // the world it was issued into rather than with today's.
    guideReportedAt: cert.sourceGuideReportedAt ? cert.sourceGuideReportedAt.toISOString() : null,
  };
}

function eligibility(sheet: JobSheet, rows: CertifiableRow[], source: ExpenseSource = "GUIDE_REPORTED"): string[] {
  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const out: string[] = [];
  // Only a GUIDE_REPORTED document needs the guide to have filed — that claim cannot be
  // made on their behalf. An ADMIN_RECORDED one exists precisely for the case where they
  // did not: the expenses still happened and the company still has to account for them.
  // Not certifiedAt in either case — that is the operator's first save and says nothing
  // about the guide (lib/certifier).
  if (source === "GUIDE_REPORTED" && !sheet.guideExpensesAt) {
    out.push("This job sheet has no expense report from the guide. A certificate that says the guide reported these expenses cannot be issued until they have — record the rows as an admin instead if that is what happened.");
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

export async function createCertificate(
  key: { guideId: string; date: string; slotIdx: number },
  actor: Actor,
  deps: Deps = {},
  /** Where the rows came from. Decided here, once, and never edited afterwards. */
  source?: ExpenseSource,
): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const made = await db.$transaction(async (tx) => {
    const sheet = await loadSheet(tx, key);
    // No source given and no guide report: REFUSE rather than default.
    //
    // Defaulting here would name whoever made the call as the person who entered the
    // figures, on the strength of a missing field. A claim about somebody should never
    // be the consequence of an omission — a caller that has not said where the rows came
    // from has not decided, and deciding for them is how a script or an old client ends
    // up putting an admin's name on a document nobody meant to issue.
    //
    // The screen always sends one, so this is felt only by something that did not.
    const chosen: ExpenseSource | undefined = source ?? (sheet.guideExpensesAt ? "GUIDE_REPORTED" : undefined);
    if (!chosen) {
      refuse([
        "This job sheet has no expense report from the guide, so a certificate cannot simply be issued: say where the rows came from.",
        "ไกด์ไม่ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตนสำหรับใบงานนี้ — ให้เลือกที่มาของรายการก่อนออกใบรับรอง",
      ]);
    }
    const badSource = sourceRefusal(chosen, sheet);
    if (badSource) refuse([badSource]);
    const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
    const rows = certifiableRows(expenses);
    const problems = eligibility(sheet, rows, chosen);
    if (problems.length) refuse(problems);

    const existing = await tx.expenseCertificate.findUnique({ where: { activeJobSheetId: sheet.id } });
    if (existing) refuse([`This job sheet already has certificate ${existing.certificateNo}. Withdraw it first, with a reason, if it needs replacing.`]);

    const name = await guideNameOf(tx, sheet.guideId);
    // An admin recording rows is an act by a named person at a known time, so it is
    // stamped now rather than at attestation — the two are different events even when
    // the same person performs both, and an audit that merged them could not answer
    // which one is being questioned.
    const recordedBy = chosen === "ADMIN_RECORDED"
      ? { id: actor.id, name: actor.name, role: actor.role, at: now().toISOString() }
      : null;
    const payload = buildPayload(facts(sheet, name), rows, null, { source: chosen, recordedBy });
    const issued = await tx.expenseCertificate.count({ where: { jobSheetId: sheet.id } });
    const certificateNo = `CERT-${sheet.ref ?? `${sheet.date}-${sheet.slotIdx}`}-${String(issued + 1).padStart(2, "0")}`;

    return tx.expenseCertificate.create({
      data: {
        certificateNo, jobSheetId: sheet.id, activeJobSheetId: sheet.id,
        source: chosen,
        ...(recordedBy ? { recordedById: recordedBy.id, recordedByName: recordedBy.name, recordedByRole: recordedBy.role, recordedAt: new Date(recordedBy.at) } : {}),
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
    detail: { certificateNo: made.certificateNo, jobRef: made.jobRef, rows: (made.coveredRows as unknown as CertifiableRow[]).length, totalSatang: made.totalSatang, payloadHash: made.payloadHash, source: made.source } });

  // Recording the rows is its own event, written separately even when the same person
  // goes on to attest. Merging them would leave an audit that cannot say whether what is
  // being questioned is the figures or the certification of them.
  if (made.source === "ADMIN_RECORDED") {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.rows_recorded_by_admin", entityType: "ExpenseCertificate", entityId: made.id,
      detail: {
        certificateNo: made.certificateNo, jobRef: made.jobRef,
        jobSheet: { guideId: made.guideId, date: made.tourDate, slotIdx: made.slotIdx },
        recordedById: made.recordedById, recordedByName: made.recordedByName, recordedByRole: made.recordedByRole,
        recordedAt: made.recordedAt?.toISOString() ?? null,
        rows: (made.coveredRows as unknown as CertifiableRow[]).map((r) => ({ index: r.index, description: r.description, amountSatang: r.amountSatang })),
        totalSatang: made.totalSatang,
        note: "the guide did not file an expense report from their own account for this job; an admin entered these rows from information they checked. This is not a report by the guide and not a certification of the document.",
      } });
  }
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

  // May this person certify at all?
  //
  // Checked here and not only at the route, because this is the function that puts a
  // name on a document and a route is one of several ways to reach it. The address comes
  // from the database rather than from the session, so a session that carries a stale or
  // edited email cannot widen it.
  //
  // This narrows ADMIN; it is not segregation of duties and must not become it. The same
  // authorised person may prepare and attest the same certificate.
  const me = actor.id ? await db.user.findUnique({ where: { id: actor.id }, select: { email: true, role: true } }) : null;
  const notAllowed = attesterRefusal({ role: me?.role ?? actor.role, email: me?.email });
  if (notAllowed) refuse([notAllowed], 403);

  // The attester's own signature image, and nobody else's: the id comes from `actor`,
  // which every caller builds from the session. Resolved out here because it fetches from
  // Drive, and a transaction held open across a network call is a transaction held open
  // for as long as somebody else's server feels like taking.
  //
  // Having none is not a failure — the document is complete without a picture. Every other
  // refusal stops the attestation, because each one means what is on file is not what was
  // approved, and a document is not the place to find that out.
  const resolved = await resolveSignature(actor.id, { db, ...(deps.signature ?? {}) }, actor.id);
  if (!resolved.ok && blocksDocument(resolved.code)) refuse(resolved.reasons);
  const stamp: SignatureStamp | null = resolved.ok ? stampOf(resolved.signature) : null;

  const signed = await db.$transaction(async (tx) => {
    const cert = await tx.expenseCertificate.findUnique({ where: { id } });
    if (!cert) refuse(["No such certificate"], 404);
    const bad = moveRefusal(cert!.status as CertificateState, "ATTESTED");
    if (bad) refuse([bad]);

    const sheet = await tx.jobSheet.findUnique({ where: { id: cert!.jobSheetId } });
    if (!sheet) refuse(["The job sheet this certificate belongs to is gone"], 404);
    const expenses = (sheet!.expenses as unknown as Expense[]) ?? [];
    const rows = certifiableRows(expenses);
    const problems = eligibility(sheet!, rows, (cert!.source as ExpenseSource) ?? "GUIDE_REPORTED");
    if (problems.length) refuse(problems);

    const name = await guideNameOf(tx, sheet!.guideId);
    const drift = checkDrift(
      { payloadHash: cert!.payloadHash, coveredRows: cert!.coveredRows as unknown as CertifiableRow[],
        signature: (cert!.payload as unknown as CertificatePayload).signature ?? null,
        origin: originOf(cert!) },
      { facts: factsFor(cert!, sheet!, name), expenses },
    );
    if (drift.drifted) {
      refuse(["This job sheet has changed since the certificate was prepared, so it no longer describes the sheet:", ...drift.reasons, "Withdraw this certificate and issue a new one."]);
    }

    // Read again, in the transaction, against the version that was fetched. Closes the
    // gap the Drive call opened: a signature replaced in between would otherwise be
    // stamped as the one that was checked.
    if (stamp) {
      const live = await registeredSignature(actor.id, { db: tx });
      if (!live || live.version !== stamp.version || live.sha256 !== stamp.sha256) {
        refuse(["The signature image registered for you changed while this certificate was being prepared. Try again, so what the document carries is what is on file."]);
      }
    }
    // The amounts on the document have to be the amounts on the sheet.
    const total = rows.reduce((t, r) => t + r.amountSatang, 0);
    if (total !== cert!.totalSatang) refuse([`The total has changed from ${(cert!.totalSatang / 100).toFixed(2)} to ${(total / 100).toFixed(2)}. Withdraw this certificate and issue a new one.`]);

    // The payload is rebuilt so the fingerprint covers which signature was attested with.
    // Swap the image afterwards and the hash no longer matches, which is the whole point
    // of having one.
    // The origin is what it was issued as. Attesting does not get to change who the
    // document says entered the figures.
    const payload = buildPayload(factsFor(cert!, sheet!, name), rows, stamp, originOf(cert!));

    return tx.expenseCertificate.update({
      where: { id, status: cert!.status },
      data: {
        status: "ATTESTED" satisfies CertificateState,
        attestedByUserId: actor.id, attestedByName: actor.name, attestedByRole: actor.role, attestedAt: now(),
        payload: payload as unknown as Prisma.InputJsonValue,
        payloadHash: payloadHash(payload),
        signatureUserId: stamp?.userId ?? null, signatureVersion: stamp?.version ?? null, signatureSha256: stamp?.sha256 ?? null,
        sourceSheetUpdatedAt: sheet!.updatedAt,
        // NOT refreshed. It is the fact the document was issued against, and for an
        // admin-recorded one a guide filing in between changes nothing it claims.
        sourceGuideReportedAt: cert!.sourceGuideReportedAt,
      },
    });
  });
  await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.attested", entityType: "ExpenseCertificate", entityId: signed.id,
    detail: { certificateNo: signed.certificateNo, jobRef: signed.jobRef, totalSatang: signed.totalSatang, payloadHash: signed.payloadHash,
      // Which image, never the image. An audit row is read by people and kept forever.
      signature: stamp ? { userId: stamp.userId, version: stamp.version, sha256: stamp.sha256 } : null,
      signatureNote: stamp
        ? "an image of this person's handwriting, registered to them in advance; it is not a cryptographic signature and proves nothing on its own"
        : "no signature image is registered for this person — the document carries their name, role and time",
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

  // Before the claim and before Drive is touched. Resolving a folder path CREATES the
  // folders it does not find, so a check that ran later would already have changed
  // somebody's Drive on the strength of a configuration it then refused.
  const allowlist = await validateDriveAllowlist(db);
  if (!allowlist.ok) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.config_invalid", entityType: "ExpenseCertificate", entityId: id,
      detail: sanitisedConfigAudit(allowlist) });
    refuse([CONFIG_INVALID_TH, allowlist.reason, ...allowlist.detail]);
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

  // New documents always go to the private folder, whatever an older one did.
  const folderPath = certificateFolder(cert!.tourDate);
  const priorPath = folderPathOf(cert!);
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

    // The image is fetched here, where it goes on the page — not carried across from the
    // attestation, because bytes held in memory across two requests prove nothing about
    // what is on file.
    //
    // The VERSION the certificate recorded, not whatever is live now. Registering a new
    // signature must not reach back and change what somebody already put their name to:
    // a certificate attested in March and filed in June carries March's hand. A retired
    // version is still the right answer — it was live when it was used.
    //
    // What is still checked is that version's bytes: if they have changed in Drive since
    // they were registered, the image on file is not the one that was approved. And at
    // this point "not on file" is a refusal like any other, because the certificate says
    // a signature was attested with, so its absence is a change and not an empty slot.
    let signatureDataUri: string | null = null;
    if (cert!.signatureSha256 && cert!.signatureUserId) {
      const again = await resolveSignature(cert!.signatureUserId, { db, ...(deps.signature ?? {}) }, actor.id, cert!.signatureVersion);
      const release = () => db.expenseCertificate.updateMany({ where: { id, uploadClaimToken: token }, data: { uploadStartedAt: null, uploadClaimToken: null, uploadLeaseUntil: null } }).catch(() => {});
      if (!again.ok) {
        await release();
        refuse([`The signature image this certificate was attested with cannot be used: ${again.reasons[0]}`]);
      } else if (again.signature.version !== cert!.signatureVersion || again.signature.sha256 !== cert!.signatureSha256) {
        // Same version, different bytes: the file was rewritten in place. Nothing in this
        // system does that, which is exactly why it is worth refusing over.
        await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.signature_changed", entityType: "ExpenseCertificate", entityId: id,
          detail: { certificateNo: cert!.certificateNo, signatureUserId: cert!.signatureUserId,
            attestedVersion: cert!.signatureVersion, attestedSha256: cert!.signatureSha256,
            registeredVersion: again.signature.version, registeredSha256: again.signature.sha256 } });
        await release();
        refuse(["The signature image this certificate was attested with is not the one on file under that version any more, so filing it would put a different signature on the document. Withdraw this certificate and issue a new one."]);
      } else {
        signatureDataUri = again.signature.dataUri;
      }
    }

    const html = renderCertificateHtml({
      certificateNo: cert!.certificateNo, payload, payloadHash: cert!.payloadHash,
      attestedByName: cert!.attestedByName ?? "", attestedByRole: cert!.attestedByRole ?? "",
      attestedAt: (cert!.attestedAt ?? new Date(0)).toISOString(), auditRef: cert!.id,
      signatureDataUri, signatureVersion: cert!.signatureVersion,
    });
    const bytes = await render(html);
    const pdfHash = fileHash(bytes);
    const name = certificateFileName(cert!.certificateNo);

    if (!drive) {
      const dToken = await folkpathsDriveToken(actor.id);
      if (!dToken) refuse(["Google Drive is not connected, so the certificate cannot be filed. The attestation is recorded and filing can be retried."], 503);
      drive = googleCertificateDrive(dToken!);
    }

    // Asked before a single byte is written, not after. A document put into a folder the
    // guides can open has already leaked by the time anyone checks it, and moving it
    // afterwards does not unsee it.
    const folderPrivacy = await privacyProblems(drive, folderPath, null, allowlist);
    if (folderPrivacy.length) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_not_private", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, stage: "folder", folder: folderPathString(folderPath), problems: folderPrivacy } });
      await db.expenseCertificate.updateMany({ where: { id, uploadClaimToken: token }, data: { uploadStartedAt: null, uploadClaimToken: null, uploadLeaseUntil: null } }).catch(() => {});
      refuse(["The folder these documents are filed in is not private to the admins, so nothing was filed:", ...folderPrivacy], 409);
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

    // And asked again of the document itself. The folder was private a moment ago; this
    // is the file that will actually be linked, and it is the file's own answer that
    // decides. A document that is not private is quarantined rather than recorded —
    // there is no state in which a readable-by-guides certificate is filed and usable.
    const filePrivacy = await privacyProblems(drive, folderPath, active.id, allowlist);
    if (filePrivacy.length) {
      await drive.quarantine({ fileId: active.id, reason: "the filed document was not private to the admins", certificateId: cert!.id, attemptToken: token, at: now().toISOString() }).catch(() => {});
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.drive_not_private", entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: cert!.certificateNo, stage: "file", driveFileId: active.id, folder: folderPathString(folderPath), problems: filePrivacy } });
      refuse(["The document filed in Drive is not private to the admins, so it has been quarantined and nothing was recorded against it:", ...filePrivacy], 409);
    }

    // Only now does the database point at anything. Until this write, no row names this
    // file, so a crash before it leaves a document nobody relies on.
    const wrote = await db.expenseCertificate.updateMany({
      where: { id, uploadClaimToken: token },
      data: {
        status: "UPLOADED" satisfies CertificateState, pdfHash, driveFileId: active.id, driveUrl: active.link,
        uploadedAt: now(), uploadStartedAt: null, uploadClaimToken: null, uploadLeaseUntil: null,
        lastUploadError: null, driveEnvironment: environment, driveAttemptToken: token,
        driveFolderPath: folderPathString(folderPath),
        driveRevisionId: active.revisionId ?? null, driveMd5: active.md5 ?? null,
      },
    });
    if (wrote.count === 0) throw new UploadFenced("recording the created document");

    // Won. The candidate has done its job and is kept as the trail; every other file for
    // this certificate — including a document this certificate settled on before — is
    // put away, so exactly one ACTIVE remains.
    await drive.retire({ fileId: temp.id, certificateId: cert!.id, attemptToken: token, at: now().toISOString(), reason: `bytes became document ${active.id}` }).catch(() => {});
    // Both folders: a certificate filed before this feature has its document in the old
    // place, and leaving it there would leave two documents answering to one certificate.
    const everywhere = [...await drive.findAll({ certificateId: cert!.id, environment, folderPath })];
    if (folderPathString(priorPath) !== folderPathString(folderPath)) {
      everywhere.push(...await drive.findAll({ certificateId: cert!.id, environment, folderPath: priorPath }).catch(() => []));
    }
    const others = everywhere.filter((f) => f.id !== active.id);
    for (const f of others) {
      await drive.quarantine({ fileId: f.id, reason: `superseded by attempt ${token}`, certificateId: cert!.id, attemptToken: f.attemptToken ?? "", at: now().toISOString() }).catch(() => {});
    }

    const done = (await db.expenseCertificate.findUnique({ where: { id } }))!;
    await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.uploaded", entityType: "ExpenseCertificate", entityId: id,
      detail: { certificateNo: done.certificateNo, driveFileId: active.id, retiredTempFileId: temp.id, pdfHash, bytes: bytes.length, environment,
        readBackVerified: true, attempt: done.uploadAttempts, attemptToken: token,
        signature: cert!.signatureSha256 ? { userId: cert!.signatureUserId, version: cert!.signatureVersion, sha256: cert!.signatureSha256 } : null,
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
export type DocumentCheck = { ok: boolean; reasons: string[]; action?: "drive_overwritten" | "drive_changed" | "drive_missing" | "drive_duplicate" | "drive_not_private" };

export async function checkFiledDocument(cert: ExpenseCertificate, deps: Deps = {}, actorId?: string): Promise<DocumentCheck> {
  const environment = deps.environment ?? cert.driveEnvironment ?? certificateEnvironment();
  const folderPath = folderPathOf(cert);
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
  // Privacy is asked here too, and not only when the file was created. Sharing is
  // something a person does later, to a folder, months after the document was filed —
  // which is precisely the case a check that only ran at upload would never see.
  //
  // A configuration that cannot be validated makes this unanswerable rather than fine:
  // who is allowed to hold the file is exactly what is in doubt. The reason given here
  // is the one sentence, without the addresses — this result travels to screens the
  // configuration detail has no business reaching.
  const cfg = await validateDriveAllowlist((deps.db ?? prisma) as PrismaClient);
  if (!cfg.ok) return { ok: false, action: "drive_not_private", reasons: [CONFIG_INVALID_EN] };
  const privacy = await privacyProblems(drive, folderPath, file.id, cfg);
  if (privacy.length) return { ok: false, action: "drive_not_private", reasons: privacy };
  return { ok: true, reasons: [] };
}

// ── 4. Link it to the rows ───────────────────────────────────────────────────
//
// Drive is checked before the transaction. A remote read can take seconds and must not
// hold a database transaction open while it waits. The transaction then re-reads the
// certificate and accepts the check only if the exact filed-document snapshot is still
// current. Its final conditional update is the fence: if anything changes after that
// re-read, every row write is rolled back with it.
//
// The waiver written on each row names the certificate, so the row's evidence is only as
// good as the document — withdraw the document later and the row stops counting without
// anybody having to edit it, which matters because the save path refuses to edit a
// signed-for row at all.
//
// Rows are found by `financialIdentity`, the same function the save path uses. Neither
// can decide a row is "the same row" that the other would not.

export async function linkCertificate(id: string, actor: Actor, deps: Deps = {}): Promise<ExpenseCertificate> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());

  const checked = await db.expenseCertificate.findUnique({ where: { id } });
  if (!checked) refuse(["No such certificate"], 404);
  const bad = moveRefusal(checked.status as CertificateState, "LINKED");
  if (bad) refuse([bad]);
  if (!checked.driveFileId || !checked.pdfHash) refuse(["This certificate has not been filed in Drive yet, so there is no document for the rows to point at."]);

  // This is deliberately outside the transaction: it downloads and hashes the Drive
  // file and checks its permissions. The conditional write below proves that the result
  // is applied only to the same certificate snapshot that was checked here.
  const check = await checkFiledDocument(checked, deps, actor.id);
  if (!check.ok) {
    if (check.action) {
      await audit({ actorId: actor.id, actorRole: actor.role, action: `certificate.${check.action}`, entityType: "ExpenseCertificate", entityId: id,
        detail: { certificateNo: checked.certificateNo, driveFileId: checked.driveFileId, expectedAttempt: checked.driveAttemptToken, expectedPdfHash: checked.pdfHash, reasons: check.reasons } });
    }
    refuse(check.reasons, 409);
  }

  const linked = await db.$transaction(async (tx) => {
    const cert = await tx.expenseCertificate.findUnique({ where: { id } });
    if (!cert) refuse(["No such certificate"], 404);
    const snapshotMoved = cert!.updatedAt.getTime() !== checked.updatedAt.getTime()
      || cert!.status !== checked.status
      || cert!.driveFileId !== checked.driveFileId
      || cert!.pdfHash !== checked.pdfHash
      || cert!.driveAttemptToken !== checked.driveAttemptToken
      || cert!.driveRevisionId !== checked.driveRevisionId
      || cert!.driveEnvironment !== checked.driveEnvironment
      || cert!.driveFolderPath !== checked.driveFolderPath;
    if (snapshotMoved) refuse(["This certificate changed while its Drive document was being checked. Reload it and try linking again."]);

    const sheet = await tx.jobSheet.findUnique({ where: { id: cert!.jobSheetId } });
    if (!sheet) refuse(["The job sheet this certificate belongs to is gone"], 404);
    const expenses = (sheet!.expenses as unknown as Expense[]) ?? [];
    const name = await guideNameOf(tx, sheet!.guideId);
    const drift = checkDrift(
      { payloadHash: cert!.payloadHash, coveredRows: cert!.coveredRows as unknown as CertifiableRow[],
        signature: (cert!.payload as unknown as CertificatePayload).signature ?? null,
        origin: originOf(cert!) },
      { facts: factsFor(cert!, sheet!, name), expenses },
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
    const moved = await tx.expenseCertificate.updateMany({
      where: {
        id,
        status: checked.status,
        updatedAt: checked.updatedAt,
        driveFileId: checked.driveFileId,
        pdfHash: checked.pdfHash,
        driveAttemptToken: checked.driveAttemptToken,
        driveRevisionId: checked.driveRevisionId,
        driveEnvironment: checked.driveEnvironment,
        driveFolderPath: checked.driveFolderPath,
      },
      data: { status: "LINKED" satisfies CertificateState, linkedAt: now() },
    });
    if (moved.count !== 1) refuse(["This certificate changed while its Drive document was being checked. Reload it and try linking again."]);
    return tx.expenseCertificate.findUniqueOrThrow({ where: { id } });
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
