import type { Prisma, PrismaClient } from "@prisma/client";
import { upsellPeakAutoSyncEnabled } from "./flags";
import { REVENUE_CATEGORY_LABEL } from "./catalog";

// What PEAK must receive for Tour Upsell, written as an event IN THE SAME TRANSACTION as the
// business event it records (owner + Codex, 20 Nov 2026). Three distinct things, never merged:
//
//   RECEIPT              the guest paid (cash to the guide): a receipt, paid via guide-held cash. For a
//                        service given the same day (a Route Extension) it carries the income itself;
//                        for a service still to come it credits unearned revenue instead
//   REVENUE_RECOGNITION  only for a service paid in advance: the income, on the actual service date,
//                        once the service is given (approval is the trigger, not the date)
//   BANK_CLEARING        the guide's transfers reached the company account (Admin confirmed):
//                        one line per central bank transfer (BankTransaction), each cleared once
//   SALE_CANCELLED / SALE_REFUNDED   a sale undone — void or credit note is chosen per document
//                        type after UAT, so these are BLOCKED until that is decided
//
// The payload and the mapping it used are frozen at creation (database trigger). An event that
// lacks a confirmed tax profile, a mapped account or a receiving account is BLOCKED with the
// reasons shown; nothing is guessed. Sending is PR4-P and stays off (UPSELL_PEAK_AUTO_SYNC).

type Tx = Prisma.TransactionClient;

export class UpsellPeakRefused extends Error {}
type Db = PrismaClient | Tx;

export type UpsellPeakEventKind = "RECEIPT" | "REVENUE_RECOGNITION" | "BANK_CLEARING" | "SALE_CANCELLED" | "SALE_REFUNDED";

/** The account guide-held cash sits in until it is handed in (a PeakAccountMapping category). */
export const GUIDE_CASH_HELD = "UPSELL_GUIDE_CASH_HELD";

export const UNDECIDED_REVERSAL_DOCUMENT = "Void or credit note is decided per document type after the PEAK UAT — not chosen yet";

type Needs = { taxProfileId?: string | null; revenueCategory?: string | null; guideCashHeld?: boolean; unearnedRevenue?: boolean; receivingAccountId?: string | null; blocked?: string[] };

