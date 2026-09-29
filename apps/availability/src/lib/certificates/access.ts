// Who can see a certificate, and where one is allowed to live.
//
// A certificate in lieu of a receipt is the company's internal record that money left
// without paper behind it. It names a guide, an amount, and an admin who took
// responsibility for it — and it now carries an image of that admin's handwriting. None
// of that is the guide's business, and the signature image least of all: it is the one
// thing on the document that is worth copying.
//
// So the rule is one sentence: only an ADMIN sees a certificate, and only an ADMIN sees a
// signature. Everything in this file exists because "only an admin sees it" has to be
// true in four different places, and being true in three of them is the same as being
// false.
//
//   the screen    a button that is not rendered
//   the endpoint  a role check on the server, because the button is only a button
//   the payload   the metadata stripped out of what non-admins are sent
//   the file      a Drive folder the guides were never given

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Where a certificate is filed.
 *
 * Deliberately NOT under "Folkpaths Job Sheets". That tree is shared with guides — it is
 * how they read their own job sheets — and a certificate filed inside it is visible to
 * them the moment the folder is, whatever the app does. A private tree of its own is the
 * only arrangement where the answer does not depend on which folder somebody shared
 * three months ago.
 */
export function certificateFolder(tourDate: string): string[] {
  return ["Folkpaths Finance", "Private Expense Certificates", tourDate.slice(0, 7)];
}

/**
 * Where certificates were filed before this rule existed.
 *
 * Kept so that a document already in Drive can still be found, checked and read. Nothing
 * new is written here, and a certificate that names it is still subject to every
 * permission check below — being in the wrong folder is exactly the condition those
 * checks are for.
 */
export function legacyCertificateFolder(tourDate: string): string[] {
  const month = `${tourDate.slice(0, 7)} ${MONTHS[Number(tourDate.slice(5, 7)) - 1] ?? ""}`.trim();
  return ["Folkpaths Job Sheets", month, "Expense Certificates"];
}

/**
 * Where signature images live: their own folder, not beside the certificates.
 *
 * A certificate is one guide's expenses on one day. A signature image is reusable —
 * whoever holds it can put a person's hand on anything. Separating them means widening
 * access to a month of certificates never also hands over the signatures.
 */
export const SIGNATURE_FOLDER = ["Folkpaths Finance", "Private Attester Signatures"];

/** Which folder a certificate's file is actually in, old or new. */
export function folderPathOf(cert: { tourDate: string; driveFolderPath?: string | null; driveFileId?: string | null }): string[] {
  const recorded = (cert.driveFolderPath ?? "").trim();
  if (recorded) return recorded.split("/").filter(Boolean);
  // No recorded path and a file already filed means it predates this — it is in the old
  // place. No recorded path and no file means nothing has been filed yet.
  return cert.driveFileId ? legacyCertificateFolder(cert.tourDate) : certificateFolder(cert.tourDate);
}

export const folderPathString = (path: readonly string[]) => path.join("/");

// ── who may be on the file ───────────────────────────────────────────────────

export type DrivePermission = {
  id?: string;
  type?: string;              // user | group | domain | anyone
  role?: string;              // owner | organizer | fileOrganizer | writer | commenter | reader
  emailAddress?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
  deleted?: boolean;
};

/**
 * GOOGLE accounts permitted to appear on these private Drive files, beside the account
 * that files them.
 *
 * This is not an application permission and decides nothing about who may use FolkOPS.
 * Who may SEE a certificate in the app is the ADMIN role and nothing else — leaving this
 * unset does not lock an admin out of anything, and adding somebody here does not let
 * them in. It answers one question only: when Drive is asked who can open this file, is
 * the answer a list we expected?
 *
 * The earlier name for this said "admin emails", which invited exactly the wrong reading
 * — that an admin missing from it would stop being able to open documents.
 */
export function driveAllowedEmails(): string[] {
  return (process.env.CERTIFICATE_DRIVE_ALLOWED_EMAILS ?? "")
    .split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}

const shownAs = (p: DrivePermission) =>
  p.emailAddress || p.domain || (p.type === "anyone" ? "anyone with the link" : p.type || "an unnamed grant");

