// Who already owns a PEAK document number — one canonical answer for every advance link.
//
// Phase 1E (owner 2026-10-02): a PEAK document must never be silently attached to two
// incompatible financial events. FolkOPS records PEAK numbers in many places; this reads
// all of them, so a link is refused by naming the existing owner instead of creating a
// second claim on the same document.
//
// Phase 1 policy (owner decision 2026-10-02): ONE canonical financial owner per PEAK
// document. No event may share a document with another — not because they are the same
// job, the same guide, the same month, or add up to the same total. A settlement does not
// share its job's guide-payment document; an advance issue or return shares with nothing.
//
// Future (out of scope for Phase 1): if the accountant confirms that one PEAK document
// should intentionally carry several FolkOPS events, that needs a proper composite-
// document model — explicit line ownership, event-specific amounts, exact reconciliation
// and no double recognition — never a document-number exception added back here.
import type { PrismaClient } from "@prisma/client";

export type OwnerDomain =
  | "ADVANCE_ISSUE" | "ADVANCE_SETTLEMENT" | "ADVANCE_RETURN"
  | "JOB_SHEET" | "GUIDE_PAYMENT" | "COMBINED_PAYMENT" | "PAYMENT_TRANSACTION" | "SUPPLEMENTAL_PAYMENT" | "PAYROLL";
export type PeakOwner = { domain: OwnerDomain; id: string; label: string; job?: { guideId: string; date: string; slotIdx: number } | null; jobs?: { date: string; slotIdx: number }[]; guideId?: string | null };

const LABEL: Record<OwnerDomain, string> = {
  ADVANCE_ISSUE: "an advance issue", ADVANCE_SETTLEMENT: "an advance expense settlement", ADVANCE_RETURN: "a guide's advance return",
  JOB_SHEET: "a job sheet's expense document", GUIDE_PAYMENT: "a guide payment", COMBINED_PAYMENT: "a combined guide payment",
  PAYMENT_TRANSACTION: "a recorded payment transfer", SUPPLEMENTAL_PAYMENT: "a supplemental guide payment", PAYROLL: "a payroll run",
};
export const describeOwner = (o: PeakOwner) => `${LABEL[o.domain]} (${o.label})`;