/** The mapping an event would use now, and every reason it cannot be sent yet. Reads only. */
export async function evaluateMapping(db: Db, needs: Needs): Promise<{ snapshot: Record<string, unknown>; reasons: string[] }> {
  const reasons = [...(needs.blocked ?? [])];
  const snapshot: Record<string, unknown> = {};
  if (needs.taxProfileId) {
    const t = await db.taxProfile.findUnique({ where: { id: needs.taxProfileId } });
    snapshot.taxProfile = t ? { id: t.id, code: t.code, status: t.status, vatRegistration: t.vatRegistration, vatRegistrationSource: t.vatRegistrationSource, vatMode: t.vatMode, vatRateBp: t.vatRateBp, revenueRecognition: t.revenueRecognition, peakDocumentKind: t.peakDocumentKind } : null;
    if (!t || t.status !== "CONFIRMED") reasons.push("The tax profile is not confirmed by the accountant");
    if (t?.vatRegistration === "UNKNOWN") reasons.push("Whether the company is VAT-registered is not recorded");
    // Not registered: no VAT and no tax invoice — the VAT mode question does not arise. Registered:
    // the VAT treatment must be confirmed. Either way the PEAK document type is the UAT's answer.
    if (t?.vatRegistration === "REGISTERED" && t.vatMode === "UNCONFIRMED") reasons.push("The VAT treatment is not confirmed");
    if (t && !t.peakDocumentKind) reasons.push(t.vatRegistration === "NOT_REGISTERED" ? "The PEAK no-VAT document type is not confirmed (verified on UAT first)" : "The PEAK document type is not confirmed");
  }
  const categories = [needs.revenueCategory, needs.guideCashHeld ? GUIDE_CASH_HELD : null, needs.unearnedRevenue ? UNEARNED_REVENUE : null].filter((c): c is string => !!c);
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
  // What the event needs is kept with it, so the worker can re-check a BLOCKED event on its own.
  snapshot.needs = input.needs;
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

/** Revenue received for a service not yet given (a PeakAccountMapping category). */
export const UNEARNED_REVENUE = "UPSELL_UNEARNED_REVENUE";

/**
 * Where a sale's receipt credits: the revenue category when the service is given on or before
 * the payment date (one document carries the income — never a second revenue posting), or
 * unearned revenue when the service is still to come (recognised later, on its service date).
 */
export const receiptCredit = (paymentDate: string, serviceDate: string, revenueCategory: string) =>
  serviceDate <= paymentDate ? { credit: revenueCategory, deferred: false } : { credit: UNEARNED_REVENUE, deferred: true };

export async function recordSaleReceipt(tx: Tx, s: { saleId: string; saleNo: string; jobRef: string | null; productCode: string; version: number; guests: number; grossSatang: number; revenueCategory: string; taxProfileId: string; paymentDate: string; serviceDate: string; allocations?: unknown[] }) {
  const c = receiptCredit(s.paymentDate, s.serviceDate, s.revenueCategory);
  return recordPeakEvent(tx, {
    kind: "RECEIPT", sourceTable: "UpsellSale", sourceId: s.saleId, eventDate: s.paymentDate,
    payload: { reference: s.saleNo, saleId: s.saleId, jobRef: s.jobRef, productCode: s.productCode, version: s.version, guests: s.guests, grossSatang: s.grossSatang,
      paymentDate: s.paymentDate, serviceDate: s.serviceDate, paidVia: GUIDE_CASH_HELD, credit: c.credit, revenueCategory: s.revenueCategory, deferred: c.deferred,
      // Whose guests (booking refs, counts, original purchase) — never a name or contact.
      ...(s.allocations ? { allocations: s.allocations } : {}) },
    needs: { taxProfileId: s.taxProfileId, revenueCategory: c.credit, guideCashHeld: true },
  });
}

/**
 * A service paid in advance, now given: the income on its actual service date, moved out of
 * unearned revenue. Called by the step that confirms the service (its approval is the trigger,
 * not the date). Refused for a sale whose receipt already carried the income.
 */
export async function recordRevenueRecognition(tx: Tx, s: { saleId: string; saleNo: string; grossSatang: number; revenueCategory: string; taxProfileId: string; serviceDate: string }) {
  const receipt = await tx.upsellPeakEvent.findUnique({ where: { eventKind_sourceTable_sourceId: { eventKind: "RECEIPT", sourceTable: "UpsellSale", sourceId: s.saleId } } });
  if (!receipt || !(receipt.payload as { deferred?: boolean }).deferred) throw new UpsellPeakRefused("This sale's receipt already carries the income — no separate revenue posting");
  return recordPeakEvent(tx, {
    kind: "REVENUE_RECOGNITION", sourceTable: "UpsellSale", sourceId: s.saleId, eventDate: s.serviceDate,
    payload: { reference: s.saleNo, saleId: s.saleId, amountSatang: s.grossSatang, serviceDate: s.serviceDate, from: UNEARNED_REVENUE, to: s.revenueCategory },
    needs: { taxProfileId: s.taxProfileId, revenueCategory: s.revenueCategory, unearnedRevenue: true, blocked: [] },
  });
}

// ── PR4-P: the interface the PEAK integration implements ───────────────────────────────────

export type PeakPostResult =
  | { ok: true; peakId: string; peakCode: string }
  | { ok: false; outcome: "REJECTED"; error: string } // PEAK answered and refused (inside HTTP 200 too)
  | { ok: false; outcome: "UNKNOWN"; error: string }; // timeout / transport: it may or may not exist

/** found:false must say whether PEAK's answer proves absence (`reliable`) — a list that may lag
 *  behind a recent write does not. */
export type PeakReadBack = { found: true; peakId: string; peakCode: string } | { found: false; reliable: boolean } | { unknown: true; error: string };

/** One implementation per event kind's PEAK document (receipt, daily journal, void / credit note). */
export interface UpsellPeakAdapter {
  post(event: { id: string; eventKind: UpsellPeakEventKind; eventDate: string; payload: unknown; mappingSnapshot: unknown }): Promise<PeakPostResult>;
  /** Look the event up in PEAK by its own reference (never by guessing): used after UNKNOWN. */
  readBack(event: { id: string; eventKind: UpsellPeakEventKind; payload: unknown; mappingSnapshot?: unknown; peakCode?: string | null }): Promise<PeakReadBack>;
}


/** How long a sender may hold an event before it counts as lost (→ UNCERTAIN, read back). */
export const SEND_LEASE_MS = 2 * 60_000;
/** A "not there" from PEAK proves absence only this long after the last attempt (its own lag). */
export const ABSENCE_GRACE_MS = 10 * 60_000;

/**
 * Send one PENDING event through `adapter`. Claims it first (PENDING → SENDING with a lease, one
 * sender); a timeout, a transport error or the adapter throwing leaves it UNCERTAIN — never sent
 * again until a read-back settles it. A sender that dies mid-send is found by recoverExpiredLeases.
 */
export async function sendPeakEvent(db: PrismaClient, adapter: UpsellPeakAdapter, eventId: string, now = new Date()) {
  if (!upsellPeakAutoSyncEnabled()) throw new UpsellPeakRefused("Sending upsell events to PEAK is off (UPSELL_PEAK_AUTO_SYNC)");
  const claimed = await db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "PENDING" }, data: { status: "SENDING", attempts: { increment: 1 }, lastAttemptAt: now, leaseUntil: new Date(now.getTime() + SEND_LEASE_MS) } });
  if (claimed.count !== 1) throw new UpsellPeakRefused("Only a PENDING event is sent — a BLOCKED, UNCERTAIN or FAILED one is resolved first");
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  let r: PeakPostResult;
  try {
    r = await adapter.post({ id: e.id, eventKind: e.eventKind as UpsellPeakEventKind, eventDate: e.eventDate, payload: e.payload, mappingSnapshot: e.mappingSnapshot });
  } catch (err) {
    r = { ok: false, outcome: "UNKNOWN", error: `adapter failed: ${String((err as Error)?.message ?? err)}` };
  }
  // Only the claim this sender holds is settled (status SENDING at the version it set).
  const settle = (data: Prisma.UpsellPeakEventUpdateManyMutationInput) => db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "SENDING", version: e.version }, data: { ...data, leaseUntil: null } });
  const done = r.ok
    ? await settle({ status: "POSTED", peakId: r.peakId, peakCode: r.peakCode, lastError: null })
    : await settle({ status: r.outcome === "REJECTED" ? "FAILED" : "UNCERTAIN", lastError: r.error.slice(0, 500) });
  if (done.count !== 1) throw new UpsellPeakRefused("This event was settled by someone else meanwhile — read it again");
  return db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
}

