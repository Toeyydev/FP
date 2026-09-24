import type { Prisma, PrismaClient, AttesterSignature } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { folkpathsDriveToken } from "@/lib/google-drive";
import { driveAllowedEmails, folderPathString, folderPermissionProblems, permissionProblems, SIGNATURE_FOLDER } from "@/lib/certificates/access";
import { certificateEnvironment } from "@/lib/certificates/drive";
import { DuplicateSignatureFile, googleSignatureDrive, type SignatureDrive } from "@/lib/certificates/signature-drive";
import { MAX_SIGNATURE_BYTES, MAX_DIMENSION, MIN_DIMENSION, pngDimensions, sha256 } from "@/lib/certificates/signature";
import { attesterRefusal } from "@/lib/certificates/attester";

// Registering and replacing an attester's signature.
//
// Until now the `AttesterSignature` row was a contract with no way to fill it, which
// meant the only way to put a signature into production was to write to the database and
// to Drive by hand. That is not a deployment, it is an intervention, and it leaves no
// trace anybody can audit.
//
// The order of operations is the whole design:
//
//   1. the row is reserved first, so the file can carry its id
//   2. the folder is checked for privacy BEFORE a byte is written
//   3. the file is created — never updated, never overwritten
//   4. the bytes are read back and hashed against what was sent
//   5. the file is checked for privacy on its own
//   6. only then, in one transaction, the old version retires and the new one goes live
//
// A version's file is never written to again. Replacing a signature makes a new row, a
// new version and a new file, so a certificate attested against version 1 can still be
// checked against the bytes version 1 was registered with, years later.

export class SignatureRefused extends Error {
  constructor(public reasons: string[], public status = 409) {
    super(reasons[0] ?? "refused");
    this.name = "SignatureRefused";
  }
}
const refuse = (reasons: string[], status = 409): never => { throw new SignatureRefused(reasons, status); };

export type Actor = { id: string; name: string; role: string };

export type ServiceDeps = {
  db?: PrismaClient;
  drive?: SignatureDrive;
  environment?: string;
  now?: () => Date;
};

type Db = PrismaClient | Prisma.TransactionClient;

/** What the screen shows about one version. Never the bytes, never a public link. */
export type SignatureSummary = {
  id: string;
  userId: string;
  userName: string | null;
  version: number;
  active: boolean;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  uploadedAt: string;
  uploadedByName: string | null;
  retiredAt: string | null;
  retireReason: string | null;
  filed: boolean;
};

const nameOf = async (db: Db, id: string | null): Promise<string | null> => {
  if (!id) return null;
  const u = await db.user.findUnique({ where: { id }, select: { fullName: true, displayName: true, email: true } });
  return (u?.fullName || u?.displayName || u?.email || null)?.trim() ?? null;
};

async function summarise(db: Db, rows: AttesterSignature[]): Promise<SignatureSummary[]> {
  const names = new Map<string, string | null>();
  const who = async (id: string | null) => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, await nameOf(db, id));
    return names.get(id) ?? null;
  };
  return Promise.all(rows.map(async (r) => ({
    id: r.id,
    userId: r.userId,
    userName: await who(r.userId),
    version: r.version,
    active: r.activeUserId !== null,
    sha256: r.sha256,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    uploadedAt: r.uploadedAt.toISOString(),
    uploadedByName: await who(r.uploadedById),
    retiredAt: r.retiredAt ? r.retiredAt.toISOString() : null,
    retireReason: r.retireReason,
    filed: Boolean(r.driveFileId),
  })));
}

/**
 * May this person change a signature — their own or anybody's?
 *
 * The same authority that attests. Registering the image that will appear above a name
 * and certifying documents with it are one permission, not two: whoever can do the
 * second can effectively do the first by attesting with whatever is on file.
 *
 * Read from the database, never from the session, so an edited session cannot widen it.
 */
async function requireAttester(db: Db, actor: Actor): Promise<void> {
  const me = actor.id ? await db.user.findUnique({ where: { id: actor.id }, select: { email: true, role: true } }) : null;
  const no = attesterRefusal({ role: me?.role ?? actor.role, email: me?.email });
  if (no) refuse([no], 403);
}

/** Every version this person has ever had, newest first. History is never deleted. */
export async function signatureHistory(userId: string, deps: ServiceDeps = {}): Promise<SignatureSummary[]> {
  const db = deps.db ?? prisma;
  const rows = await db.attesterSignature.findMany({ where: { userId }, orderBy: { version: "desc" } });
  return summarise(db, rows);
}