/**
 * Everything wrong with who can see this file, in the words of the person who has to fix
 * it. An empty list means it is private to the accounts that are supposed to have it.
 *
 * Fails closed in every direction. An unreadable permission list is a problem, not a
 * pass: "we could not check" and "it is fine" are different answers and only one of them
 * is safe to act on. A grant this does not recognise is a problem for the same reason —
 * Drive can add kinds of sharing faster than this file can learn about them, and the
 * failure this guards against is a guide opening an admin's signature.
 *
 * `allowed` is the account doing the filing plus whatever Google addresses are
 * configured for these folders. Anything else — a domain, a group whose membership nothing here can see,
 * a link that works for anyone — is broader than the accounts named, including when it
 * happens to contain only the right people today.
 */
export function permissionProblems(
  permissions: readonly DrivePermission[] | null | undefined,
  allowed: readonly string[],
): string[] {
  if (!permissions) return ["Who can see this file could not be read from Drive, so it cannot be treated as private."];
  const ok = new Set(allowed.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const problems: string[] = [];

  for (const p of permissions) {
    if (p.deleted) continue;
    switch (p.type) {
      case "anyone":
        // The one the rule is named after. A link that works without signing in makes
        // every other check on this page decoration.
        problems.push(`This file is shared with anyone who has the link${p.allowFileDiscovery ? " and can be found in search" : ""}. A certificate in lieu of a receipt is never public.`);
        break;
      case "domain":
        problems.push(`This file is shared with everyone at ${p.domain ?? "a whole domain"}, which is wider than the admins who are allowed to see it.`);
        break;
      case "group":
        // Not "probably fine". Nothing here can list who is in the group, so nothing
        // here can say the guides are not.
        problems.push(`This file is shared with the group ${shownAs(p)}. Who is in a group cannot be checked from here, so it cannot stand as private.`);
        break;
      case "user": {
        const email = (p.emailAddress ?? "").trim().toLowerCase();
        if (!email) problems.push("This file is shared with an account whose address Drive did not give back, so it cannot be checked.");
        else if (!ok.has(email)) problems.push(`This file is shared with ${p.emailAddress}, which is not one of the Google accounts these files are meant to be open to.`);
        break;
      }
      default:
        problems.push(`This file carries a kind of sharing this check does not recognise (${p.type ?? "unknown"}), so it cannot be treated as private.`);
    }
  }
  return problems;
}

/** The same question about the folder a file is going into, said the folder's way. */
export function folderPermissionProblems(
  permissions: readonly DrivePermission[] | null | undefined,
  allowed: readonly string[],
  path: readonly string[],
): string[] {
  const where = folderPathString(path) || "this folder";
  if (!permissions) return [`Who can see ${where} could not be read from Drive, so nothing is filed there.`];
  return permissionProblems(permissions, allowed).map((p) =>
    p.replace("This file is shared", `The folder ${where} is shared`).replace("This file carries", `The folder ${where} carries`),
  );
}

// ── what a non-admin is allowed to be told ───────────────────────────────────

/**
 * Every field that says a certificate exists, where it is, or what is on it.
 *
 * A list rather than a shape, because the leak is never the object somebody remembered
 * to think about — it is `...sheet` somewhere else carrying a row's `evidenceWaiver`
 * along with it.
 */
export const CERTIFICATE_METADATA_FIELDS = [
  "certificateId", "certificateNo", "payloadHash", "pdfHash",
  "driveUrl", "driveFileId", "driveRevisionId", "driveMd5", "driveFolderPath", "driveAttemptToken",
  "attestedByUserId", "attestedByName", "attestedByRole", "attestedAt",
  "signatureUserId", "signatureVersion", "signatureSha256", "signatureDataUri",
  "coveredRows", "auditRef",
] as const;

/**
 * What a non-admin is told instead: that somebody is dealing with it.
 *
 * Not silence. A guide whose reimbursement is sitting still deserves to know it is being
 * worked on, and a blank where an explanation should be invites a phone call that ends
 * with somebody reading the document aloud.
 */
export const NON_ADMIN_STATUS_TH = "อยู่ระหว่างตรวจสอบโดยฝ่ายบัญชี";
export const NON_ADMIN_STATUS_EN = "being checked by accounts";

/** The waiver as a non-admin may see it: that one exists, and nothing about the document. */
export type PublicWaiver = { waived: true; status: string; statusTh: string };

/**
 * Strip a job sheet's expense rows down to what a non-admin may be sent.
 *
 * The row keeps its money and its description, because that is the guide's own expense
 * and they filed it. What goes is every trace of the certificate: its number, its id, the
 * reason text (which is written to NAME the certificate), and who attested it.
 */
export function redactRowsForNonAdmin<T extends Record<string, unknown>>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).map((row) => {
    const out: Record<string, unknown> = { ...row };
    if (out.evidenceWaiver && typeof out.evidenceWaiver === "object") {
      out.evidenceWaiver = { waived: true, status: NON_ADMIN_STATUS_EN, statusTh: NON_ADMIN_STATUS_TH } satisfies PublicWaiver;
    }
    for (const f of CERTIFICATE_METADATA_FIELDS) delete out[f];
    return out as T;
  });
}

