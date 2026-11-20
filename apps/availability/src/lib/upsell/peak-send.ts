import type { PrismaClient } from "@prisma/client";
import * as peakApi from "@/lib/peak-api";
import { upsellPeakAdapter } from "./peak-adapter";
import { UpsellPeakRefused, resolveUncertain, sendPeakEvent, type UpsellPeakAdapter } from "./peak-outbox";
import { SettlementError } from "./settlement";

// The Admin's two PEAK actions on one upsell event, each audited. The adapter is the real one
// (lib/peak-api) unless a test passes its own; sendPeakEvent refuses while UPSELL_PEAK_AUTO_SYNC is off.

const refusedAs409 = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (e) {
    if (e instanceof UpsellPeakRefused) throw new SettlementError(409, "PEAK_EVENT", e.message);
    throw e;
  }
};

export async function adminSendPeakEvent(db: PrismaClient, admin: { userId: string }, eventId: string, adapter: UpsellPeakAdapter = upsellPeakAdapter(peakApi)) {
  const e = await refusedAs409(() => sendPeakEvent(db, adapter, eventId));
  await db.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.peak_event_sent", entityType: "UpsellPeakEvent", entityId: eventId,
    detail: { status: e.status, peakCode: e.peakCode, lastError: e.lastError } } });
  return e;
}

/** Read an UNCERTAIN event back. `peakCode` is a journal number the Admin read off PEAK — checked, never trusted. */
export async function adminResolvePeakEvent(db: PrismaClient, admin: { userId: string }, eventId: string, peakCode: string | undefined, adapter: UpsellPeakAdapter = upsellPeakAdapter(peakApi)) {
  const code = peakCode?.trim() || undefined;
  if (code && !/^[A-Za-z0-9-]{3,40}$/.test(code)) throw new SettlementError(400, "PEAK_CODE", "Enter the PEAK document number as PEAK shows it");
  const e = await refusedAs409(() => resolveUncertain(db, adapter, eventId, new Date(), { peakCode: code }));
  await db.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.peak_event_read_back", entityType: "UpsellPeakEvent", entityId: eventId,
    detail: { enteredCode: code ?? null, status: e.status, peakCode: e.peakCode, lastError: e.lastError } } });
  return e;
}
