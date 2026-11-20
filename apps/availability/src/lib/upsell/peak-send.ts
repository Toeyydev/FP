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

/** What the Extras cash page shows of PEAK: every event that is not settled, and the last synced. */
export async function listPeakEvents(db: PrismaClient) {
  const [open, synced] = await Promise.all([
    db.upsellPeakEvent.findMany({ where: { status: { in: ["BLOCKED", "PENDING", "SENDING", "FAILED", "UNCERTAIN"] } }, orderBy: { createdAt: "asc" }, take: 200 }),
    db.upsellPeakEvent.findMany({ where: { status: "POSTED" }, orderBy: { updatedAt: "desc" }, take: 30 }),
  ]);
  const counts = Object.fromEntries((await db.upsellPeakEvent.groupBy({ by: ["status"], _count: { _all: true } })).map((g) => [g.status, g._count._all]));
  const row = (e: (typeof open)[number]) => ({ id: e.id, kind: e.eventKind, status: e.status, eventDate: e.eventDate, reference: (e.payload as { reference?: string } | null)?.reference ?? null,
    blockedReasons: e.blockedReasons, lastError: e.lastError, peakCode: e.peakCode, attempts: e.attempts, updatedAt: e.updatedAt.toISOString() });
  return { counts, rows: [...open, ...synced].map(row) };
}

/** FAILED (PEAK refused it, nothing was made) → PENDING: an explicit, audited retry; the worker sends it. */
export async function adminRetryPeakEvent(db: PrismaClient, admin: { userId: string }, eventId: string) {
  const e = await db.upsellPeakEvent.findUnique({ where: { id: eventId } });
  if (!e) throw new SettlementError(404, "NO_EVENT", "No such PEAK event");
  const done = await db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "FAILED", version: e.version }, data: { status: "PENDING", lastError: null } });
  if (done.count !== 1) throw new SettlementError(409, "PEAK_EVENT", "Only a FAILED event is retried — reload");
  await db.auditLog.create({ data: { actorId: admin.userId, actorRole: "ADMIN", action: "upsell.peak_event_retry", entityType: "UpsellPeakEvent", entityId: eventId, detail: { lastError: e.lastError } } });
  return db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
}
