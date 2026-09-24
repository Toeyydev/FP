import { createHash } from "node:crypto";
import type { Prisma, PrismaClient, AttesterSignature } from "@prisma/client";
import { prisma } from "@/lib/db";
import { downloadDriveFile, folkpathsDriveToken } from "@/lib/google-drive";
import { permissionProblems } from "@/lib/certificates/access";
import { checkedDriveAllowlist } from "@/lib/certificates/drive-allowlist";
import { googleCertificateDrive } from "@/lib/certificates/drive";

// The image of an attester's handwritten signature, and the rules about whose it is.
//
// A signature belongs to one person. The only reason to print one is that a reader
// recognises the hand, so the single thing this must never do is put one person's
// signature under another person's name — not by configuration, not by a request
// parameter, and not as a fallback when somebody's own image is missing. An attester
// with no registered signature gets a document with no image on it, and their name,
// role and time exactly as before. That is a complete document; a borrowed signature is
// a forged one.
//
// Nothing here reads anything from a request. The caller passes a user id that came from
// a session, and the image is whatever this server has registered for that person. A
// client cannot send bytes, a Drive file id or a data URI, because no code path takes
// one.

/** A signature image is a scan of a name, not a photograph. Anything larger is wrong. */
export const MAX_SIGNATURE_BYTES = 512 * 1024;
export const MIN_DIMENSION = 40;
export const MAX_DIMENSION = 2000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type SignatureRefusal =
  | "not-registered"     // this person has no signature on file — a document without one is correct
  | "unreadable"         // Drive would not give it back
  | "not-a-png"
  | "too-large"
  | "bad-dimensions"
  | "hash-mismatch"      // what is in Drive is not what was registered
  | "not-private";       // somebody other than the admins can open it

export type ResolvedSignature = {
  userId: string;
  version: number;
  sha256: string;
  width: number;
  height: number;
  /** The image itself, inline. Nothing is fetched while the page renders. */
  dataUri: string;
};

export type SignatureResult =
  | { ok: true; signature: ResolvedSignature }
  | { ok: false; code: SignatureRefusal; reasons: string[] };

/** Width and height out of the PNG's own IHDR, rather than out of the database row. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export type SignatureDeps = {
  db?: PrismaClient | Prisma.TransactionClient;
  /** Fetch the registered image. Supplied by tests; Drive otherwise. */
  fetchAsset?: (row: AttesterSignature) => Promise<Buffer | null>;
  /** Everything wrong with who can open the image. Supplied by tests; Drive otherwise. */
  privacy?: (row: AttesterSignature) => Promise<string[]>;
};

/** The live signature row for a person, or nothing. Never anybody else's. */
export async function registeredSignature(userId: string, deps: SignatureDeps = {}): Promise<AttesterSignature | null> {
  const db = deps.db ?? prisma;
  if (!userId.trim()) return null;
  // Keyed on activeUserId, so a retired version can never be picked up by accident.
  return db.attesterSignature.findUnique({ where: { activeUserId: userId } });
}

/**
 * One particular version of a person's signature, retired or not.
 *
 * This is what a certificate needs. A certificate records the version it was attested
 * with, and that is the image it keeps — registering a new signature does not reach back
 * and change what somebody already put their name to. Asking for the ACTIVE one here
 * would mean a certificate attested in March and filed in June carried June's hand.
 *
 * Retired on purpose is not a reason to refuse: the version was live when it was used,
 * which is the whole question.
 */
export async function registeredSignatureVersion(userId: string, version: number, deps: SignatureDeps = {}): Promise<AttesterSignature | null> {
  const db = deps.db ?? prisma;
  if (!userId.trim() || !Number.isInteger(version) || version < 1) return null;
  return db.attesterSignature.findUnique({ where: { userId_version: { userId, version } } });
}

/**
 * The image to put on this person's document, checked on the way.
 *
 * Every refusal is a refusal. A signature that cannot be fetched, is not a PNG, is the
 * wrong shape, or whose bytes no longer hash to what was registered, does not become
 * "carry on without a picture" — all four mean the thing on file is not the thing that
 * was approved. The one case that is not an error is having no signature registered at
 * all, which is an ordinary state of affairs and says so.
 */
