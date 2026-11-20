"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// One job's Extras, shared by the customer rows (the tick after each name) and the Extras block
// (the one Send, the sales, the transfer ref) — owner, 20 Nov 2026: "ถ้าขายติ๊กหลังชื่อลูกค้า แล้ว
// send to admin แล้วก็เพิ่ม ref. ในการโอนเงิน". One provider = one fetch, one set of ticks, one
// pending request: the rows and the block never disagree and never query each other's DOM.
//
// A row is matched to the server's booking by its booking ref — the same rule the server uses
// (lib/upsell/guest-allocation: never by name); the sale then names the server's booking id.
// Ticking sends nothing. Send records ONE sale for every ticked guest (the existing transaction:
// allocations, cash custody, PEAK receipt queue) with a request key saved on the phone first; a
// lost answer is asked about by that same key — never sent as a new sale.

export type Kind = "ROUTE_EXTENSION" | "WALK_IN";
export type GuestRow = { bookingId: string; name: string; bookingRef: string; pax: number; remaining: number; state: "SELLABLE" | "ALREADY_BOUGHT" | "NO_SHOW"; reason: string | null; product: string; rate: string; fingerprint: string };
export type Product = { productCode: string; name: string; productVersionId: string; unitPriceSatang: number; pricingBasis: string; guestsLeft: number; kind: Kind; jobPax: number; seatsPerGuide: number;
  rows?: GuestRow[]; unlinked?: { name: string; bookingNo: string; pax: number }[]; legacyGuests?: number };
export type Receipt = { state: "SYNCED" | "QUEUED" | "WAITING" | "CHECKING" | "NONE"; peakCode: string | null };
export type Sale = { saleNo: string; jobRef: string | null; productName: string; guests: number; unitPriceSatang: number; pricingBasis: string; grossSatang: number; method: "CASH"; recordedAt: string; kind: Kind; status: string; receipt: Receipt;
  allocations?: { bookingRef: string; guests: number; name: string | null; status: string }[] };
export type Cash = { heldSatang: number; toRemitSatang: number; remitBy: "BANK_TRANSFER"; remitWhen: "END_TOUR_REPORT"; status: string };
export type Extras =
  | { show: false }
  | { show: true; jobSheetId: string; jobRef: string | null; jobPax: number; closed: { code: string; message: string } | null; products: Product[]; sales: Sale[]; cash: Cash };
export type Pending = { requestKey: string; body: Record<string, unknown>; productName: string; kind?: Kind; inline?: boolean };
export type View =
  | { kind: "block" }
  | { kind: "sell"; product: Product; guests: number; lead: string; error?: string; restart?: boolean } // walk-in seat only
  | { kind: "sending" }
  | { kind: "checking"; note?: string }
  | { kind: "notRecorded" }
  | { kind: "confirmed"; sale: Sale };

export const EXTRA = { ink: "#8A4B00", bg: "#FFF4E5" }; // the Extras tick: never the green of มาแล้ว
export const baht = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function storeKey(job: { guideId: string; date: string; slotIdx: number }) { return `upsell-pending:${job.guideId}:${job.date}:${job.slotIdx}`; }
export function readPending(k: string): Pending | null {
  try { const v = window.localStorage.getItem(k); return v ? (JSON.parse(v) as Pending) : null; } catch { return null; }
}
function writePending(k: string, p: Pending | null) {
  try { if (p) window.localStorage.setItem(k, JSON.stringify(p)); else window.localStorage.removeItem(k); } catch { /* private mode: the server key still guards */ }
}
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
const RESTART = ["PRICE_CHANGED", "NOT_ON_SALE", "STALE", "BOOKING_NOT_ON_JOB", "ALREADY_SOLD", "NO_SHOW", "TOO_MANY_GUESTS"];

