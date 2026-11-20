// PR4-P — the real PEAK adapter for upsell events (ops.folkpaths.com → PEAK, never the reverse).
//
// Behind UPSELL_PEAK_AUTO_SYNC (sendPeakEvent refuses while it is off). Nothing here chooses an
// account: every PEAK id comes from PEAK_UPSELL_CONFIG, which is filled in only from a read-only
// look at PEAK (and checked on UAT). A missing piece refuses BEFORE anything is sent — never a
// default, never the guide-advance bank account (owner 2026-11-20).
//
// What is real today:
//   * BANK_CLEARING → one PEAK daily journal: Dr the receiving bank account, Cr guide cash held.
//     The hand-in code (the guide's bank memo) is the journal's reference and leads its
//     description, with the job and the sales it covers.
//   * Read-back: PEAK journals have no reference field (Phase 1F read), so a journal is found only
//     by its code. After a lost answer the event stays UNCERTAIN until an Admin reads the code off
//     PEAK; that code is then verified here against the event (amount, accounts, live) before the
//     event is marked POSTED.
//   * RECEIPT → one PEAK receipt per sale (lib/peak-api createReceipt, the official contract):
//     a company that is NOT VAT-registered → taxStatus 2 (no VAT), vatType 1 on the line,
//     isTaxInvoice 0; the guest's TOTAL (฿200 / ฿700 — nothing added). Reference = the Sale Ref,
//     the job ref in the remark; credit = revenue (same-day service) or unearned revenue (service
//     still to come); paid into guide cash held. Read back by its reference (documented GET).
//   * REVENUE_RECOGNITION → a daily journal on the service date: Dr unearned, Cr revenue — only
//     for a receipt that deferred it (recordRevenueRecognition refuses otherwise).
// What is NOT real yet: voids / credit notes (decided after the UAT) — those refuse, never call PEAK.

import type { DailyJournalPayload, PeakJournalState, PeakReceiptState, ReceiptPayload } from "@/lib/peak-api";
import type { PeakPostResult, PeakReadBack, UpsellPeakAdapter, UpsellPeakEventKind } from "./peak-outbox";
import { GUIDE_CASH_HELD, UNEARNED_REVENUE } from "./peak-outbox";

export type UpsellPeakConfig = {
  /** PEAK journal type for revenue recognition (unearned → revenue). */
  recognitionJournalTypeId?: string;
  /** The PEAK contact receipts are issued to (a walk-in / cash customer); optional in PEAK's contract. */
  receiptContactId?: string;
  /** How a receipt's payment lands in guide cash held — PEAK documents both; which one PEAK
   *  accepts for a cash-held account is the UAT's answer, so it is never chosen here. */
  receiptPayment?: { mode: "ACCOUNT_CODE" } | { mode: "PAYMENT_METHOD"; paymentMethodId: string };
  /** PEAK journal type for the hand-in clearing journal (verified on UAT). */
  clearingJournalTypeId: string;
  /** The PEAK contact the clearing journal is filed under (PEAK requires one on a journal). */
  clearingContactId: string;
  /** Per receiving account (its PEAK payment method id): the bank account code and sub-id in PEAK. */
  receivingAccounts: Record<string, { accountCode: string; accountSubId: string }>;
};

export class UpsellPeakConfigMissing extends Error {}

/** Read PEAK_UPSELL_CONFIG. Throws UpsellPeakConfigMissing naming what is missing. */
export function upsellPeakConfig(raw = process.env.PEAK_UPSELL_CONFIG): UpsellPeakConfig {
  if (!raw?.trim()) throw new UpsellPeakConfigMissing("PEAK_UPSELL_CONFIG is not set");
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { throw new UpsellPeakConfigMissing("PEAK_UPSELL_CONFIG is not valid JSON"); }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const accounts: UpsellPeakConfig["receivingAccounts"] = {};
  const rawAccounts = j.receivingAccounts && typeof j.receivingAccounts === "object" ? (j.receivingAccounts as Record<string, unknown>) : {};
  for (const [method, v] of Object.entries(rawAccounts)) {
    const o = (v ?? {}) as Record<string, unknown>;
    if (str(o.accountCode) && str(o.accountSubId)) accounts[method] = { accountCode: str(o.accountCode), accountSubId: str(o.accountSubId) };
  }
  const rp = (j.receiptPayment ?? null) as Record<string, unknown> | null;
  const receiptPayment = rp?.mode === "ACCOUNT_CODE" ? { mode: "ACCOUNT_CODE" as const }
    : rp?.mode === "PAYMENT_METHOD" && str(rp.paymentMethodId) ? { mode: "PAYMENT_METHOD" as const, paymentMethodId: str(rp.paymentMethodId) } : undefined;
  return { clearingJournalTypeId: str(j.clearingJournalTypeId), clearingContactId: str(j.clearingContactId), receivingAccounts: accounts,
    recognitionJournalTypeId: str(j.recognitionJournalTypeId) || undefined, receiptContactId: str(j.receiptContactId) || undefined, receiptPayment };
}

