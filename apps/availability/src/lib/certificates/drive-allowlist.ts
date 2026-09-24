import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { driveAllowedEmails } from "@/lib/certificates/access";

// Checking that the Drive allowlist names people this company actually trusts.
//
// `CERTIFICATE_DRIVE_ALLOWED_EMAILS` decides which Google accounts may hold a certificate
// or signature file. That is not a cosmetic setting: a person on that list can open the
// document in Drive directly, whatever FolkOPS says. Returning 403 from every endpoint
// means nothing if the file itself is shared with them — so an unchecked entry breaks the
// rule that only an admin sees a certificate, silently, from a text field.
//
// So this fails CLOSED, and it fails on the whole thing. An entry that cannot be matched
// to a live admin does not get quietly dropped while the rest proceeds: nothing is filed
// at all. A half-honoured list is the state where somebody believes an address is in
// force and it is not, and a wrong belief about who can see finance documents is worse
// than a refusal somebody has to fix.
//
// The account the files are CREATED by is implicit. It owns what it writes, it is the
// account this system authenticates to Drive as, and it is not a FolkOPS user — asking
// for it in the User table would be asking a service account to have a login. It needs
// no entry and is always allowed.
//
// Three things this is not:
//   it grants nothing in FolkOPS       being listed lets a Google account hold a file
//   it does not read the attester list being allowed to certify says nothing about Drive
//   it never takes an address from a request — configuration only, server-side only

type Db = PrismaClient | Prisma.TransactionClient;

/** What an admin is told. Says what to do without needing to know what went wrong. */
export const CONFIG_INVALID_TH =
  "บัญชี Google ที่อนุญาตให้เปิดไฟล์ต้องเป็นผู้ใช้ ADMIN ใน FolkOPS";
export const CONFIG_INVALID_EN =
  "Every Google account allowed to open these files must be an ADMIN user in FolkOPS.";

export type AllowlistResult =
  | {
      ok: true;
      /** Addresses a file may be shared with: the filing account plus verified entries. */
      allowed: string[];
      /** The configured entries that checked out. Empty when nothing is configured. */
      verified: string[];
    }
  | {
      ok: false;
      /** One sentence, safe to show any admin. */
      reason: string;
      /**
       * Per-entry specifics, INCLUDING addresses. Only ever shown to an admin, and never
       * written to an audit row: a row naming the misconfigured addresses is a list of
       * accounts somebody tried to give the documents to, kept for years.
       */
      detail: string[];
      /** How many entries were wrong. Safe to record and to count. */
      invalidCount: number;
    };

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/**
 * Validate the configured allowlist against this system's own records.
 *
 * Makes NO call to Drive — deliberately. It has to be answerable before a folder is
 * created, before bytes are uploaded and before any permission is touched, because each
 * of those is a change that a later refusal cannot take back.
 *
 * `isAdmin` decides what counts as an admin, so the definition cannot drift apart from
 * the one the rest of the app enforces.
 */
export async function validateDriveAllowlist(db: Db = prisma): Promise<AllowlistResult> {
  const raw = driveAllowedEmails(); // already trimmed and lower-cased
  if (!raw.length) return { ok: true, allowed: [], verified: [] };

  // A duplicate is a configuration nobody can reason about: two entries meaning one
  // account, or one of them a typo of something else. Either way it is not what somebody
  // intended, so it is refused rather than de-duplicated behind their back.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of raw) {
    if (seen.has(e)) duplicates.add(e);
    seen.add(e);
  }
  if (duplicates.size) {
    return {
      ok: false, reason: CONFIG_INVALID_EN, invalidCount: duplicates.size,
      detail: [...duplicates].map((e) => `${e} appears more than once in the allowlist. Remove the duplicate so the list says one thing.`),
    };
  }

  const wanted = [...seen];
  let users: { email: string; role: string }[];
  try {
    users = (await db.user.findMany({
      where: { email: { in: wanted, mode: "insensitive" } },
      select: { email: true, role: true },
    })) as { email: string; role: string }[];
  } catch {
    // Could not ask. "We do not know whether these are admins" is not "they are".
    return {
      ok: false, reason: CONFIG_INVALID_EN, invalidCount: wanted.length,
      detail: ["The allowlist could not be checked against FolkOPS accounts, so it cannot be relied on."],
    };
  }

  // Two accounts whose addresses differ only by case are one address to Google and two
  // rows here. Which one is meant is unanswerable, so it stops.
  const byEmail = new Map<string, { email: string; role: string }>();
  const collisions = new Set<string>();
  for (const u of users) {
    const key = norm(u.email);
    if (byEmail.has(key)) collisions.add(key);
    byEmail.set(key, u);
  }
  if (collisions.size) {
    return {
      ok: false, reason: CONFIG_INVALID_EN, invalidCount: collisions.size,
      detail: [...collisions].map((e) => `${e} matches more than one FolkOPS account, so which person it means cannot be answered.`),
    };
  }

  const detail: string[] = [];
  for (const email of wanted) {
    const u = byEmail.get(email);
    if (!u) {
      detail.push(`${email} is not an account in FolkOPS, so nothing here can say who it belongs to.`);
      continue;
    }
    // isAdmin, not a comparison of our own — being on the attester allowlist, or being an
    // operator who does finance work, does not make somebody an admin.
    if (!isAdmin(u.role)) {
      detail.push(`${email} is a ${String(u.role).toLowerCase()} in FolkOPS, not an admin.`);
    }
  }
  if (detail.length) return { ok: false, reason: CONFIG_INVALID_EN, detail, invalidCount: detail.length };

  return { ok: true, allowed: wanted, verified: wanted };
}

/**
 * The addresses a file may be shared with, given a validated list and the filing account.
 *
 * Kept separate so the Drive-facing code cannot accidentally be handed an unvalidated
 * list: this only accepts a result that already said `ok`.
 */
export function allowedHolders(account: string | null, result: Extract<AllowlistResult, { ok: true }>): string[] {
  const filing = norm(account);
  return filing ? [filing, ...result.allowed] : [...result.allowed];
}

/** What may be written to an audit row: counts and a verdict, never an address. */
export const sanitisedConfigAudit = (result: Extract<AllowlistResult, { ok: false }>) => ({
  configuration: "invalid" as const,
  invalidEntries: result.invalidCount,
  note: "one or more Google accounts configured as allowed to hold certificate files are not ADMIN users in FolkOPS; the addresses are deliberately not recorded here",
});