/**
 * What a new signature changes, and what it does not.
 *
 * It does not change a single existing certificate. A certificate records the version it
 * was attested with and keeps it — filed ones are immutable files in Drive, and ones not
 * yet filed resolve the version they recorded. So the honest answer to "which
 * certificates does this affect" is: none of the existing ones, only the ones attested
 * from now on. The counts are here so nobody has to take that on trust.
 */
export async function replacementImpact(userId: string, deps: ServiceDeps = {}): Promise<{ attestedWithCurrent: number; alreadyFiled: number; attestedNotYetFiled: number }> {
  const db = deps.db ?? prisma;
  const current = await db.attesterSignature.findUnique({ where: { activeUserId: userId } });
  if (!current) return { attestedWithCurrent: 0, alreadyFiled: 0, attestedNotYetFiled: 0 };
  const where = { signatureUserId: userId, signatureVersion: current.version };
  const [attestedWithCurrent, alreadyFiled] = await Promise.all([
    db.expenseCertificate.count({ where }),
    db.expenseCertificate.count({ where: { ...where, status: { in: ["UPLOADED", "LINKED"] } } }),
  ]);
  return { attestedWithCurrent, alreadyFiled, attestedNotYetFiled: attestedWithCurrent - alreadyFiled };
}

/** Everything wrong with who can see this folder or file. Every unclear answer is a no. */
async function privacyProblems(drive: SignatureDrive, folderPath: string[], fileId: string | null): Promise<string[]> {
  const account = await drive.accountEmail().catch(() => null);
  if (!account) return ["Which Google account holds these images could not be read, so who can see them cannot be checked."];
  const allowed = [account, ...driveAllowedEmails()];
  const out: string[] = [];
  const folderId = await drive.folderId({ folderPath }).catch(() => null);
  if (!folderId) out.push(`The folder ${folderPathString(folderPath)} could not be found in Drive, so who can see it cannot be checked.`);
  else out.push(...folderPermissionProblems(await drive.permissions({ fileId: folderId }).catch(() => null), allowed, folderPath));
  if (fileId) {
    out.push(...permissionProblems(await drive.permissions({ fileId }).catch(() => null), allowed).map((p) => p.replace("This file", "The signature image")));
  }
  return out;
}

/** The PNG, checked the same way it is checked every time it is used. */
export function checkImage(bytes: Buffer): string[] {
  const out: string[] = [];
  if (!bytes.length) return ["No image was uploaded."];
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    out.push(`The image is ${Math.round(bytes.length / 1024)} KB, above the ${MAX_SIGNATURE_BYTES / 1024} KB a scanned signature should ever be.`);
    return out;
  }
  const dims = pngDimensions(bytes);
  if (!dims) return ["The file is not a PNG. A signature is registered as a PNG so it can be checked byte for byte."];
  if (dims.width < MIN_DIMENSION || dims.height < MIN_DIMENSION || dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) {
    out.push(`The image is ${dims.width}×${dims.height}, outside ${MIN_DIMENSION}–${MAX_DIMENSION} in each direction.`);
  }
  return out;
}

export type RegisterResult = { signature: SignatureSummary; created: boolean; replaced: number | null };

/**
 * Register a signature for a person, as a new version.
 *
 * Idempotent on the bytes: registering the image that is already live is not a change
 * and does not make a version 2 identical to version 1. That matters because the obvious
 * failure here is a double-submitted form leaving two versions of one scan, after which
 * nobody can say which is current without comparing hashes by eye.
 */
