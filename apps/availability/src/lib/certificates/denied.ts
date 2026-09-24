import { audit } from "@/lib/audit";

// Writing down that somebody was turned away, without writing down what they were
// turned away from.
//
// An audit row is read by more people than the thing it is about, and it is kept for
// years. A denial that recorded the certificate number, the Drive link or the attester
// would put the document into the one place a person who could not open the document can
// often still read — and the whole point of the refusal was that they may not see it.
//
// So this records the ATTEMPT: who, what role, which endpoint, and enough of the key to
// find the job sheet later. Never the certificate, never the file, never the signature.

/** Fields a denial row may never carry, whatever the caller passes. */
const NEVER = new Set([
  "certificateId", "certificateNo", "payloadHash", "pdfHash",
  "driveUrl", "driveFileId", "driveRevisionId", "driveMd5", "driveFolderPath", "driveAttemptToken",
  "attestedByName", "attestedByRole", "attestedByUserId", "attestedAt",
  "signatureUserId", "signatureVersion", "signatureSha256", "signatureDataUri",
  "payload", "coveredRows", "reason", "reasons",
]);

export type DeniedSession = { user?: { id?: string | null; role?: string | null } } | null;

/**
 * Record a refusal. Returns nothing and throws nothing: a failure to audit must not turn
 * a 403 into a 500, because a 500 tells the caller something a 403 does not.
 */
export async function denied(session: DeniedSession, action: string, about: Record<string, unknown> = {}): Promise<void> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(about)) {
    if (NEVER.has(k)) continue;
    // Strings are truncated rather than trusted: a job ref is short, and anything long
    // arriving here is something that was not thought about.
    safe[k] = typeof v === "string" ? v.slice(0, 64) : v;
  }
  await audit({
    actorId: session?.user?.id ?? null,
    actorRole: session?.user?.role ?? null,
    action: `certificate.access_denied`,
    entityType: "ExpenseCertificate",
    // No entity id. Naming the certificate would be telling the row which document the
    // person was not allowed to see.
    detail: {
      endpoint: action,
      ...safe,
      note: "a non-admin asked for a certificate in lieu of a receipt and was refused; what they asked about is deliberately not recorded here",
    },
  }).catch(() => {});
}