/** The same, for any single object on its way out to a non-admin. */
export function redactForNonAdmin<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = { ...obj };
  for (const f of CERTIFICATE_METADATA_FIELDS) delete out[f];
  if (out.evidenceWaiver && typeof out.evidenceWaiver === "object") {
    out.evidenceWaiver = { waived: true, status: NON_ADMIN_STATUS_EN, statusTh: NON_ADMIN_STATUS_TH } satisfies PublicWaiver;
  }
  if (Array.isArray(out.expenses)) out.expenses = redactRowsForNonAdmin(out.expenses as Record<string, unknown>[]);
  return out as T;
}

/**
 * A sentence that names a certificate is itself certificate metadata.
 *
 * `linkCertificate` writes "ใบรับรองแทนใบเสร็จเลขที่ CERT-…" into the row's waiver
 * reason, and `evidenceState` builds refusal messages that quote the certificate number.
 * Both are ordinary strings by the time they reach a response, so they travel through
 * every field that was never thought of as carrying a certificate.
 */
export const CERTIFICATE_PHRASE_TH = "ใบรับรองแทนใบเสร็จ";
const NAMES_CERTIFICATE = /CERT-[A-Za-z0-9-]+|ใบรับรองแทนใบเสร็จ|certificate in lieu of a receipt/i;

export const namesCertificate = (text: unknown): boolean =>
  typeof text === "string" && NAMES_CERTIFICATE.test(text);

/** Replace any message that names a certificate with the one a guide may read. */
export function redactMessagesForNonAdmin(messages: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  let replaced = false;
  for (const m of messages ?? []) {
    if (!namesCertificate(m)) { out.push(m); continue; }
    if (!replaced) { out.push(NON_ADMIN_STATUS_TH); replaced = true; }
  }
  return out;
}

/**
 * A whole response body, with every trace of a certificate taken out of it.
 *
 * A deep walk rather than a list of fields, because the leak that actually happens is
 * not a field somebody forgot to strip — it is a SENTENCE. `linkCertificate` writes the
 * certificate number into a row's waiver reason, and the payment gate builds refusals
 * that quote it. By the time either reaches a response it is an ordinary string in an
 * ordinary `reasons` array, indistinguishable from "the guide has not filed yet" unless
 * something reads it.
 *
 * A non-admin gets the general status in its place, once per array: enough to know
 * somebody is dealing with it, and nothing about what.
 */
export function redactBodyForNonAdmin<T>(body: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return namesCertificate(v) ? NON_ADMIN_STATUS_TH : v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      let said = false;
      for (const item of v) {
        const w = walk(item);
        if (w === NON_ADMIN_STATUS_TH && typeof item === "string") {
          if (said) continue;
          said = true;
        }
        out.push(w);
      }
      return out;
    }
    if (v && typeof v === "object") {
      if (v instanceof Date) return v;
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (DROP_WHOLESALE.has(k)) continue;
        if (k === "evidenceWaiver" && val && typeof val === "object") {
          out[k] = { waived: true, status: NON_ADMIN_STATUS_EN, statusTh: NON_ADMIN_STATUS_TH } satisfies PublicWaiver;
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(body) as T;
}

/** Keys removed entirely rather than emptied, because their name alone is the answer. */
const DROP_WHOLESALE = new Set<string>([...CERTIFICATE_METADATA_FIELDS, "staleCertificates", "certificate", "certificates"]);