export async function resolveSignature(userId: string, deps: SignatureDeps = {}, actorId?: string, version?: number | null): Promise<SignatureResult> {
  // A version means "the one this document was attested with"; no version means "whatever
  // is live now", which is only ever asked at the moment of attesting.
  const row = version == null ? await registeredSignature(userId, deps) : await registeredSignatureVersion(userId, version, deps);
  if (!row) {
    return { ok: false, code: "not-registered", reasons: [version == null
      ? "No signature image is registered for this person."
      : `Version ${version} of this person's signature is not on file, so the image this certificate was attested with cannot be found.`] };
  }
  if (!row.driveFileId) {
    return { ok: false, code: "unreadable", reasons: [`Version ${row.version} of this signature was reserved but its image was never filed, so there is nothing to put on a document.`] };
  }

  const fetchAsset = deps.fetchAsset ?? (async (r: AttesterSignature) => {
    const token = await folkpathsDriveToken(actorId);
    if (!token) return null;
    const got = await downloadDriveFile(token, r.driveUrl ?? `https://drive.google.com/file/d/${r.driveFileId ?? ""}/view`);
    return got ? Buffer.from(got.base64, "base64") : null;
  });

  const bytes = await fetchAsset(row).catch(() => null);
  if (!bytes || !bytes.length) {
    return { ok: false, code: "unreadable", reasons: [`The registered signature image could not be read (version ${row.version}). It is not used until it can be.`] };
  }
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    return { ok: false, code: "too-large", reasons: [`The signature image is ${Math.round(bytes.length / 1024)} KB, above the ${MAX_SIGNATURE_BYTES / 1024} KB a scanned signature should ever be.`] };
  }
  const dims = pngDimensions(bytes);
  if (!dims) return { ok: false, code: "not-a-png", reasons: ["The registered signature image is not a PNG."] };
  if (dims.width < MIN_DIMENSION || dims.height < MIN_DIMENSION || dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) {
    return { ok: false, code: "bad-dimensions", reasons: [`The signature image is ${dims.width}×${dims.height}, outside ${MIN_DIMENSION}–${MAX_DIMENSION} in each direction.`] };
  }
  // Who can open it, asked of Drive. A signature image is the one thing on a certificate
  // that is worth copying and the only one that is reusable — whoever holds it can put a
  // person's hand on anything. An image anybody can reach is not usable as one, so the
  // document is refused rather than printed with it.
  const checkPrivacy = deps.privacy ?? (async (r: AttesterSignature) => {
    const token = await folkpathsDriveToken(actorId);
    if (!token) return ["Google Drive is not connected, so who can open the signature image cannot be checked."];
    const account = await googleCertificateDrive(token).accountEmail().catch(() => null);
    if (!account) return ["Which Google account holds the signature image could not be read, so who can open it cannot be checked."];
    const list = await checkedDriveAllowlist(account, deps.db ?? prisma);
    const perms = await googleCertificateDrive(token).permissions({ fileId: r.driveFileId ?? "" }).catch(() => null);
    return [...list.problems, ...permissionProblems(perms, list.allowed).map((p) => p.replace("This file", "The signature image"))];
  });
  const privacy = await checkPrivacy(row).catch(() => ["Who can open the signature image could not be checked."]);
  if (privacy.length) return { ok: false, code: "not-private", reasons: privacy };

  const got = sha256(bytes);
  if (got !== row.sha256) {
    // The registered bytes changed without going through a new version. Whatever is
    // there now, nobody approved it for this document.
    return { ok: false, code: "hash-mismatch", reasons: ["The signature image in Drive is not the one that was registered — its contents have changed. It is not used until it is registered again."] };
  }

  return {
    ok: true,
    signature: { userId: row.userId, version: row.version, sha256: got, width: dims.width, height: dims.height, dataUri: `data:image/png;base64,${bytes.toString("base64")}` },
  };
}

/**
 * Is a refusal one that should stop the document, or simply mean there is no picture?
 *
 * Only "nothing registered" is the second kind.
 */
export const blocksDocument = (code: SignatureRefusal): boolean => code !== "not-registered";

/** What goes in the payload and the audit: an identity, never the image. */
export type SignatureStamp = { userId: string; version: number; sha256: string };
export const stampOf = (s: ResolvedSignature): SignatureStamp => ({ userId: s.userId, version: s.version, sha256: s.sha256 });
