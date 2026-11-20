// Shared by the automatic sender (lib/advances/peak-sync) and by reconciliation
// (lib/advances/peak-reconcile), so the two can never drift: how an outbox item is closed as
// POSTED, and how each attempt or decision is kept in its history (AuditLog).

import type { Prisma, PrismaClient } from "@prisma/client";

export type SyncActor = { actorId: string | null; actorRole: string | null };

/** One attempt or decision in the item's history (AuditLog, entityType AdvancePeakSync). */
export async function logSync(db: Pick<PrismaClient, "auditLog">, entityId: string, action: string, detail: Record<string, unknown>, actor?: SyncActor) {
  try {
    await db.auditLog?.create?.({ data: { actorId: actor?.actorId ?? null, actorRole: actor?.actorRole ?? "SYSTEM", action, entityType: "AdvancePeakSync", entityId, detail: detail as Prisma.InputJsonValue } });
  } catch { /* history must never stop the sender or the request */ }
}

/**
 * Close an item as POSTED against a PEAK journal, and stamp the source the same way the sender
 * always has. Shared by the sender and by "Found in PEAK", so the two can never drift.
 * `fromStatus` makes it conditional: if someone else moved the item first, nothing is written.
 */
export async function markPosted(tx: Prisma.TransactionClient, row: { id: string; kind: string; sourceId: string }, fromStatus: string, doc: { id: string | null; code: string; reference: string | null }) {
  const moved = await tx.advancePeakSync.updateMany({ where: { id: row.id, status: fromStatus }, data: { status: "POSTED", documentId: doc.id, documentNo: doc.code, error: null } });
  if (!moved.count) return false;
  if (row.kind === "ADVANCE") await tx.guideAdvance.update({ where: { id: row.sourceId }, data: { peakDocumentNo: doc.code, peakRef: doc.code, ...(doc.reference ? { peakReference: doc.reference } : {}) } });
  if (row.kind === "EXPENSE") await tx.guideAdvanceEntry.update({ where: { id: row.sourceId }, data: { peakDocumentNo: doc.code, ...(doc.reference ? { peakReference: doc.reference } : {}) } });
  return true;
}