export async function registerSignature(
  userId: string,
  bytes: Buffer,
  actor: Actor,
  deps: ServiceDeps = {},
): Promise<RegisterResult> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const environment = deps.environment ?? certificateEnvironment();

  await requireAttester(db, actor);

  const problems = checkImage(bytes);
  if (problems.length) refuse(problems, 400);
  const dims = pngDimensions(bytes)!;
  const hash = sha256(bytes);

  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) refuse(["No such person to register a signature for"], 404);

  // Already live, byte for byte. Nothing to do, and saying so is better than silently
  // making a second identical version.
  const live = await db.attesterSignature.findUnique({ where: { activeUserId: userId } });
  if (live && live.sha256 === hash && live.driveFileId) {
    return { signature: (await summarise(db, [live]))[0], created: false, replaced: null };
  }

  // Reserve the row first: the file has to carry the id of the record it belongs to, and
  // a file that names no record cannot be matched back to one. The unique (userId,
  // version) is what stops two people registering version N+1 at the same moment.
  const nextVersion = ((await db.attesterSignature.findFirst({ where: { userId }, orderBy: { version: "desc" }, select: { version: true } }))?.version ?? 0) + 1;
  let row: AttesterSignature;
  try {
    row = await db.attesterSignature.create({
      data: { userId, version: nextVersion, sha256: hash, bytes: bytes.length, width: dims.width, height: dims.height, uploadedById: actor.id, uploadedAt: now() },
    });
  } catch {
    refuse(["Another signature was registered for this person a moment ago. Reload and look at what is on file before trying again."]);
  }

  let drive = deps.drive;
  if (!drive) {
    const token = await folkpathsDriveToken(actor.id);
    if (!token) {
      await db.attesterSignature.delete({ where: { id: row!.id } }).catch(() => {});
      refuse(["Google Drive is not connected, so the signature image cannot be filed."], 503);
    }
    drive = googleSignatureDrive(token!);
  }

  const folderPath = SIGNATURE_FOLDER;
  /**
   * Give the reservation back.
   *
   * Only ever a row that never became a live signature — the guard on `driveFileId`
   * makes that a condition rather than a belief. A reservation left behind is not
   * harmless: it holds a version number, so the next attempt becomes version 3 with no
   * version 2 to explain the gap, and somebody reading the history later has to work out
   * whether a signature was lost.
   *
   * A file written before the failure is left where it is, marked with the id of a
   * record that no longer exists. That is deliberate: it is findable, it is inert
   * because nothing looks it up, and deleting somebody's uploaded image on the way out
   * of an error is a worse way to be wrong.
   */
  const clean = async (why: string) => {
    await db.attesterSignature.deleteMany({ where: { id: row!.id, driveFileId: null } }).catch(() => {});
    return why;
  };

  try {
  // Before a byte is written. An image in a folder somebody shared has already leaked by
  // the time anyone checks it, and moving it afterwards does not unsee it.
  const folderPrivacy = await privacyProblems(drive, folderPath, null);
  if (folderPrivacy.length) {
    await clean("folder not private");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.drive_not_private", entityType: "AttesterSignature",
      detail: { userId, stage: "folder", folder: folderPathString(folderPath), problems: folderPrivacy } });
    refuse(["The folder signature images are filed in is not private to the admins, so nothing was filed:", ...folderPrivacy]);
  }

  // A retry of an interrupted registration finds its own file rather than making a
  // second. Two files under one record id is unanswerable, so it stops.
  const existing = await drive.find({ signatureId: row!.id, environment, folderPath });
  if (existing.length > 1) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.drive_duplicate", entityType: "AttesterSignature", entityId: row!.id,
      detail: { userId, version: nextVersion, environment, fileIds: existing.map((f) => f.id) } });
    throw new DuplicateSignatureFile(row!.id, existing.map((f) => f.id));
  }

  const file = existing[0] ?? await drive.create({
    signatureId: row!.id, userId, version: nextVersion, environment, sha256: hash,
    name: `signature-${userId}-v${nextVersion}.png`, bytes, folderPath,
  });

  // Asked AGAIN, after writing. Checking only beforehand answers the wrong question: two
  // files under one record is not a state Drive was already in, it is the state a write
  // that half-succeeded and was retried leaves behind. So the count is taken once the
  // write is done, and more than one stops here rather than picking whichever came back.
  const after = await drive.find({ signatureId: row!.id, environment, folderPath });
  if (after.length > 1) {
    await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.drive_duplicate", entityType: "AttesterSignature", entityId: row!.id,
      detail: { userId, version: nextVersion, environment, fileIds: after.map((f) => f.id), stage: "after-write" } });
    await clean("duplicate files");
    throw new DuplicateSignatureFile(row!.id, after.map((f) => f.id));
  }

  // Hash what is in the file, not what was sent to it.
  const back = await drive.read({ fileId: file.id }).catch(() => null);
  if (!back || sha256(back) !== hash) {
    await drive.quarantine({ fileId: file.id, reason: "read-back did not match the bytes that were uploaded", signatureId: row!.id, at: now().toISOString() }).catch(() => {});
    await clean("read-back mismatch");
    refuse(["The image filed in Drive did not read back as the one that was uploaded. It has been moved aside and nothing was registered — try again."], 502);
  }

  const filePrivacy = await privacyProblems(drive, folderPath, file.id);
  if (filePrivacy.length) {
    await drive.quarantine({ fileId: file.id, reason: "the filed image was not private to the admins", signatureId: row!.id, at: now().toISOString() }).catch(() => {});
    await clean("file not private");
    await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.drive_not_private", entityType: "AttesterSignature", entityId: row!.id,
      detail: { userId, stage: "file", driveFileId: file.id, problems: filePrivacy } });
    refuse(["The signature image filed in Drive is not private to the admins, so it has been moved aside and nothing was registered:", ...filePrivacy]);
  }

  // One transaction: the old version steps down and the new one goes live together.
  // `activeUserId` is unique, so these cannot both hold it even for an instant.
  const replaced = await db.$transaction(async (tx) => {
    const current = await tx.attesterSignature.findUnique({ where: { activeUserId: userId } });
    if (current) {
      await tx.attesterSignature.update({
        where: { id: current.id },
        data: { activeUserId: null, retiredAt: now(), retiredById: actor.id, retireReason: `replaced by version ${nextVersion}` },
      });
    }
    await tx.attesterSignature.update({
      where: { id: row!.id },
      data: { activeUserId: userId, driveFileId: file.id, driveUrl: file.link, driveEnvironment: environment },
    });
    return current?.version ?? null;
  });

  await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.registered", entityType: "AttesterSignature", entityId: row!.id,
    detail: { userId, version: nextVersion, replacedVersion: replaced, sha256: hash, bytes: bytes.length, width: dims.width, height: dims.height, environment,
      note: "a new version and a new file; no earlier version was overwritten, and no existing certificate changes — each keeps the version it was attested with" } });

  const saved = (await db.attesterSignature.findUnique({ where: { id: row!.id } }))!;
  return { signature: (await summarise(db, [saved]))[0], created: true, replaced };
  } catch (e) {
    // Any way out that is not success: Drive refused, the process was interrupted, a
    // check said no. The reservation goes back so the version numbers stay a record of
    // signatures that existed rather than of attempts that did not.
    await clean("registration did not complete");
    throw e;
  }
}