/** A SENDING event whose lease ran out (the sender died): UNCERTAIN — read back, never resent. */
export async function recoverExpiredLeases(db: PrismaClient, now = new Date()) {
  const r = await db.upsellPeakEvent.updateMany({ where: { status: "SENDING", leaseUntil: { lt: now } }, data: { status: "UNCERTAIN", leaseUntil: null, lastError: "The sender stopped before PEAK's answer was saved — read back before anything else" } });
  return r.count;
}

/**
 * Settle an UNCERTAIN event by asking PEAK. Found → POSTED with its id and code. Proven absent —
 * an answer the adapter marks reliable, given after the grace period since the last attempt — →
 * PENDING. Anything else: stays UNCERTAIN. Compare-and-set on the version read, so a stale answer
 * can never overwrite a POSTED event or open a second send.
 */
export async function resolveUncertain(db: PrismaClient, adapter: UpsellPeakAdapter, eventId: string, now = new Date(), opts: { peakCode?: string; requeueOnAbsence?: boolean } = {}) {
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (e.status !== "UNCERTAIN") throw new UpsellPeakRefused("Only an UNCERTAIN event is read back");
  // `peakCode`: a code an Admin read off PEAK (journals have no reference lookup) — verified by the adapter, never trusted.
  const r = await adapter.readBack({ id: e.id, eventKind: e.eventKind as UpsellPeakEventKind, payload: e.payload, mappingSnapshot: e.mappingSnapshot, peakCode: opts.peakCode?.trim() || e.peakCode });
  const cas = (data: Prisma.UpsellPeakEventUpdateManyMutationInput) => db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "UNCERTAIN", version: e.version }, data });
  let done;
  if ("unknown" in r) done = await cas({ lastError: r.error.slice(0, 500) });
  else if (r.found) done = await cas({ status: "POSTED", peakId: r.peakId, peakCode: r.peakCode, lastError: null });
  else if (!r.reliable) done = await cas({ lastError: "PEAK did not find it, but cannot promise it is absent — read back again later" });
  // The worker reads back on its own but never requeues: a proven absence waits for an Admin.
  else if (opts.requeueOnAbsence === false) done = await cas({ lastError: "PEAK says it is not there — an Admin decides whether to send it again" });
  else if (!e.lastAttemptAt || now.getTime() - e.lastAttemptAt.getTime() < ABSENCE_GRACE_MS) done = await cas({ lastError: "Not found yet — PEAK may still be writing it; read back again after the grace period" });
  else done = await cas({ status: "PENDING", lastError: "Read back from PEAK: not there after the grace period — safe to send again" });
  if (done.count !== 1) throw new UpsellPeakRefused("This event changed while PEAK was being asked — read it again");
  return db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
}

/**
 * Re-check a BLOCKED event against today's configuration (the payload never changes).
 * `extraReasons` are reasons outside the mapping — an earlier event it depends on (the sale's
 * receipt) that is not in PEAK yet.
 */
export async function recheckBlocked(db: PrismaClient, eventId: string, needs?: Needs, extraReasons: string[] = []) {
  const e = await db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
  if (e.status !== "BLOCKED") return e;
  const kept = needs ?? ((e.mappingSnapshot as { needs?: Needs } | null)?.needs ?? {});
  const { snapshot, reasons: mapping } = await evaluateMapping(db, kept);
  snapshot.needs = kept;
  const reasons = [...mapping, ...extraReasons];
  const done = await db.upsellPeakEvent.updateMany({ where: { id: eventId, status: "BLOCKED", version: e.version },
    data: reasons.length ? { blockedReasons: reasons, mappingSnapshot: snapshot as Prisma.InputJsonValue } : { status: "PENDING", blockedReasons: [], mappingSnapshot: snapshot as Prisma.InputJsonValue } });
  if (done.count !== 1) throw new UpsellPeakRefused("This event changed meanwhile — read it again");
  return db.upsellPeakEvent.findUniqueOrThrow({ where: { id: eventId } });
}

/** Never send this event (the business event it records was undone before it reached PEAK). */
export async function cancelPeakEvent(tx: Tx, eventId: string, reason: string) {
  const done = await tx.upsellPeakEvent.updateMany({ where: { id: eventId, status: { in: ["BLOCKED", "PENDING", "FAILED"] } }, data: { status: "CANCELLED", cancelledReason: reason, blockedReasons: [] } });
  return done.count === 1;
}