type Ctx = {
  key: string; x: Extras | null; view: View; setView: (v: View) => void; load: () => Promise<void>; check: () => Promise<void>;
  send: (p: Pending, product?: Product, guests?: number) => Promise<void>; discard: () => void;
  /** The Route Extension sold by ticking rows (one configured product), and its rows by booking ref. */
  inline: { product: Product; byRef: Map<string, GuestRow>; offSheet: GuestRow[] } | null;
  picks: Record<string, number>; setPick: (bookingId: string, n: number) => void;
  pickedGuests: number; pickedTotal: number; sendPicks: () => void; inlineError: string | null;
  /** Guests already sold per booking ref (active allocations of live sales) and their amount. */
  soldByRef: Map<string, { guests: number; satang: number }>;
  busy: boolean; reportSent: boolean;
  sellWalkIn: (product: Product, guests: number, lead: string) => void;
};
const C = createContext<Ctx | null>(null);
export const useUpsellJob = () => useContext(C);

export function UpsellJobProvider({ enabled, guideId, date, slotIdx, sheetRefs, children }: { enabled: boolean; guideId: string; date: string; slotIdx: number; sheetRefs: string[]; children: React.ReactNode }) {
  if (!enabled) return <>{children}</>;
  return <Provider guideId={guideId} date={date} slotIdx={slotIdx} sheetRefs={sheetRefs}>{children}</Provider>;
}

