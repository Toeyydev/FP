import type { Prisma, PrismaClient } from "@prisma/client";
import { upsellPeakAutoSyncEnabled } from "./flags";
import { REVENUE_CATEGORY_LABEL } from "./catalog";

// What PEAK must receive for Tour Upsell, written as an event IN THE SAME TRANSACTION as the
// business event it records (owner + Codex, 20 Nov 2026). Three distinct things, never merged:
//
//   RECEIPT              the guest paid (cash to the guide): a receipt, paid via guide-held cash
//   REVENUE_RECOGNITION  the service was given, on its service date, to its revenue category
//   BANK_CLEARING        the guide's transfers reached the company account (Admin confirmed):
//                        one line per central bank transfer (BankTransaction), each cleared once
//   SALE_CANCELLED / SALE_REFUNDED   a sale undone — void or credit note is chosen per document
//                        type after UAT, so these are BLOCKED until that is decided
//
// The payload and the mapping it used are frozen at creation (database trigger). An event that
// lacks a confirmed tax profile, a mapped account or a receiving account is BLOCKED with the
// reasons shown; nothing is guessed. Sending is PR4-P and stays off (UPSELL_PEAK_AUTO_SYNC).

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export type UpsellPeakEventKind = "RECEIPT" | "REVENUE_RECOGNITION" | "BANK_CLEARING" | "SALE_CANCELLED" | "SALE_REFUNDED";

/** The account guide-held cash sits in until it is handed in (a PeakAccountMapping category). */
export const GUIDE_CASH_HELD = "UPSELL_GUIDE_CASH_HELD";

export const UNDECIDED_REVERSAL_DOCUMENT = "Void or credit note is decided per document type after the PEAK UAT — not chosen yet";

type Needs = { taxProfileId?: string | null; revenueCategory?: string | null; guideCashHeld?: boolean; receivingAccountId?: string | null; blocked?: string[] };

/** The mapping an event would use now, and every reason it cannot be sent yet. Reads only. */
export async function evaluateMapping(db: Db, needs: Needs): Promise<{ snapshot: Record<string, unknown>; reasons: string[] }> {
  const reasons = [...(needs.blocked ?? [])];
  const snapshot: Record<string, unknown> = {};
  if (needs.taxProfileId) {
    const t = await db.taxProfile.findUnique({ where: { id: needs.taxProfileId } });
    snapshot.taxProfile = t ? { id: t.id, code: t.code, status: t.status, vatMode: t.vatMode, vatRateBp: t.vatRateBp, revenueRecognition: t.revenueRecognition, peakDocumentKind: t.peakDocumentKind } : null;
    if (!t || t.status !== "CONFIRMED") reasons.push("The tax profile is not confirmed by the accountant");
    else if (t.vatMode === "UNCONFIRMED") reasons.push("The VAT treatment is not confirmed");
  }
  const categories = [needs.revenueCategory, needs.guideCashHeld ? GUIDE_CASH_HELD : null].filter((c): c is string => !!c);
  if (categories.length) {
    const rows = await db.peakAccountMapping.findMany({ where: { folkopsCategory: { in: categories }, isActive: true }, select: { folkopsCategory: true, peakAccountCode: true, peakAccountName: true } });
    snapshot.accounts = Object.fromEntries(rows.map((r) => [r.folkopsCategory, { code: r.peakAccountCode, name: r.peakAccountName }]));
    for (const c of categories) {
      if (!rows.some((r) => r.folkopsCategory === c)) reasons.push(`No PEAK account is mapped to ${REVENUE_CATEGORY_LABEL[c] ?? c} (${c})`);
    }
  }
  if (needs.receivingAccountId !== undefined) {
    const a = needs.receivingAccountId ? await db.upsellReceivingAccount.findUnique({ where: { id: needs.receivingAccountId } }) : null;
    snapshot.receivingAccount = a ? { id: a.id, version: a.version, peakPaymentMethodId: a.peakPaymentMethodId, bankAccountKey: a.bankAccountKey, display: a.accountDisplay } : null;
    if (!a) reasons.push("No receiving account is set for the Extras cash");
  }
  return { snapshot, reasons };
}

/**
 * Record one event, inside the business event's own transaction. Idempotent on
 * (kind, source): the same event asked again returns the one already recorded.
 */
