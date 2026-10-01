// What an accountant needs to approve a refund of an excess return — and nothing else.
//
// Owner policy 2026-10-01: the ACCOUNTANT is the financial checker for advance refunds and may
// only APPROVE one (app/api/advances/refunds/[id]/approve). They get this packet instead of
// the operational job sheet: the refund, the return it pays back, the advance that return
// cleared, the job's number and date, the evidence (bank references and slips), who did what
// and when, and the PEAK state. No guest data, no expense rows, no payer or guide notes.
import type { PrismaClient } from "@prisma/client";
import { advanceSyncStates } from "@/lib/advances/peak-sync";
import { summariesFor } from "@/lib/advances/summaries";
import { fromSatang } from "@/lib/advances/rules";
import { returnSummary } from "@/lib/advances/returns";

export type RefundReview = {
  id: string; refundNo: string; status: string; amount: number; reason: string;
  bankRef: string | null; slipUrl: string | null; paidAt: Date | null; voidReason: string | null;
  recordedById: string; recordedBy: string | null; recordedAt: Date;
  approvedBy: string | null; approvedAt: Date | null; paidBy: string | null;
  guide: { guideId: string; name: string | null };
  job: { ref: string | null; date: string; slotIdx: number } | null;
  receipt: { receiptNo: string; status: string; receivedDate: string; amount: number; allocated: number; refunded: number; unallocated: number; bankRef: string | null; slipUrl: string | null; peak: { status: string; documentNo: string | null } | null };
  advances: { advanceNo: string; issued: number; used: number; returned: number; deducted: number; outstanding: number; status: string | null; allocatedFromThisReturn: number; slipUrl: string | null; peak: { status: string; documentNo: string | null } | null }[];
  history: { action: string; by: string | null; role: string | null; at: Date }[];
};

const ACTION_LABEL: Record<string, string> = {
  "advance.refund_recorded": "Recorded", "advance.refund_approved": "Approved",
  "advance.refund_paid": "Paid", "advance.refund_voided": "Voided",
};

