// Which jobs still need a certificate in lieu of receipt — across every job, both kinds.
//
// The historical evidence campaign (lib/historical-evidence) covers jobs before its cutoff
// and decides much more. This is the plain working list an admin asked for: a job with
// rows that need a certificate (lib/certificates/payload certifiableRows — the same rule
// the job sheet's panel uses) and no LINKED certificate of that kind yet. Read-only.
import type { PrismaClient } from "@prisma/client";
import type { Expense } from "@/lib/jobsheet";
import { certifiableRows, type CertificateKind } from "@/lib/certificates/payload";

export type OutstandingState = "NOT_ISSUED" | "IN_PROGRESS";
export type OutstandingJob = {
  jobRef: string | null; guideId: string; date: string; slotIdx: number; tourName: string | null;
  kind: CertificateKind; rows: number; totalSatang: number; approved: boolean;
  state: OutstandingState; certificateNo: string | null; certificateStatus: string | null;
};

type Sheet = { id: string; ref: string | null; guideId: string; date: string; slotIdx: number; tourId: string | null; expenses: unknown; approvalStatus: string | null };
type Cert = { jobSheetId: string; kind: string; status: string; certificateNo: string };

/** Pure: the outstanding list from sheets, tour names and certificates. */
export function outstandingCertificates(sheets: Sheet[], tourNames: Map<string, string>, certs: Cert[]): OutstandingJob[] {
  const byKey = new Map<string, Cert>();
  for (const c of certs) if (c.status !== "VOID") byKey.set(`${c.jobSheetId}|${c.kind === "COMPANY_ADVANCE" ? "COMPANY_ADVANCE" : "GUIDE_PAID"}`, c);
  const out: OutstandingJob[] = [];
  for (const s of sheets) {
    const tourName = s.tourId ? tourNames.get(s.tourId) ?? null : null;
    const expenses = (Array.isArray(s.expenses) ? s.expenses : []) as Expense[];
    for (const kind of ["GUIDE_PAID", "COMPANY_ADVANCE"] as const) {
      const rows = certifiableRows(expenses, kind, { tourName });
      if (!rows.length) continue;
      const live = byKey.get(`${s.id}|${kind}`);
      if (live?.status === "LINKED") continue;
      out.push({
        jobRef: s.ref, guideId: s.guideId, date: s.date, slotIdx: s.slotIdx, tourName, kind,
        rows: rows.length, totalSatang: rows.reduce((t, r) => t + r.amountSatang, 0), approved: s.approvalStatus === "APPROVED",
        state: live ? "IN_PROGRESS" : "NOT_ISSUED", certificateNo: live?.certificateNo ?? null, certificateStatus: live?.status ?? null,
      });
    }
  }
  return out.sort((a, b) => (a.state === b.state ? b.date.localeCompare(a.date) : a.state === "NOT_ISSUED" ? -1 : 1));
}

export async function readOutstandingCertificates(db: PrismaClient): Promise<OutstandingJob[]> {
  const [sheets, tours, certs] = await Promise.all([
    db.jobSheet.findMany({ select: { id: true, ref: true, guideId: true, date: true, slotIdx: true, tourId: true, expenses: true, approvalStatus: true } }),
    db.tour.findMany({ select: { id: true, name: true } }),
    db.expenseCertificate.findMany({ select: { jobSheetId: true, kind: true, status: true, certificateNo: true } }),
  ]);
  return outstandingCertificates(sheets, new Map(tours.map((t) => [t.id, t.name])), certs);
}