export async function recordPeakEvent(tx: Tx, input: { kind: UpsellPeakEventKind; sourceTable: string; sourceId: string; eventDate: string; payload: Record<string, unknown>; needs: Needs; bankTransactionIds?: string[] }) {
  const existing = await tx.upsellPeakEvent.findUnique({ where: { eventKind_sourceTable_sourceId: { eventKind: input.kind, sourceTable: input.sourceTable, sourceId: input.sourceId } } });
  if (existing) return existing;
  const { snapshot, reasons } = await evaluateMapping(tx, input.needs);
  const event = await tx.upsellPeakEvent.create({
    data: {
      eventKind: input.kind, sourceTable: input.sourceTable, sourceId: input.sourceId, eventDate: input.eventDate,
      payload: input.payload as Prisma.InputJsonValue, mappingSnapshot: snapshot as Prisma.InputJsonValue,
      status: reasons.length ? "BLOCKED" : "PENDING", blockedReasons: reasons,
    },
  });
  // Each real transfer is cleared into PEAK once (unique per BankTransaction).
  for (const bankTransactionId of input.bankTransactionIds ?? []) {
    await tx.upsellPeakEventBankLink.create({ data: { eventId: event.id, bankTransactionId } });
  }
  return event;
}

// ── PR4-P: the interface the PEAK integration implements ───────────────────────────────────

export type PeakPostResult =
  | { ok: true; peakId: string; peakCode: string }
  | { ok: false; outcome: "REJECTED"; error: string } // PEAK answered and refused (inside HTTP 200 too)
  | { ok: false; outcome: "UNKNOWN"; error: string }; // timeout / transport: it may or may not exist

export type PeakReadBack = { found: true; peakId: string; peakCode: string } | { found: false } | { unknown: true; error: string };

/** One implementation per event kind's PEAK document (receipt, daily journal, void / credit note). */
export interface UpsellPeakAdapter {
  post(event: { id: string; eventKind: UpsellPeakEventKind; eventDate: string; payload: unknown; mappingSnapshot: unknown }): Promise<PeakPostResult>;
  /** Look the event up in PEAK by its own reference (never by guessing): used after UNKNOWN. */
  readBack(event: { id: string; eventKind: UpsellPeakEventKind; payload: unknown }): Promise<PeakReadBack>;
}

export class UpsellPeakRefused extends Error {}

/**
 * Send one PENDING event through `adapter`. Claims it first (PENDING → SENDING, one sender);
 * a timeout leaves it UNCERTAIN — never sent again until a read-back settles it.
 */
export async function sendPeakEvent(db: PrismaClient, adapter: UpsellPeakAdapter, eventId: string) {
  if (!upsellPeakAutoSyncEnabled()) throw new UpsellPeakRefused("Sending upsell events to PEAK is off (UPSELL_PEAK_AUTO_SYNC)");
  const claimed = await db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "PENDING" }, data: { status: "SENDING", attempts: { increment: 1 }, lastAttemptAt: new Date() } });
  if (claimed.count !== 1) throw new UpsellPeakRefused("Only a PENDING event is sent — a BLOCKED, UNCERTAIN or FAILED one is resolved first");
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  const r = await adapter.post({ id: e.id, eventKind: e.eventKind as UpsellPeakEventKind, eventDate: e.eventDate, payload: e.payload, mappingSnapshot: e.mappingSnapshot });
  if (r.ok) return db.upsellPeakEvent.update({ where: { id: eventId }, data: { status: "POSTED", peakId: r.peakId, peakCode: r.peakCode, lastError: null } });
  return db.upsellPeakEvent.update({ where: { id: eventId }, data: { status: r.outcome === "REJECTED" ? "FAILED" : "UNCERTAIN", lastError: r.error.slice(0, 500) } });
}

/** Settle an UNCERTAIN event by asking PEAK: found → POSTED; proven absent → PENDING; unknown → stays. */
export async function resolveUncertain(db: PrismaClient, adapter: UpsellPeakAdapter, eventId: string) {
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (e.status !== "UNCERTAIN") throw new UpsellPeakRefused("Only an UNCERTAIN event is read back");
  const r = await adapter.readBack({ id: e.id, eventKind: e.eventKind as UpsellPeakEventKind, payload: e.payload });
  if ("unknown" in r) return db.upsellPeakEvent.update({ where: { id: eventId }, data: { lastError: r.error.slice(0, 500) } });
  if (r.found) return db.upsellPeakEvent.update({ where: { id: eventId }, data: { status: "POSTED", peakId: r.peakId, peakCode: r.peakCode, lastError: null } });
  return db.upsellPeakEvent.update({ where: { id: eventId }, data: { status: "PENDING", lastError: "Read back from PEAK: not there — safe to send again" } });
}

/** Re-check a BLOCKED event against today's configuration (the payload never changes). */
export async function recheckBlocked(db: PrismaClient, eventId: string, needs: Needs) {
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (e.status !== "BLOCKED") return e;
  const { snapshot, reasons } = await evaluateMapping(db, needs);
  return db.upsellPeakEvent.update({ where: { id: eventId }, data: reasons.length ? { blockedReasons: reasons, mappingSnapshot: snapshot as Prisma.InputJsonValue } : { status: "PENDING", blockedReasons: [], mappingSnapshot: snapshot as Prisma.InputJsonValue } });
}
