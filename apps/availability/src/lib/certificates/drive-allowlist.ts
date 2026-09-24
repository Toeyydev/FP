import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { driveAllowedEmails } from "@/lib/certificates/access";

// Checking that the Drive allowlist names people this company actually trusts.
//
// `CERTIFICATE_DRIVE_ALLOWED_EMAILS` decides which Google accounts may appear on a
// certificate or signature file without the privacy check refusing. Left as plain
// configuration, that is a permission granted by typing: an address in an environment
// variable is believed, and whoever holds that Google account can then legitimately hold
// the documents. Nothing checked that the address belonged to anybody here.
//
// So every entry is now matched against this system's own records, and an entry that
// does not correspond to a live ADMIN account is not honoured. The failure direction
// matters: an unrecognised entry is dropped rather than trusted, so a file shared with
// that account is reported as not private and filing stops. A typo therefore costs a
// refusal and a visible message, never a quietly wider circle.
//
// One account is allowed without appearing in the list at all: the Google account the
// files are created by. It owns what it writes, it is the account this system
// authenticates as, and a file it cannot see is a file nothing can check.
//
// What this does NOT do is grant anything. Being on this list lets a Google account hold
// a file; it gives no access to FolkOPS, and it is not how anybody becomes an admin.

type Db = PrismaClient | Prisma.TransactionClient;

export type AllowlistCheck = {
  /** Addresses a file may be shared with: the filing account plus the verified entries. */
  allowed: string[];
  /** Configured entries that were not honoured, and why. */
  problems: string[];
  /** Entries that checked out, for a screen that wants to show what is in force. */
  verified: string[];
};

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/**
 * The allowlist, with every configured address checked against a real account.
 *
 * An address is honoured only when it belongs to a user of this system whose role is
 * ADMIN and whose account can actually be used. A suspended admin is not a current
 * admin: revoking somebody's access here should not leave them holding the finance
 * documents, which is exactly the case a role-only check would miss.
 */
export async function checkedDriveAllowlist(account: string | null, db: Db = prisma): Promise<AllowlistCheck> {
  const configured = [...new Set(driveAllowedEmails())];
  const filing = norm(account);
  const allowed = filing ? [filing] : [];
  if (!configured.length) return { allowed, problems: [], verified: [] };

  const users = await db.user.findMany({
    where: { email: { in: configured, mode: "insensitive" } },
    select: { email: true, role: true, state: true },
  });
  const byEmail = new Map(users.map((u) => [norm(u.email), u]));

  const problems: string[] = [];
  const verified: string[] = [];
  for (const email of configured) {
    // The filing account is not expected to be a FolkOPS user — it is the Drive account
    // itself — so naming it in the list as well is harmless rather than wrong.
    if (email === filing) { verified.push(email); continue; }
    const u = byEmail.get(email);
    if (!u) {
      problems.push(`${email} is listed as allowed to hold certificate files but is not an account in FolkOPS, so nothing here can say who it belongs to. It is being ignored.`);
      continue;
    }
    if (u.role !== "ADMIN") {
      problems.push(`${email} is listed as allowed to hold certificate files but is a ${String(u.role).toLowerCase()} here, not an admin. It is being ignored.`);
      continue;
    }
    if (u.state === "SUSPENDED") {
      problems.push(`${email} is listed as allowed to hold certificate files but that account is suspended. It is being ignored.`);
      continue;
    }
    verified.push(email);
    allowed.push(email);
  }
  return { allowed, problems, verified };
}

/**
 * The same question with no database to hand.
 *
 * Used where the answer must stay pure. It cannot verify anything, so it says so: every
 * configured entry is reported as unchecked rather than quietly accepted.
 */
export function unverifiedDriveAllowlist(account: string | null): AllowlistCheck {
  const configured = [...new Set(driveAllowedEmails())];
  const filing = norm(account);
  return {
    allowed: filing ? [filing] : [],
    verified: [],
    problems: configured.map((e) => `${e} could not be checked against an account, so it is being ignored.`),
  };
}
