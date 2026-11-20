// The certificate in lieu of a receipt, carried along by approving the job sheet.
//
// Owner decision 2026-11-01. Approving prepares what it can; a person still stands behind
// every attestation:
//   - the authorised attester approves → drafted, attested, filed and linked in one click,
//     and the Approve button says so before it is pressed
//   - anybody else approves → a draft waits for the attester. Their name is never put on a
//     document by somebody else's click, and every step below re-checks that.
// Only a job the guide reported on their own account: an admin-recorded certificate needs
// a person to say where the rows came from (createCertificate), so it stays by hand.
// Nothing here may undo an approval: whatever stops is reported and left for a person.
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Expense } from "@/lib/jobsheet";
import { mayAttest } from "@/lib/certificates/attester";
import { certifiableRows, type CertificateKind } from "@/lib/certificates/payload";
import { transferSlipFileIds } from "@/lib/certificates/receipt-kind";
import { attestCertificate, CertificateRefused, createCertificate, linkCertificate, uploadCertificate, type Actor, type Deps } from "@/lib/certificates/service";

type Key = { guideId: string; date: string; slotIdx: number };
const KINDS: CertificateKind[] = ["GUIDE_PAID", "COMPANY_ADVANCE"];

export type AutoCertificate = { kind: CertificateKind; certificateNo: string | null; status: string; totalSatang: number; stopped: string | null };

/** What approving this sheet would certify: one entry per kind with rows and no live certificate. */
export async function certificatesDue(key: Key, db = prisma): Promise<{ kind: CertificateKind; totalSatang: number }[]> {
  const sheet = await db.jobSheet.findUnique({ where: { guideId_date_slotIdx: key }, select: { id: true, tourId: true, expenses: true, guideExpensesAt: true } });
  if (!sheet?.guideExpensesAt) return [];
  const expenses = (sheet.expenses as unknown as Expense[]) ?? [];
  const tourName = sheet.tourId ? (await db.tour.findUnique({ where: { id: sheet.tourId }, select: { name: true } }))?.name ?? null : null;
  const slips = await transferSlipFileIds(db, expenses);
  const out: { kind: CertificateKind; totalSatang: number }[] = [];
  for (const kind of KINDS) {
    const rows = certifiableRows(expenses, kind, { tourName, tourId: sheet.tourId, transferSlipFileIds: slips });
    if (!rows.length) continue;
    if (await db.expenseCertificate.findUnique({ where: { activeJobSheetId_kind: { activeJobSheetId: sheet.id, kind } }, select: { id: true } })) continue;
    out.push({ kind, totalSatang: rows.reduce((s, r) => s + r.amountSatang, 0) });
  }
  return out;
}

/** Whether this signed-in user's approval attests, read from the database as attestation does. */
export async function actorMayAttest(actor: Pick<Actor, "id" | "role">, db = prisma): Promise<boolean> {
  const me = actor.id ? await db.user.findUnique({ where: { id: actor.id }, select: { email: true, role: true } }) : null;
  return mayAttest({ role: me?.role ?? actor.role, email: me?.email });
}

export async function certificatesOnApproval(key: Key, actor: Actor, deps: Deps = {}): Promise<AutoCertificate[]> {
  const db = deps.db ?? prisma;
  const out: AutoCertificate[] = [];
  const attester = await actorMayAttest(actor, db as typeof prisma);
  for (const { kind, totalSatang } of await certificatesDue(key, db as typeof prisma)) {
    let certificateNo: string | null = null;
    let status = "NOT_CREATED";
    try {
      const made = await createCertificate(key, actor, deps, "GUIDE_REPORTED", kind);
      ({ certificateNo, status } = made);
      if (attester) {
        ({ status } = await attestCertificate(made.id, actor, deps));
        ({ status } = await uploadCertificate(made.id, actor, deps));
        ({ status } = await linkCertificate(made.id, actor, deps));
      }
      out.push({ kind, certificateNo, status, totalSatang, stopped: null });
    } catch (e) {
      const why = e instanceof CertificateRefused ? e.reasons[0] ?? "Refused" : "The certificate step failed";
      out.push({ kind, certificateNo, status, totalSatang, stopped: why });
      await audit({ actorId: actor.id, actorRole: actor.role, action: "certificate.auto_stopped", entityType: "JobSheet", detail: { ...key, kind, certificateNo, status, why } }).catch(() => {});
    }
  }
  return out;
}