type ClearingPayload = {
  reference: string; memo: string; settlementNo: string; jobRef: string | null; guideId: string; transferDate: string;
  description: string; totalSatang: number; saleRefs: string[];
};
type Snapshot = { accounts?: Record<string, { code: string }>; receivingAccount?: { peakPaymentMethodId: string } | null; taxProfile?: { vatRegistration?: string; peakDocumentKind?: string | null; status?: string } | null };

const refuse = (error: string): PeakPostResult => ({ ok: false, outcome: "REJECTED", error });
const baht = (satang: number) => (satang / 100).toFixed(2);

/** The journal for one BANK_CLEARING event, or the reason it cannot be built. Pure. */
export function clearingJournal(payload: unknown, snapshot: unknown, config: UpsellPeakConfig): { journal: DailyJournalPayload } | { error: string } {
  const p = (payload ?? {}) as Partial<ClearingPayload>;
  const s = (snapshot ?? {}) as Snapshot;
  if (!Number.isSafeInteger(p.totalSatang) || (p.totalSatang ?? 0) <= 0) return { error: "The clearing amount is missing" };
  if (!p.reference || p.reference.length > 32) return { error: "The journal reference is missing or longer than PEAK allows (32)" };
  if (!p.memo) return { error: "The hand-in code is missing" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.transferDate ?? "")) return { error: "The transfer date is missing" };
  if (!config.clearingJournalTypeId) return { error: "Set the PEAK journal type for the hand-in clearing (PEAK_UPSELL_CONFIG.clearingJournalTypeId)" };
  if (!config.clearingContactId) return { error: "Set the PEAK contact for the hand-in clearing (PEAK_UPSELL_CONFIG.clearingContactId)" };
  // The accounts are the ones frozen on the event when it was recorded — not today's mapping.
  const held = s.accounts?.[GUIDE_CASH_HELD]?.code;
  if (!held) return { error: `No PEAK account is mapped to guide cash held (${GUIDE_CASH_HELD})` };
  const method = s.receivingAccount?.peakPaymentMethodId;
  if (!method) return { error: "The event has no receiving account" };
  const bank = config.receivingAccounts[method];
  if (!bank) return { error: "The receiving account has no PEAK bank account code / sub-id in PEAK_UPSELL_CONFIG — read it from PEAK, never assume it" };
  const amount = baht(p.totalSatang!);
  const description = `${p.memo} · ${p.description ?? ""}`.slice(0, 250);
  return {
    journal: {
      issuedDate: p.transferDate!.replaceAll("-", ""),
      journalTypeId: config.clearingJournalTypeId,
      contactId: config.clearingContactId,
      reference: p.reference,
      description,
      journalEntries: [
        { accountCode: bank.accountCode, accountSubId: bank.accountSubId, debit: amount, credit: "0.00", description: `${p.memo} · ${p.jobRef ?? ""}`.slice(0, 120) },
        { accountCode: held, debit: "0.00", credit: amount, description: `${p.memo} · ${p.guideId ?? ""}`.slice(0, 120) },
      ],
    },
  };
}

type ReceiptEventPayload = { reference: string; saleId: string; jobRef: string | null; productCode: string; version: number; guests: number; grossSatang: number; paymentDate: string; serviceDate: string; credit: string; deferred: boolean;
  /** Route Extension (PR4e): whose guests — booking refs and counts, frozen at the sale. Absent on older and walk-in payloads. */
  allocations?: unknown };

/** PEAK's documented remark limit. */
const REMARK_MAX = 1000;
/** "FX-0001×1, FX-0002×2" from the frozen allocations: refs and counts only (never a name or contact),
 *  well-formed rows only, cut to fit with "+N more" rather than a half reference. */