function Provider({ guideId, date, slotIdx, sheetRefs, children }: { guideId: string; date: string; slotIdx: number; sheetRefs: string[]; children: React.ReactNode }) {
  const key = storeKey({ guideId, date, slotIdx });
  const [x, setX] = useState<Extras | null>(null);
  const [view, setView] = useState<View>({ kind: "block" });
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [inlineError, setInlineError] = useState<string | null>(null);
  // Two taps can land before React redraws: without this the second would make a second request
  // key — a second sale for the same cash.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/upsell/jobs/extras?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) { setX({ show: false }); return; } // switch off (404), not this guide's job, or offline: draw nothing
    setX(await r.json());
  }, [guideId, date, slotIdx]);

  // Ask the server about the pending key. Never sends a new sale.
  const check = useCallback(async () => {
    const p = readPending(key);
    if (!p) { setView({ kind: "block" }); return; }
    setView({ kind: "checking" });
    const r = await fetch(`/api/upsell/sales/by-key/${encodeURIComponent(p.requestKey)}`, { cache: "no-store" }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      writePending(key, null); setPicks({});
      setView({ kind: "confirmed", sale: j.sale });
      void load();
    } else if (r && r.status === 404) {
      const j = await r.json().catch(() => ({}));
      if (j.error === "NOT_RECEIVED") setView({ kind: "notRecorded" });
      else setView({ kind: "checking", note: "Could not check — the switch may be off. Ask the operator before selling again." });
    } else {
      setView({ kind: "checking", note: "Still no answer from the server." });
    }
  }, [key, load]);

  useEffect(() => { void load(); if (readPending(key)) void check(); }, [load, check, key]);

  const sendOnce = async (p: Pending, product?: Product, guests?: number) => {
    writePending(key, p); // saved before it is sent: survives a closed app or a lost signal
    setView({ kind: "sending" }); setInlineError(null);
    const r = await fetch(p.kind === "WALK_IN" ? "/api/upsell/sales/walk-in" : "/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: p.requestKey, ...p.body }) }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      writePending(key, null); setPicks({});
      setView({ kind: "confirmed", sale: j.sale });
      void load();
      return;
    }
    if (r && r.status >= 400 && r.status < 500) {
      // A definite refusal: nothing was recorded, so the key is done with.
      const j = await r.json().catch(() => ({}));
      writePending(key, null);
      const restart = RESTART.includes(j.error);
      if (p.inline) {
        // The job changed under the ticks (or a limit was hit): start again from fresh data.
        if (restart) setPicks({});
        setInlineError(`Not recorded — ${j.message ?? "the server refused it."}${restart ? " The list was refreshed; tick again." : ""}`);
        setView({ kind: "block" }); void load();
      } else if (product && guests) setView({ kind: "sell", product, guests, lead: String(p.body.leadName ?? ""), error: j.message ?? "Not recorded.", restart });
      else { setView({ kind: "block" }); void load(); }
      return;
    }
    await check(); // no answer, or a server error: it may be saved — find out before anything else
  };
  const send = async (p: Pending, product?: Product, guests?: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await sendOnce(p, product, guests); } finally { inFlight.current = false; }
  };
  const discard = () => { writePending(key, null); setView({ kind: "block" }); void load(); };

  const inline = useMemo(() => {
    if (!x || !x.show) return null;
    // One Route Extension is configured today; it is the one sold by ticking rows.
    const product = x.products.find((p) => p.kind === "ROUTE_EXTENSION" && p.rows);
    if (!product) return null;
    const byRef = new Map((product.rows ?? []).filter((r) => r.bookingRef).map((r) => [r.bookingRef.trim(), r]));
    const onSheet = new Set(sheetRefs.map((s) => (s ?? "").trim()).filter(Boolean));
    return { product, byRef, offSheet: (product.rows ?? []).filter((r) => !onSheet.has(r.bookingRef.trim())) };
  }, [x, sheetRefs]);
  const soldByRef = useMemo(() => {
    const m = new Map<string, { guests: number; satang: number }>();
    if (x && x.show) for (const s of x.sales) {
      if (s.kind !== "ROUTE_EXTENSION" || s.status === "REVERSED" || s.status === "CANCELLED") continue;
      for (const a of s.allocations ?? []) {
        if (a.status !== "ACTIVE") continue;
        const k = a.bookingRef.trim(), cur = m.get(k) ?? { guests: 0, satang: 0 };
        m.set(k, { guests: cur.guests + a.guests, satang: cur.satang + a.guests * s.unitPriceSatang });
      }
    }
    return m;
  }, [x]);

  const live = inline ? Object.entries(picks).filter(([id, n]) => n > 0 && (inline.product.rows ?? []).some((r) => r.bookingId === id && r.state === "SELLABLE")) : [];
  const pickedGuests = live.reduce((n, [, k]) => n + k, 0);
  const pickedTotal = inline ? (inline.product.pricingBasis === "PER_GROUP" ? (pickedGuests > 0 ? inline.product.unitPriceSatang : 0) : inline.product.unitPriceSatang * pickedGuests) : 0;
  const busy = view.kind === "sending" || view.kind === "checking" || view.kind === "notRecorded";
  const reportSent = !!(x && x.show && x.closed?.code === "REPORT_SENT");

  const setPick = (bookingId: string, n: number) => {
    setInlineError(null);
    setPicks((m) => { const next = { ...m }; if (n > 0) next[bookingId] = n; else delete next[bookingId]; return next; });
  };
  // The one Send: what the guide ticked, as one sale (its own request key).
  const sendPicks = () => {
    if (!x || !x.show || !inline || inFlight.current || readPending(key) || pickedGuests < 1) return;
    const rows = inline.product.rows ?? [];
    const allocations = live.map(([id, n]) => ({ bookingId: id, guests: n, fingerprint: rows.find((r) => r.bookingId === id)!.fingerprint }));
    void send({ requestKey: newKey(), inline: true, productName: inline.product.name, kind: "ROUTE_EXTENSION",
      body: { jobSheetId: x.jobSheetId, productVersionId: inline.product.productVersionId, guests: pickedGuests, expectedUnitPriceSatang: inline.product.unitPriceSatang, allocations } });
  };
  const sellWalkIn = (product: Product, guests: number, lead: string) => {
    if (!x || !x.show || inFlight.current || readPending(key)) return;
    void send({ requestKey: newKey(), productName: product.name, kind: "WALK_IN",
      body: { jobSheetId: x.jobSheetId, productVersionId: product.productVersionId, guests, expectedUnitPriceSatang: product.unitPriceSatang, ...(lead.trim() ? { leadName: lead.trim() } : {}) } }, product, guests);
  };

  const ctx: Ctx = { key, x, view, setView, load, check, send, discard, inline, picks, setPick, pickedGuests, pickedTotal, sendPicks, inlineError, soldByRef, busy, reportSent, sellWalkIn };
  return <C.Provider value={ctx}>{children}</C.Provider>;
}