/**
 * Stand a signature down without deleting anything.
 *
 * The row stays, its file stays, and every certificate attested with it goes on reading
 * correctly. What changes is that new certificates are attested without an image —
 * which is a complete document, not a broken one.
 */
export async function retireSignature(userId: string, reason: string, actor: Actor, deps: ServiceDeps = {}): Promise<SignatureSummary | null> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  await requireAttester(db, actor);
  if ((reason ?? "").trim().length < 10) {
    refuse(["Say why this signature is being stood down — at least 10 characters, and it is kept with the record."], 400);
  }
  const current = await db.attesterSignature.findUnique({ where: { activeUserId: userId } });
  if (!current) return null;

  const stood = await db.attesterSignature.updateMany({
    where: { id: current.id, activeUserId: userId },
    data: { activeUserId: null, retiredAt: now(), retiredById: actor.id, retireReason: reason.trim().slice(0, 300) },
  });
  if (stood.count !== 1) refuse(["That signature was changed a moment ago. Reload and look at what is on file."]);

  await audit({ actorId: actor.id, actorRole: actor.role, action: "signature.retired", entityType: "AttesterSignature", entityId: current.id,
    detail: { userId, version: current.version, reason: reason.trim().slice(0, 300),
      note: "the version and its file are kept; certificates attested with it are unaffected" } });
  return (await summarise(db, [(await db.attesterSignature.findUnique({ where: { id: current.id } }))!]))[0];
}

/**
 * The live image bytes, for an admin to look at before they trust it.
 *
 * Read server-side from the private file and handed straight to the caller. The answer
 * carries no Drive link, no file id and no folder — so seeing the image does not come
 * with the ability to pass on access to where it is kept. It plainly does not stop
 * whoever is shown the image from keeping a copy of it; nothing could.
 */
export async function activeSignatureBytes(userId: string, actorId: string, deps: ServiceDeps = {}): Promise<{ bytes: Buffer; sha256: string } | null> {
  const db = deps.db ?? prisma;
  const row = await db.attesterSignature.findUnique({ where: { activeUserId: userId } });
  if (!row?.driveFileId) return null;
  let drive = deps.drive;
  if (!drive) {
    const token = await folkpathsDriveToken(actorId);
    if (!token) return null;
    drive = googleSignatureDrive(token);
  }
  const bytes = await drive.read({ fileId: row.driveFileId }).catch(() => null);
  if (!bytes || sha256(bytes) !== row.sha256) return null;
  return { bytes, sha256: row.sha256 };
}
