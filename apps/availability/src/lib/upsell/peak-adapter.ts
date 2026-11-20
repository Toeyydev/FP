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
// What is NOT real yet: receipts, revenue recognition, voids / credit notes. There is no PEAK
// receipts client, and its contract is unverified — those kinds refuse without calling PEAK.

import type { DailyJournalPayload, PeakJournalState } from "@/lib/peak-api";
import type { PeakPostResult, PeakReadBack, UpsellPeakAdapter, UpsellPeakEventKind } from "./peak-outbox";
import { GUIDE_CASH_HELD } from "./peak-outbox";

export type UpsellPeakConfig = {
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
  return { clearingJournalTypeId: str(j.clearingJournalTypeId), clearingContactId: str(j.clearingContactId), receivingAccounts: accounts };
}

type ClearingPayload = {
  reference: string; memo: string; settlementNo: string; jobRef: string | null; guideId: string; transferDate: string;
  description: string; totalSatang: number; saleRefs: string[];
};
type Snapshot = { accounts?: Record<string, { code: string }>; receivingAccount?: { peakPaymentMethodId: string } | null };

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

/** Does the live journal PEAK holds under `code` carry exactly this event? Pure. */
export function journalMatches(j: PeakJournalState, expected: DailyJournalPayload): string | null {
  if (j.isVoid) return "That PEAK journal is void";
  const want = expected.journalEntries.map((e) => `${e.accountCode}|${e.accountSubId ?? ""}|${Number(e.debit).toFixed(2)}|${Number(e.credit).toFixed(2)}`).sort();
  const got = j.entries.map((e) => `${e.accountCode}|${e.accountSubId ?? ""}|${e.debit.toFixed(2)}|${e.credit.toFixed(2)}`).sort();
  if (want.join("\n") !== got.join("\n")) return "That PEAK journal's lines are not this hand-in's (accounts or amounts differ)";
  if (j.issuedDate && j.issuedDate.replace(/\D/g, "").slice(0, 8) !== expected.issuedDate) return "That PEAK journal has another date";
  return null;
}

export type PeakJournalClient = {
  createDailyJournal(j: DailyJournalPayload): Promise<{ ok: boolean; code?: string; id?: string; uncertain?: boolean; desc?: string }>;
  getDailyJournal(code: string): Promise<{ ok: boolean; journal?: PeakJournalState; notFound?: boolean; desc?: string }>;
};

const NOT_BUILT: Partial<Record<UpsellPeakEventKind, string>> = {
  RECEIPT: "The PEAK receipt for an Extras sale is not built: its document type and contract are verified on UAT first",
  REVENUE_RECOGNITION: "Revenue recognition to PEAK is not built (only needed when revenue is deferred)",
  SALE_CANCELLED: "Voiding a PEAK document for an Extras sale is not built: void or credit note is decided after the UAT",
  SALE_REFUNDED: "The PEAK refund document for an Extras sale is not built: decided after the UAT",
};

/**
 * The adapter. `client` is lib/peak-api in production and a fake in tests; `config` is read when
 * each event is sent, so a configuration fix takes effect without a restart.
 */
export function upsellPeakAdapter(client: PeakJournalClient, config: () => UpsellPeakConfig = () => upsellPeakConfig()): UpsellPeakAdapter {
  const build = (payload: unknown, snapshot: unknown) => {
    let cfg: UpsellPeakConfig;
    try { cfg = config(); } catch (e) { return { error: (e as Error).message }; }
    return clearingJournal(payload, snapshot, cfg);
  };
  return {
    async post(event): Promise<PeakPostResult> {
      if (event.eventKind !== "BANK_CLEARING") return refuse(NOT_BUILT[event.eventKind] ?? `Unknown event kind ${event.eventKind}`);
      const built = build(event.payload, event.mappingSnapshot);
      // Refused before sending: nothing reached PEAK, so FAILED (fixable, then sent) is the truth.
      if ("error" in built) return refuse(built.error);
      let r;
      try { r = await client.createDailyJournal(built.journal); } catch (e) { return { ok: false, outcome: "UNKNOWN", error: `PEAK call failed: ${String((e as Error)?.message ?? e)}` }; }
      if (r.ok && r.id && r.code) return { ok: true, peakId: r.id, peakCode: r.code };
      if (r.ok) return { ok: false, outcome: "UNKNOWN", error: "PEAK answered without the journal's id and code" };
      // Only an explicit refusal proves no journal was made; anything else may have arrived.
      return { ok: false, outcome: r.uncertain === false ? "REJECTED" : "UNKNOWN", error: r.desc ?? "PEAK refused the journal" };
    },
    async readBack(event): Promise<PeakReadBack> {
      if (event.eventKind !== "BANK_CLEARING") return { unknown: true, error: NOT_BUILT[event.eventKind] ?? "Not built" };
      // No reference lookup exists for journals: without a code read off PEAK there is nothing to ask.
      if (!event.peakCode) return { unknown: true, error: "PEAK journals are found by their code only — find the journal in PEAK by the hand-in code in its description and enter its code" };
      const built = build(event.payload, event.mappingSnapshot);
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