/**
 * The Extras tick after a customer's name: "ขายเพิ่ม +฿200" (its own colour — never the green
 * มาแล้ว check). Ticking only selects; nothing is recorded until Send. A booking of several guests
 * gets a small "how many" once ticked. Already sold: a short "ขายเพิ่มแล้ว ฿…" instead.
 */
export function InlineExtra({ bookingNo, row: given }: { bookingNo?: string | null; row?: GuestRow }) {
  const c = useUpsellJob();
  if (!c || !c.x || !c.x.show) return null;
  const ref = (given?.bookingRef ?? bookingNo ?? "").trim();
  if (!ref) return null;
  const sold = c.soldByRef.get(ref);
  const row = given ?? c.inline?.byRef.get(ref);
  const unit = c.inline?.product.unitPriceSatang;
  const chip = sold && sold.guests > 0 && (
    <span className="ups-row-sold" style={{ fontSize: 12, fontWeight: 700, color: EXTRA.ink, background: EXTRA.bg, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>
      ขายเพิ่มแล้ว {baht(sold.satang)}{sold.guests > 1 ? ` · ${sold.guests}` : ""}
    </span>
  );
  if (c.reportSent) {
    return <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{chip}
      {!chip && <label className="ups-row-closed" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: "#A1A1AA", whiteSpace: "nowrap" }}><input type="checkbox" disabled style={{ width: 16, height: 16, margin: 0 }} />ขายเพิ่ม · ส่งรายงานแล้ว</label>}
    </span>;
  }
  if (!row || row.state !== "SELLABLE" || unit == null) return chip || null;
  const n = c.picks[row.bookingId] ?? 0, on = n > 0;
  const step = { width: 44, height: 44, border: "1px solid #D4D4D8", borderRadius: 8, background: "#fff", fontSize: 18, fontWeight: 700, cursor: "pointer", color: "#18181B" } as const;
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {chip}
      <label className="ups-row-pick" style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 44, padding: "0 10px", border: `1.5px solid ${EXTRA.ink}`, borderRadius: 999, background: on ? EXTRA.bg : "#fff", color: EXTRA.ink, fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", cursor: c.busy ? "default" : "pointer" }}>
        <input type="checkbox" checked={on} disabled={c.busy} onChange={(e) => c.setPick(row.bookingId, e.target.checked ? 1 : 0)} aria-label={`ขายเพิ่ม ${c.inline!.product.name} — ${row.name || "guest"} ${row.bookingRef}`} style={{ width: 18, height: 18, margin: 0, accentColor: EXTRA.ink }} />
        ขายเพิ่ม +{baht(unit)}
      </label>
      {on && row.remaining > 1 && (
        <span className="ups-row-qty" role="group" aria-label={`How many of this booking's ${row.pax} guests`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
          <button type="button" aria-label="One guest fewer" disabled={c.busy || n <= 1} onClick={() => c.setPick(row.bookingId, n - 1)} style={step}>−</button>
          <b aria-live="polite" style={{ minWidth: 18, textAlign: "center" }}>{n}</b>
          <button type="button" aria-label="One guest more" disabled={c.busy || n >= row.remaining} onClick={() => c.setPick(row.bookingId, n + 1)} style={step}>+</button>
          <span style={{ color: "#71717A" }}>of {row.remaining}</span>
        </span>
      )}
    </span>
  );
}
