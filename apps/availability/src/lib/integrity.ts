import { prisma } from "@/lib/db";
import { reconcileSheetRows, notifyOps, type SheetRow } from "@/lib/booking-import";
import { bookingRef } from "@/lib/booking-ref";
import { todayD, ymd } from "@/lib/dates";

// A read-only health check over the operator's live data. It never writes anything —
// its only job is to catch the classes of problem that silently corrupt a tour's
// paperwork or pay, chiefly a GUEST MISSING FROM A JOB SHEET, so they're surfaced
// early instead of discovered by accident on a printed job order.
export type IntegrityKind = "missing-booking" | "pax-mismatch" | "paid-before-tour" | "paid-no-proof";
export type IntegrityFinding = { kind: IntegrityKind; ref: string; detail: string };
export type IntegrityReport = { at: string; upcomingAssignments: number; checkedSheets: number; findings: IntegrityFinding[]; byKind: Record<IntegrityKind, number> };

const refKey = (r: SheetRow) => (r.bookingNo || "").trim().toLowerCase();
const refSet = (rows: SheetRow[]) => new Set(rows.map(refKey).filter(Boolean));

// Pure: a sheet finalized AFTER its month was marked paid means work was swept into a
// payment that predates it (the coveredByMonth gap) — flag for the operator to confirm.
export function finalizedAfterPaid(sheetCreatedAt: Date | string, paidAt: Date | string | null): boolean {
  if (!paidAt) return false;
  return new Date(sheetCreatedAt).getTime() > new Date(paidAt).getTime();
}

// Pure: given a saved sheet and the reconciled (correct) rows, how many guests are
// missing from the sheet and how many stale rows linger on it.
export function sheetDelta(saved: SheetRow[], reconciled: SheetRow[]): { missing: number; lingering: number } {
  const s = refSet(saved), n = refSet(reconciled);
  return { missing: [...n].filter((r) => !s.has(r)).length, lingering: [...s].filter((r) => !n.has(r)).length };
}

export async function checkIntegrity(): Promise<IntegrityReport> {
  const today = ymd(todayD());
  const findings: IntegrityFinding[] = [];

  // 1) Every upcoming sheet must match its slot's live active bookings (no missing guest).
  const assigns = await prisma.assignment.findMany({ where: { date: { gte: today } }, select: { guideId: true, date: true, slotIdx: true, pax: true } });
  let checkedSheets = 0;
  for (const a of assigns) {
    const sheet = await prisma.jobSheet.findUnique({ where: { guideId_date_slotIdx: { guideId: a.guideId, date: a.date, slotIdx: a.slotIdx } }, select: { bookings: true } });
    if (!sheet) continue;
    checkedSheets++;
    const saved = (Array.isArray(sheet.bookings) ? sheet.bookings : []) as SheetRow[];
    const all = await prisma.booking.findMany({ where: { date: a.date, slotIdx: a.slotIdx, status: { in: ["PENDING", "OFFERED", "ASSIGNED"] } }, select: { customerName: true, externalRef: true, confirmationCode: true, pax: true, assignedGuideId: true, noShow: true } });
    const split = all.some((b) => b.assignedGuideId);
    const mine = split ? all.filter((b) => !b.assignedGuideId || b.assignedGuideId === a.guideId) : all;
    const { missing, lingering } = sheetDelta(saved, reconcileSheetRows(saved, mine));
    if (missing || lingering) findings.push({ kind: "missing-booking", ref: `${a.guideId} ${a.date} slot${a.slotIdx}`, detail: `${missing} missing guest(s), ${lingering} stale row(s)` });
    const sheetPax = saved.reduce((s, r) => s + (r.bookedPax ?? 0), 0);
    if (saved.length && sheetPax !== (a.pax ?? 0)) findings.push({ kind: "pax-mismatch", ref: `${a.guideId} ${a.date} slot${a.slotIdx}`, detail: `sheet ${sheetPax} pax vs assignment ${a.pax}` });
  }

  // 2) Payment sanity on paid months: work finalized after payment, and paid-with-no-proof.
  const paid = await prisma.payrollStatus.findMany({ where: { status: "paid" }, select: { guideId: true, period: true, paidAt: true, eslipUrl: true } });
  const monthEslip = new Map(paid.map((s) => [`${s.guideId}|${s.period}`, s.eslipUrl] as const));
  for (const st of paid) {
    const sheets = await prisma.jobSheet.findMany({ where: { guideId: st.guideId, date: { gte: `${st.period}-01`, lte: `${st.period}-31` } }, select: { date: true, slotIdx: true, ref: true, createdAt: true } });
    for (const s of sheets) if (finalizedAfterPaid(s.createdAt, st.paidAt)) findings.push({ kind: "paid-before-tour", ref: `${st.guideId} ${s.date} slot${s.slotIdx}`, detail: `${s.ref ?? "sheet"} finalized after the month was paid` });
  }
  const paidTours = await prisma.tourPayment.findMany({ where: { status: "PAID" }, select: { guideId: true, date: true, slotIdx: true, eslipUrl: true, peakRef: true } });
  for (const p of paidTours) {
    if (!p.eslipUrl && !p.peakRef && !monthEslip.get(`${p.guideId}|${p.date.slice(0, 7)}`)) findings.push({ kind: "paid-no-proof", ref: `${p.guideId} ${p.date} slot${p.slotIdx}`, detail: "marked paid with no e-slip and no PEAK ref" });
  }

  const byKind = { "missing-booking": 0, "pax-mismatch": 0, "paid-before-tour": 0, "paid-no-proof": 0 } as Record<IntegrityKind, number>;
  for (const f of findings) byKind[f.kind]++;
  return { at: new Date().toISOString(), upcomingAssignments: assigns.length, checkedSheets, findings, byKind };
}

// Background monitor: run the check at most once per day (deduped across replicas via
// the audit log), and alert operators when anything is off — leading with any missing
// booking, since that's the one that costs a guest on the day. Best-effort; never throws.
const DAY_MS = 24 * 3600_000;
export async function runIntegrityMonitor(force = false): Promise<IntegrityReport | null> {
  try {
    if (!force) {
      const recent = await prisma.auditLog.findFirst({ where: { action: "integrity.check", createdAt: { gte: new Date(Date.now() - DAY_MS) } }, select: { id: true } });
      if (recent) return null;
    }
    const report = await checkIntegrity();
    await prisma.auditLog.create({ data: { action: "integrity.check", entityType: "JobSheet", detail: { byKind: report.byKind, checkedSheets: report.checkedSheets } } });
    if (report.findings.length) {
      const b = report.byKind;
      const parts = [
        b["missing-booking"] && `${b["missing-booking"]} sheet(s) missing a guest`,
        b["pax-mismatch"] && `${b["pax-mismatch"]} pax mismatch(es)`,
        b["paid-before-tour"] && `${b["paid-before-tour"]} paid-before-tour`,
        b["paid-no-proof"] && `${b["paid-no-proof"]} paid with no slip`,
      ].filter(Boolean).join(" · ");
      const push = b["missing-booking"] > 0; // a missing guest is actionable now; the rest are review-later
      await notifyOps(`Integrity check: ${parts}. Open the health check to review.`, "⚠️ Data check found issues", parts, { push });
    }
    return report;
  } catch { return null; }
}