export function guestsLine(allocations: unknown, room = 400): string {
  if (!Array.isArray(allocations)) return "";
  const parts = allocations.flatMap((a) => {
    const ref = typeof (a as { bookingRef?: unknown })?.bookingRef === "string" ? (a as { bookingRef: string }).bookingRef.replace(/[^\w\-./]/g, "").slice(0, 40) : "";
    const n = (a as { guests?: unknown })?.guests;
    return ref && Number.isSafeInteger(n) && (n as number) > 0 ? [`${ref}×${n}`] : [];
  });
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}, ${parts[i]}` : parts[i];
    const rest = parts.length - i - 1;
    if (next.length + (rest ? ` +${rest} more`.length : 0) > room) return out ? `${out} +${parts.length - i} more` : `+${parts.length} bookings`;
    out = next;
  }
  return out;
}
const ymd = (d: string | undefined) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? "") ? d!.replaceAll("-", "") : null);

/** The PEAK receipt for one sale, or why it cannot be built. Pure. */
export function saleReceipt(payload: unknown, snapshot: unknown, config: UpsellPeakConfig): { receipt: ReceiptPayload } | { error: string } {
  const p = (payload ?? {}) as Partial<ReceiptEventPayload>;
  const s = (snapshot ?? {}) as Snapshot;
  if (!Number.isSafeInteger(p.grossSatang) || (p.grossSatang ?? 0) <= 0) return { error: "The sale amount is missing" };
  if (!Number.isSafeInteger(p.guests) || (p.guests ?? 0) <= 0) return { error: "The guest count is missing" };
  if (!p.reference || p.reference.length > 32) return { error: "The Sale Ref is missing or longer than PEAK allows (32)" };
  const issued = ymd(p.paymentDate);
  if (!issued) return { error: "The payment date is missing" };
  const t = s.taxProfile;
  if (!t || t.status !== "CONFIRMED") return { error: "The tax profile is not confirmed by the accountant" };
  // Only the case the owner answered is built: not VAT-registered → no VAT, not a tax invoice.
  if (t.vatRegistration !== "NOT_REGISTERED") return { error: "Receipts are built for a company that is not VAT-registered only" };
  if (!t.peakDocumentKind) return { error: "The PEAK no-VAT document type is not confirmed (verified on UAT first)" };
  const credit = s.accounts?.[p.credit ?? ""]?.code;
  if (!credit) return { error: `No PEAK account is mapped to ${p.credit === UNEARNED_REVENUE ? "unearned revenue" : "the revenue"} (${p.credit ?? "?"})` };
  const held = s.accounts?.[GUIDE_CASH_HELD]?.code;
  if (!held) return { error: `No PEAK account is mapped to guide cash held (${GUIDE_CASH_HELD})` };
  if (!config.receiptPayment) return { error: "Set how the receipt's payment lands in guide cash held (PEAK_UPSELL_CONFIG.receiptPayment: ACCOUNT_CODE or PAYMENT_METHOD + id — verified on UAT)" };
  const total = p.grossSatang! / 100;
  // The guest's total, as one priced line per guest when it divides evenly — never a rounded price.
  const perGuest = p.grossSatang! % p.guests! === 0 ? { quantity: p.guests!, price: p.grossSatang! / p.guests! / 100 } : { quantity: 1, price: total };
  const what = `${p.productCode ?? "Extra"} v${p.version ?? "?"} · ${p.guests} guest${p.guests === 1 ? "" : "s"}${p.deferred ? ` · service ${p.serviceDate}` : ""}`;
  const payment = config.receiptPayment.mode === "PAYMENT_METHOD"
    ? { amount: total, paymentMethodId: config.receiptPayment.paymentMethodId, note: `Cash held by the guide · ${p.reference}` }
    : { amount: total, accountCode: held, note: `Cash held by the guide · ${p.reference}` };
  return {
    receipt: {
      issuedDate: issued, ...(config.receiptContactId ? { contactId: config.receiptContactId } : {}),
      reference: p.reference, remark: (() => { const g = guestsLine(p.allocations); return `${p.reference} · ${p.jobRef ?? "no job ref"} · ${what}${g ? ` · guests: ${g}` : ""}`.slice(0, REMARK_MAX); })(),
      taxStatus: 2, isTaxInvoice: 0,
      products: [{ accountCode: credit, description: what.slice(0, 1000), quantity: perGuest.quantity, price: perGuest.price, vatType: 1 }],
      paidPayments: { paymentDate: issued, payments: [payment] },
      status: "Approve",
    },
  };
}

/** Revenue recognition on the service date: Dr unearned, Cr revenue. Pure. */
export function recognitionJournal(payload: unknown, snapshot: unknown, config: UpsellPeakConfig): { journal: DailyJournalPayload } | { error: string } {
  const p = (payload ?? {}) as { reference?: string; amountSatang?: number; serviceDate?: string; from?: string; to?: string };
  const s = (snapshot ?? {}) as Snapshot;
  if (!Number.isSafeInteger(p.amountSatang) || (p.amountSatang ?? 0) <= 0) return { error: "The amount is missing" };
  const issued = ymd(p.serviceDate);
  if (!issued) return { error: "The service date is missing" };
  const reference = `${p.reference ?? ""}-REV`;
  if (!p.reference || reference.length > 32) return { error: "The Sale Ref is missing or too long" };
  if (!config.recognitionJournalTypeId) return { error: "Set the PEAK journal type for revenue recognition (PEAK_UPSELL_CONFIG.recognitionJournalTypeId)" };
  if (!config.receiptContactId) return { error: "Set the PEAK contact for Extras sales (PEAK_UPSELL_CONFIG.receiptContactId) — a journal needs one" };
  const from = s.accounts?.[UNEARNED_REVENUE]?.code, to = s.accounts?.[p.to ?? ""]?.code;
  if (!from) return { error: `No PEAK account is mapped to unearned revenue (${UNEARNED_REVENUE})` };
  if (!to) return { error: `No PEAK account is mapped to ${p.to ?? "the revenue"}` };
  const amount = baht(p.amountSatang!);
  return { journal: { issuedDate: issued, journalTypeId: config.recognitionJournalTypeId, contactId: config.receiptContactId, reference,
    description: `Revenue for ${p.reference}, service given ${p.serviceDate}`,
    journalEntries: [{ accountCode: from, debit: amount, credit: "0.00" }, { accountCode: to, debit: "0.00", credit: amount }] } };
}

/** Does the live journal PEAK holds under `code` carry exactly this event? Pure. */
export function journalMatches(j: PeakJournalState, expected: DailyJournalPayload): string | null {
  if (j.isVoid) return "That PEAK journal is void";
  const want = expected.journalEntries.map((e) => `${e.accountCode}|${e.accountSubId ?? ""}|${Number(e.debit).toFixed(2)}|${Number(e.credit).toFixed(2)}`).sort();
  const got = j.entries.map((e) => `${e.accountCode}|${e.accountSubId ?? ""}|${e.debit.toFixed(2)}|${e.credit.toFixed(2)}`).sort();
  if (want.join("\n") !== got.join("\n")) return "That PEAK journal's lines are not this hand-in's (accounts or amounts differ)";
  if (j.issuedDate && j.issuedDate.replace(/\D/g, "").slice(0, 8) !== expected.issuedDate) return "That PEAK journal has another date";
  return null;
}

type Write = { ok: boolean; code?: string; id?: string; uncertain?: boolean; desc?: string };
export type PeakJournalClient = {
  createDailyJournal(j: DailyJournalPayload): Promise<Write>;
  getDailyJournal(code: string): Promise<{ ok: boolean; journal?: PeakJournalState; notFound?: boolean; desc?: string }>;
  createReceipt?(r: ReceiptPayload): Promise<Write>;
  getReceiptsByReference?(reference: string): Promise<{ ok: boolean; receipts?: PeakReceiptState[]; desc?: string }>;
};

const NOT_BUILT: Partial<Record<UpsellPeakEventKind, string>> = {
  SALE_CANCELLED: "Voiding a PEAK document for an Extras sale is not built: void or credit note is decided after the UAT",
  SALE_REFUNDED: "The PEAK refund document for an Extras sale is not built: decided after the UAT",
};

/**
 * The adapter. `client` is lib/peak-api in production and a fake in tests; `config` is read when
 * each event is sent, so a configuration fix takes effect without a restart.
 */
export function upsellPeakAdapter(client: PeakJournalClient, config: () => UpsellPeakConfig = () => upsellPeakConfig()): UpsellPeakAdapter {
  const cfg = (): UpsellPeakConfig | { error: string } => { try { return config(); } catch (e) { return { error: (e as Error).message }; } };
  const journalFor = (kind: UpsellPeakEventKind, payload: unknown, snapshot: unknown) => {
    const c = cfg();
    if ("error" in c) return c;
    return kind === "BANK_CLEARING" ? clearingJournal(payload, snapshot, c) : recognitionJournal(payload, snapshot, c);
  };
  const unknownCall = (e: unknown): PeakPostResult => ({ ok: false, outcome: "UNKNOWN", error: `PEAK call failed: ${String((e as Error)?.message ?? e)}` });
  const settle = (r: Write, what: string): PeakPostResult => {
    if (r.ok && r.id && r.code) return { ok: true, peakId: r.id, peakCode: r.code };
    if (r.ok) return { ok: false, outcome: "UNKNOWN", error: `PEAK answered without the ${what}'s id and code` };
    // Only an explicit refusal proves nothing was made; anything else may have arrived.
    return { ok: false, outcome: r.uncertain === false ? "REJECTED" : "UNKNOWN", error: r.desc ?? `PEAK refused the ${what}` };
  };
  return {
    async post(event): Promise<PeakPostResult> {
      // Every refusal below happens before sending: nothing reached PEAK, so FAILED is the truth.
      if (event.eventKind === "RECEIPT") {
        if (!client.createReceipt) return refuse("No PEAK receipt client");
        const c = cfg();
        if ("error" in c) return refuse(c.error);
        const built = saleReceipt(event.payload, event.mappingSnapshot, c);
        if ("error" in built) return refuse(built.error);
        try { return settle(await client.createReceipt(built.receipt), "receipt"); } catch (e) { return unknownCall(e); }
      }
      if (event.eventKind === "BANK_CLEARING" || event.eventKind === "REVENUE_RECOGNITION") {
        const built = journalFor(event.eventKind, event.payload, event.mappingSnapshot);
        if ("error" in built) return refuse(built.error);
        try { return settle(await client.createDailyJournal(built.journal), "journal"); } catch (e) { return unknownCall(e); }
      }
      return refuse(NOT_BUILT[event.eventKind] ?? `Unknown event kind ${event.eventKind}`);
    },
    async readBack(event): Promise<PeakReadBack> {
      if (event.eventKind === "RECEIPT") {
        // PEAK's documented GET takes the reference — the Sale Ref this receipt was sent with.
        const reference = (event.payload as { reference?: string } | null)?.reference;
        const gross = (event.payload as { grossSatang?: number } | null)?.grossSatang;
        if (!reference || !client.getReceiptsByReference) return { unknown: true, error: "No reference to look the receipt up by" };
        let r;
        try { r = await client.getReceiptsByReference(reference); } catch (e) { return { unknown: true, error: `PEAK read failed: ${String((e as Error)?.message ?? e)}` }; }
        if (!r.ok || !r.receipts) return { unknown: true, error: r.desc ?? "PEAK read failed" };
        const same = r.receipts.filter((x) => (x.reference ?? "").trim() === reference && !x.isVoid);
        if (same.length > 1) return { unknown: true, error: `PEAK has ${same.length} live receipts for ${reference} — reconcile them in PEAK first` };
        if (!same.length) return { found: false, reliable: !r.receipts.some((x) => (x.reference ?? "").trim() === reference) };
        const one = same[0];
        if (gross != null && one.netAmount != null && Math.round(one.netAmount * 100) !== gross) return { unknown: true, error: `PEAK's receipt ${one.code} for ${reference} has another amount` };
        if (!one.id || !one.code) return { unknown: true, error: "PEAK returned the receipt without its id or code" };
        return { found: true, peakId: one.id, peakCode: one.code };
      }
      if (event.eventKind !== "BANK_CLEARING" && event.eventKind !== "REVENUE_RECOGNITION") return { unknown: true, error: NOT_BUILT[event.eventKind] ?? "Not built" };
      // No reference lookup exists for journals: without a code read off PEAK there is nothing to ask.
      if (!event.peakCode) return { unknown: true, error: "PEAK journals are found by their code only — find the journal in PEAK by the reference in its description and enter its code" };
      const built = journalFor(event.eventKind, event.payload, event.mappingSnapshot);
      if ("error" in built) return { unknown: true, error: built.error };
      let r;
      try { r = await client.getDailyJournal(event.peakCode); } catch (e) { return { unknown: true, error: `PEAK read failed: ${String((e as Error)?.message ?? e)}` }; }
      if (!r.ok) return { unknown: true, error: r.desc ?? "PEAK read failed" };
      // A code that is not there says nothing about whether our journal exists — never "absent".
      if (r.notFound || !r.journal) return { unknown: true, error: `PEAK has no journal numbered ${event.peakCode}` };
      const wrong = journalMatches(r.journal, built.journal);
      if (wrong) return { unknown: true, error: wrong };
      if (!r.journal.id) return { unknown: true, error: "PEAK returned the journal without its id" };
      return { found: true, peakId: r.journal.id, peakCode: r.journal.code };
    },
  };
}
