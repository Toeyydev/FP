// Who is authorised to put their name — and their hand — on a certificate.
//
// Two different permissions live near each other here and must not be run together:
//
//   SEEING a certificate      the ADMIN role, and nothing else. No list, no addresses.
//   ATTESTING one, and
//   registering the signature the people actually authorised to do it
//
// Conflating them would mean an admin left off a list quietly losing the ability to open
// documents they are entitled to read — a permission failure that looks like a bug and
// gets "fixed" by widening the list until it means nothing.
//
// So this decides one thing: may this person attest, and may they register or replace a
// signature. It never decides who can read.
//
// OPT-IN, deliberately. Unset, any ADMIN may attest, which is what the deployment does
// today and what it did before this file existed — merging must not stop a working
// feature. Set, only these addresses may, and every other admin goes on reading
// certificates exactly as before.
//
// This is not segregation of duties and must not grow into it. One authorised person
// prepares and attests the same certificate; that is the arrangement the company has.

/** The addresses authorised to attest, lower-cased. Empty means "any admin". */
export function configuredAttesters(): string[] {
  return (process.env.CERTIFICATE_ATTESTER_EMAILS ?? "")
    .split(/[,\s;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Whether an allowlist is in force at all. */
export const attesterListInForce = () => configuredAttesters().length > 0;

export type AttesterIdentity = { role?: string | null; email?: string | null };

/**
 * May this person attest a certificate, or change the signature that goes on one?
 *
 * The role comes first and is never optional: an allowlist is a narrowing of ADMIN, not
 * a way around it. Somebody listed here who is not an admin may do nothing.
 */
export function mayAttest(who: AttesterIdentity): boolean {
  if (who.role !== "ADMIN") return false;
  const list = configuredAttesters();
  if (!list.length) return true;
  const email = (who.email ?? "").trim().toLowerCase();
  return Boolean(email) && list.includes(email);
}

/** Why they may not, in words they can act on. */
export function attesterRefusal(who: AttesterIdentity): string | null {
  if (mayAttest(who)) return null;
  if (who.role !== "ADMIN") return "Only an admin can certify a document in lieu of a receipt.";
  return "This account is not one of the people authorised to certify documents or to change the signature that appears on them. Reading certificates is unaffected.";
}