/** Every record that names this document number. Reads only. */
export async function peakDocumentOwners(db: PrismaClient, documentNo: string): Promise<PeakOwner[]> {
  const no = documentNo.trim().toUpperCase();
  const eq = { equals: no, mode: "insensitive" as const };
  const [links, advances, receipts, entries, sheets, tourPays, payJobs, payDocs, txs, supps, payrolls] = await Promise.all([
    db.advancePeakDocumentLink.findMany({ where: { documentNo: eq } }),
    db.guideAdvance.findMany({ where: { OR: [{ peakDocumentNo: eq }, { peakRef: eq }] }, select: { id: true, advanceNo: true, guideId: true } }),
    db.guideAdvanceReceipt.findMany({ where: { peakDocumentNo: eq }, select: { id: true, receiptNo: true, guideId: true } }),
    db.guideAdvanceEntry.findMany({ where: { peakDocumentNo: eq, type: "EXPENSE_SETTLEMENT" }, select: { id: true, jobNo: true, advanceId: true } }),
    db.jobSheet.findMany({ where: { peakDocumentNo: eq }, select: { id: true, ref: true, guideId: true, date: true, slotIdx: true } }),
    db.tourPayment.findMany({ where: { peakRef: eq }, select: { id: true, guideId: true, date: true, slotIdx: true } }),
    db.guidePaymentJob.findMany({ where: { peakDocumentNo: eq }, select: { id: true, guideId: true, date: true, slotIdx: true } }),
    db.guidePaymentDocument.findMany({ where: { peakDocumentNo: eq }, select: { id: true, paymentRef: true, guideId: true, jobs: true } }),
    db.paymentTransaction.findMany({ where: { peakExpenseNo: eq }, select: { id: true } }),
    db.supplementalPayment.findMany({ where: { peakRef: eq }, select: { id: true, guideId: true, type: true } }),
    db.payrollStatus.findMany({ where: { peakRef: eq }, select: { id: true, guideId: true, period: true } }),
  ]);
  const out: PeakOwner[] = [];
  const seen = new Set<string>();
  const add = (o: PeakOwner) => { const k = `${o.domain}:${o.id}`; if (!seen.has(k)) { seen.add(k); out.push(o); } };
  for (const a of advances) add({ domain: "ADVANCE_ISSUE", id: a.id, label: a.advanceNo, guideId: a.guideId });
  for (const r of receipts) add({ domain: "ADVANCE_RETURN", id: r.id, label: r.receiptNo, guideId: r.guideId });
  for (const e of entries) add({ domain: "ADVANCE_SETTLEMENT", id: e.id, label: e.jobNo ?? "settlement" });
  // Links last, so a movement already named above keeps its own number as its label.
  for (const l of links) add({ domain: l.kind === "ADVANCE" ? "ADVANCE_ISSUE" : l.kind === "RETURN" ? "ADVANCE_RETURN" : "ADVANCE_SETTLEMENT", id: l.sourceId, label: `linked ${l.documentType.toLowerCase().replace("_", " ")}` });
  for (const s of sheets) add({ domain: "JOB_SHEET", id: s.id, label: s.ref ?? `${s.guideId} ${s.date}`, job: { guideId: s.guideId, date: s.date, slotIdx: s.slotIdx }, guideId: s.guideId });
  for (const p of tourPays) add({ domain: "GUIDE_PAYMENT", id: p.id, label: `${p.guideId} ${p.date}`, job: { guideId: p.guideId, date: p.date, slotIdx: p.slotIdx }, guideId: p.guideId });
  for (const p of payJobs) add({ domain: "GUIDE_PAYMENT", id: p.id, label: `${p.guideId} ${p.date}`, job: { guideId: p.guideId, date: p.date, slotIdx: p.slotIdx }, guideId: p.guideId });
  for (const d of payDocs) {
    const jobs = (Array.isArray(d.jobs) ? d.jobs : []) as { date?: string; slotIdx?: number }[];
    add({ domain: "COMBINED_PAYMENT", id: d.id, label: d.paymentRef, guideId: d.guideId, jobs: jobs.filter((j) => j.date != null).map((j) => ({ date: String(j.date), slotIdx: Number(j.slotIdx) })) });
  }
  for (const t of txs) add({ domain: "PAYMENT_TRANSACTION", id: t.id, label: "payment transfer" });
  for (const s of supps) add({ domain: "SUPPLEMENTAL_PAYMENT", id: s.id, label: `${s.guideId} ${s.type.toLowerCase()}`, guideId: s.guideId });
  for (const p of payrolls) add({ domain: "PAYROLL", id: p.id, label: `${p.guideId} ${p.period}`, guideId: p.guideId });
  return out;
}

export type LinkEvent =
  | { kind: "ADVANCE"; sourceId: string }
  | { kind: "RETURN"; sourceId: string }
  | { kind: "EXPENSE"; sourceId: string; job: { sheetId: string; guideId: string; date: string; slotIdx: number } };

const SELF: Record<LinkEvent["kind"], OwnerDomain> = { ADVANCE: "ADVANCE_ISSUE", RETURN: "ADVANCE_RETURN", EXPENSE: "ADVANCE_SETTLEMENT" };

/** Every owner other than this event itself — empty when the link may proceed. No exceptions in Phase 1. */
export function incompatibleOwners(owners: readonly PeakOwner[], event: LinkEvent): PeakOwner[] {
  // The event's own record (a replay, or the same movement's own field) is not a clash.
  return owners.filter((o) => !(o.domain === SELF[event.kind] && o.id === event.sourceId));
}
