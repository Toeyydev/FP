// The automatic upsell → PEAK sender (owner: ops.folkpaths.com → PEAK, automatic, no manual
// duplicate entry). Run by the payment worker on every tick; a no-op while UPSELL_PEAK_AUTO_SYNC
// is off. Each business action (a sale, a confirmed hand-in, a reversal) records its event in its
// own transaction; this sends what is ready, in order, and never twice:
//
//   1. a sender that died mid-send is found by its expired lease → UNCERTAIN (never resent);
//   2. BLOCKED events are re-checked against today's mapping AND the events they depend on;
//   3. PENDING events whose prerequisites are in PEAK are sent through the adapter (lease + CAS);
//      one whose prerequisite is not in PEAK goes back to BLOCKED with that reason shown;
//   4. UNCERTAIN events are read back — found → POSTED; anything else stays UNCERTAIN for an
//      Admin. The worker never turns an UNCERTAIN event back into a send.

import type { PrismaClient } from "@prisma/client";
import { upsellPeakAutoSyncEnabled } from "./flags";
import { ABSENCE_GRACE_MS, recheckBlocked, recoverExpiredLeases, resolveUncertain, sendPeakEvent, type UpsellPeakAdapter, type UpsellPeakEventKind } from "./peak-outbox";

const BATCH = 20;
/** How often one UNCERTAIN event is asked about again (each read-back is a PEAK GET). */
export const READ_BACK_EVERY_MS = ABSENCE_GRACE_MS;

type Ev = { id: string; eventKind: string; payload: unknown };

/**
 * What must already be in PEAK before this event may go, as reasons (empty = ready).
 * The receipt puts the cash into "guide cash held": clearing that cash, recognising its revenue,
 * or cancelling / refunding the sale before the receipt exists would leave PEAK with a movement
 * that explains nothing.
 */
export async function dependencyReasons(db: PrismaClient, e: Ev): Promise<string[]> {
  const kind = e.eventKind as UpsellPeakEventKind;
  if (kind === "RECEIPT") return [];
  const p = (e.payload ?? {}) as { saleId?: string; saleRefs?: string[] };
  const sales = kind === "BANK_CLEARING"
    ? await db.upsellSale.findMany({ where: { saleNo: { in: p.saleRefs ?? [] } }, select: { id: true, saleNo: true } })
    : p.saleId ? await db.upsellSale.findMany({ where: { id: p.saleId }, select: { id: true, saleNo: true } }) : [];
  if (kind === "BANK_CLEARING" && sales.length !== (p.saleRefs ?? []).length) return ["A sale this hand-in covers is missing — reconcile before PEAK"];
  if (kind !== "BANK_CLEARING" && !sales.length) return ["The sale this event belongs to is missing"];
  const receipts = await db.upsellPeakEvent.findMany({ where: { eventKind: "RECEIPT", sourceTable: "UpsellSale", sourceId: { in: sales.map((s) => s.id) } }, select: { sourceId: true, status: true } });
  const status = new Map(receipts.map((r) => [r.sourceId, r.status]));
  return sales.filter((s) => status.get(s.id) !== "POSTED").map((s) => `Waits for the PEAK receipt of ${s.saleNo} (${status.get(s.id) ?? "not recorded"})`);
}

export type UpsellSyncResult = { skipped: true } | { recovered: number; rechecked: number; sent: number; posted: number; failed: number; uncertain: number; waiting: number; readBack: number; errors: number };

export async function syncUpsellPeakBatch(db: PrismaClient, adapter: UpsellPeakAdapter, now = new Date()): Promise<UpsellSyncResult> {
  if (!upsellPeakAutoSyncEnabled()) return { skipped: true };
  const r = { recovered: 0, rechecked: 0, sent: 0, posted: 0, failed: 0, uncertain: 0, waiting: 0, readBack: 0, errors: 0 };
  r.recovered = await recoverExpiredLeases(db, now);

  for (const e of await db.upsellPeakEvent.findMany({ where: { status: "BLOCKED" }, orderBy: { createdAt: "asc" }, take: BATCH })) {
    try {
      const after = await recheckBlocked(db, e.id, undefined, await dependencyReasons(db, e));
      if (after.status === "PENDING") r.rechecked++;
    } catch { r.errors++; }
  }

  // Oldest first: a sale's receipt is always recorded before anything that depends on it.
  for (const e of await db.upsellPeakEvent.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: BATCH })) {
    try {
      const waits = await dependencyReasons(db, e);
      if (waits.length) {
        await db.upsellPeakEvent.updateMany({ where: { id: e.id, status: "PENDING", version: e.version }, data: { status: "BLOCKED", blockedReasons: waits } });
        r.waiting++;
        continue;
      }
      const after = await sendPeakEvent(db, adapter, e.id, now);
      r.sent++;
      if (after.status === "POSTED") r.posted++;
      else if (after.status === "FAILED") r.failed++;
      else if (after.status === "UNCERTAIN") r.uncertain++;
    } catch { r.errors++; }
  }

  const due = new Date(now.getTime() - READ_BACK_EVERY_MS);
  for (const e of await db.upsellPeakEvent.findMany({ where: { status: "UNCERTAIN", updatedAt: { lt: due } }, orderBy: { createdAt: "asc" }, take: BATCH })) {
    try {
      const after = await resolveUncertain(db, adapter, e.id, now, { requeueOnAbsence: false });
      r.readBack++;
      if (after.status === "POSTED") r.posted++;
    } catch { r.errors++; }
  }
  return r;
}
