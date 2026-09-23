import type { ExpenseCertificate } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Expense } from "@/lib/jobsheet";
import { certificateIdsIn } from "@/lib/certificates/evidence";
import { checkFiledDocument, type Deps } from "@/lib/certificates/service";

// The last look at a certificate before money moves.
//
// A document can be linked, correct, and still not be what it was by the time somebody
// presses Mark Paid — Drive is a shared folder that people have hands in, and the gap
// between linking and paying can be days. So the file is fetched and hashed again here,
// rather than trusting a check that passed at some earlier point.
//
// A certificate whose document has changed is not merely refused for this payment: it is
// marked STALE, so every screen stops treating it as evidence and the operator is told
// what to do about it. Leaving it LINKED would mean the next person to look sees a
// document that says it is in force, backing rows whose evidence is gone.

export type EvidenceGate = { ok: boolean; reasons: string[]; stale: string[] };

/** Certificates any of these rows lean on, in the order they were named. */
async function certificatesFor(rowsets: readonly (readonly Expense[])[]): Promise<ExpenseCertificate[]> {
  const ids = [...new Set(rowsets.flatMap((rows) => certificateIdsIn(rows)))];
  if (!ids.length) return [];
  return prisma.expenseCertificate.findMany({ where: { id: { in: ids } } });
}

/**
 * Check every certificate these rows rely on, against what is actually in Drive.
 *
 * Read-only about the payment, and deliberately not read-only about a certificate that
 * has gone bad: that one is marked STALE and audited, because the whole point of
 * noticing is that nobody relies on it again.
 */
export async function checkEvidenceBeforePaying(
  rowsets: readonly (readonly Expense[])[],
  actor: { actorId?: string | null; actorRole?: string | null },
  deps: Deps = {},
): Promise<EvidenceGate> {
  const certs = await certificatesFor(rowsets);
  const reasons: string[] = [];
  const stale: string[] = [];

  for (const cert of certs) {
    if (cert.status === "VOID") {
      reasons.push(`${cert.certificateNo} was withdrawn, so the rows it covered have nothing behind them. Issue a new certificate before paying.`);
      continue;
    }
    if (cert.status === "STALE") {
      reasons.push(`${cert.certificateNo} is marked as no longer matching its document. File it again before paying.`);
      continue;
    }
    if (cert.status !== "LINKED") {
      reasons.push(`${cert.certificateNo} is not in use as evidence yet (${cert.status}). Finish filing and linking it before paying.`);
      continue;
    }
    const check = await checkFiledDocument(cert, deps, actor.actorId ?? undefined);
    if (check.ok) continue;

    // Only from LINKED, and only when the DOCUMENT is the problem — a Drive outage is
    // not a reason to mark a certificate bad.
    if (check.action === "drive_changed" || check.action === "drive_overwritten" || check.action === "drive_duplicate") {
      const marked = await prisma.expenseCertificate.updateMany({ where: { id: cert.id, status: "LINKED" }, data: { status: "STALE" } });
      if (marked.count) {
        stale.push(cert.certificateNo);
        await audit({
          actorId: actor.actorId ?? null, actorRole: actor.actorRole ?? null,
          action: "certificate.marked_stale", entityType: "ExpenseCertificate", entityId: cert.id,
          detail: { certificateNo: cert.certificateNo, jobRef: cert.jobRef, why: check.action, reasons: check.reasons,
            recordedFileId: cert.driveFileId, recordedPdfHash: cert.pdfHash, recordedRevisionId: cert.driveRevisionId,
            note: "found at Mark Paid; the rows it covered are no longer evidenced until it is filed again" },
        });
      }
    }
    reasons.push(`${cert.certificateNo}: ${check.reasons.join(" ")}`);
  }

  return { ok: reasons.length === 0, reasons, stale };
}