export async function refundReviews(db: PrismaClient, where: { status?: string } = {}): Promise<RefundReview[]> {
  const refunds = await db.guideAdvanceRefund.findMany({ where: where.status ? { status: where.status } : {}, orderBy: { createdAt: "desc" }, take: 200 });
  if (!refunds.length) return [];
  const receipts = await db.guideAdvanceReceipt.findMany({ where: { id: { in: [...new Set(refunds.map((f) => f.receiptId))] } } });
  const [entries, allRefunds] = await Promise.all([
    db.guideAdvanceEntry.findMany({ where: { receiptId: { in: receipts.map((r) => r.id) } }, select: { id: true, receiptId: true, advanceId: true, type: true, amountSatang: true, reversesEntryId: true } }),
    db.guideAdvanceRefund.findMany({ where: { receiptId: { in: receipts.map((r) => r.id) } }, select: { receiptId: true, status: true, amountSatang: true } }),
  ]);
  // The advances a return touched: the one it was linked to, and every one it was allocated to.
  const advanceIds = [...new Set([...receipts.map((r) => r.advanceId), ...entries.map((e) => e.advanceId)].filter((x): x is string => !!x))];
  const advances = advanceIds.length ? await db.guideAdvance.findMany({ where: { id: { in: advanceIds } } }) : [];
  const summaries = await summariesFor(db, advances);
  const sheetIds = receipts.map((r) => r.jobSheetId).filter((x): x is string => !!x);
  const sheets = await db.jobSheet.findMany({
    where: { OR: [...(sheetIds.length ? [{ id: { in: sheetIds } }] : []), ...advances.map((a) => ({ guideId: a.guideId, date: a.date, slotIdx: a.slotIdx }))] },
    select: { id: true, ref: true, guideId: true, date: true, slotIdx: true },
  });
  const audits = await db.auditLog.findMany({ where: { entityType: "GuideAdvanceRefund", entityId: { in: refunds.map((f) => f.id) } }, orderBy: { createdAt: "asc" }, select: { entityId: true, action: true, actorId: true, actorRole: true, createdAt: true } });
  const userIds = [...new Set([...refunds.flatMap((f) => [f.recordedById, f.approvedById, f.paidById]), ...audits.map((a) => a.actorId)].filter((x): x is string => !!x))];
  const guideIds = [...new Set(refunds.map((f) => f.guideId))];
  const users = await db.user.findMany({ where: { OR: [{ id: { in: userIds } }, { guideId: { in: guideIds } }] }, select: { id: true, guideId: true, displayName: true, fullName: true } });
  const nameOf = (id: string | null) => { const u = id ? users.find((x) => x.id === id) : undefined; return u ? (u.fullName || u.displayName || null) : null; };
  const sync = await advanceSyncStates(db, [...receipts.map((r) => `RETURN:${r.id}`), ...advances.map((a) => `ADVANCE:${a.id}`)]);
  const peak = (key: string) => { const s = sync.get(key); return s ? { status: s.status, documentNo: s.documentNo } : null; };

  return refunds.map((f) => {
    const r = receipts.find((x) => x.id === f.receiptId)!;
    const rs = returnSummary(r, entries.filter((e) => e.receiptId === r.id), allRefunds.filter((x) => x.receiptId === r.id));
    const touched = advances.filter((a) => a.id === r.advanceId || entries.some((e) => e.receiptId === r.id && e.advanceId === a.id));
    const home = advances.find((a) => a.id === r.advanceId) ?? touched[0];
    const sheet = sheets.find((s) => s.id === r.jobSheetId) ?? (home ? sheets.find((s) => s.guideId === home.guideId && s.date === home.date && s.slotIdx === home.slotIdx) : undefined);
    const guideUser = users.find((u) => u.guideId === f.guideId);
    return {
      id: f.id, refundNo: f.refundNo, status: f.status, amount: fromSatang(f.amountSatang), reason: f.reason,
      bankRef: f.bankRef, slipUrl: f.slipUrl, paidAt: f.paidAt, voidReason: f.voidReason,
      recordedById: f.recordedById, recordedBy: nameOf(f.recordedById), recordedAt: f.recordedAt,
      approvedBy: nameOf(f.approvedById), approvedAt: f.approvedAt, paidBy: nameOf(f.paidById),
      guide: { guideId: f.guideId, name: guideUser ? (guideUser.fullName || guideUser.displayName || null) : null },
      job: sheet ? { ref: sheet.ref, date: sheet.date, slotIdx: sheet.slotIdx } : home ? { ref: null, date: home.date, slotIdx: home.slotIdx } : null,
      receipt: {
        receiptNo: r.receiptNo, status: r.status, receivedDate: r.receivedDate,
        amount: fromSatang(rs.amount), allocated: fromSatang(rs.allocated), refunded: fromSatang(rs.refunded), unallocated: fromSatang(rs.unallocated),
        bankRef: r.bankRef, slipUrl: r.slipUrl, peak: peak(`RETURN:${r.id}`),
      },
      advances: touched.map((a) => {
        const s = summaries.get(a.id);
        const here = entries.filter((e) => e.receiptId === r.id && e.advanceId === a.id).reduce((t, e) => t + e.amountSatang, 0);
        return {
          advanceNo: a.advanceNo, issued: fromSatang(s?.issued ?? a.amountSatang), used: fromSatang(s?.used ?? 0), returned: fromSatang(s?.returned ?? 0),
          deducted: fromSatang(s?.deducted ?? 0), outstanding: fromSatang(s?.outstanding ?? 0), status: s?.status ?? null,
          allocatedFromThisReturn: fromSatang(here), slipUrl: a.slipUrl, peak: peak(`ADVANCE:${a.id}`),
        };
      }),
      history: audits.filter((a) => a.entityId === f.id).map((a) => ({ action: ACTION_LABEL[a.action] ?? a.action, by: nameOf(a.actorId), role: a.actorRole, at: a.createdAt })),
    };
  });
}
