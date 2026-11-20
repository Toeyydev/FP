"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UpsellHandIn from "@/components/UpsellHandIn";

// The Extras block on the guide's own job sheet (PR3, mockup approved 19 Nov 2026): sell a
// Route Extension, record the cash taken, show the guest a payment confirmation, and see the
// cash held for Folkpaths. Everything shown comes from the server (lib/upsell/sales): the
// price, the guests left, the refs, and the cash held — read from the custody ledger.
//
// Lost connection: a sale's request key and body are saved on the phone BEFORE they are sent,
// and kept until the server gives a definite answer. While the answer is unknown the block
// says "Checking the status…" and asks the server about that same key — it never starts a new
// sale, so the guest's cash is never recorded twice. The key survives closing the app.
//
// Two kinds of Extra, each shown only on a job the server sells it on (its version lists the
// tour): a Route Extension added to the guest's own tour, and a walk-in seat — a new guest
// joining the whole tour (approved mockup pr4w). They never appear as one another.
//
// What the guest is shown is a payment acknowledgement, never called the official receipt: the
// company's official receipt is issued in PEAK, and the block says where that stands (issued,
// being issued, waiting for set-up). No tax invoice — the company is not VAT-registered.

type Kind = "ROUTE_EXTENSION" | "WALK_IN";
type Product = { productCode: string; name: string; productVersionId: string; unitPriceSatang: number; pricingBasis: string; guestsLeft: number; kind: Kind; jobPax: number; seatsPerGuide: number };
type Receipt = { state: "SYNCED" | "QUEUED" | "WAITING" | "CHECKING" | "NONE"; peakCode: string | null };
type Sale = { saleNo: string; jobRef: string | null; productName: string; guests: number; unitPriceSatang: number; pricingBasis: string; grossSatang: number; method: "CASH"; recordedAt: string; kind: Kind; status: string; receipt: Receipt };
type Cash = { heldSatang: number; toRemitSatang: number; remitBy: "BANK_TRANSFER"; remitWhen: "END_TOUR_REPORT"; status: string };
type Extras =
  | { show: false }
  | { show: true; jobSheetId: string; jobRef: string | null; jobPax: number; closed: { code: string; message: string } | null; products: Product[]; sales: Sale[]; cash: Cash };
type Pending = { requestKey: string; body: Record<string, unknown>; productName: string; kind?: Kind };
type View =
  | { kind: "block" }
  | { kind: "sell"; product: Product; guests: number; lead: string; error?: string; restart?: boolean }
  | { kind: "sending" }
  | { kind: "checking"; note?: string }
  | { kind: "notRecorded" }
  | { kind: "confirmed"; sale: Sale };

const C = { ink: "#18181B", soft: "#71717A", brand: "#0E3B2E", line: "#E5E7EB", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
const baht = (satang: number) => `฿${(satang / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const at = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " ·");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
const per = (basis: string) => (basis === "PER_GROUP" ? "per group" : "per guest");
const totalOf = (p: Product, guests: number) => (p.pricingBasis === "PER_GROUP" ? p.unitPriceSatang : p.unitPriceSatang * guests);
/** Where the company's official receipt stands — the guide's words, never "issued" before PEAK has it. */
const receiptLine = (r: Receipt) => r.state === "SYNCED" ? `Official receipt issued in PEAK · ${r.peakCode}`
  : r.state === "QUEUED" ? "Official receipt: being issued in PEAK"
  : r.state === "CHECKING" ? "Official receipt: being checked by the office"
  : r.state === "WAITING" ? "Official receipt: issued in PEAK once the office finishes its set-up"
  : "No official receipt for this sale";
const walkInName = (p: { kind: Kind }) => p.kind === "WALK_IN";
const STATUS: Record<string, string> = {
  NOT_SENT: "Not sent yet", DRAFT: "Not sent yet", SUBMITTED: "Sent — waiting for Admin", RETURNED: "Returned — send again", CONFIRMED: "Confirmed", REVERSED: "Reversed",
};

const btn = (primary: boolean) => ({
  minHeight: 48, width: "100%", borderRadius: 10, border: `1px solid ${C.brand}`, background: primary ? C.brand : "#fff",
  color: primary ? "#fff" : C.brand, font: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer",
}) as const;
const plain = { minHeight: 44, width: "100%", borderRadius: 10, border: "1px solid #D4D4D8", background: "#fff", color: C.ink, font: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer" } as const;

function storeKey(job: { guideId: string; date: string; slotIdx: number }) { return `upsell-pending:${job.guideId}:${job.date}:${job.slotIdx}`; }
function readPending(k: string): Pending | null {
  try { const v = window.localStorage.getItem(k); return v ? (JSON.parse(v) as Pending) : null; } catch { return null; }
}
function writePending(k: string, p: Pending | null) {
  try { if (p) window.localStorage.setItem(k, JSON.stringify(p)); else window.localStorage.removeItem(k); } catch { /* private mode: the server key still guards */ }
}
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export default function UpsellExtras({ guideId, date, slotIdx }: { guideId: string; date: string; slotIdx: number }) {
  const job = { guideId, date, slotIdx };
  const key = storeKey(job);
  const [x, setX] = useState<Extras | null>(null);
  const [view, setView] = useState<View>({ kind: "block" });
  const focusRef = useRef<HTMLElement | null>(null);
  // Two taps can land before React redraws the button away: without this the second would make
  // a second request key — a second sale for the same cash.
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
      writePending(key, null);
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
  useEffect(() => { focusRef.current?.focus(); }, [view.kind]);

  // Send (or send again) the pending sale — always with its own saved key.
  const send = async (p: Pending, product?: Product, guests?: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { await sendOnce(p, product, guests); } finally { inFlight.current = false; }
  };
  const sendOnce = async (p: Pending, product?: Product, guests?: number) => {
    writePending(key, p); // saved before it is sent: survives a closed app or a lost signal
    setView({ kind: "sending" });
    const r = await fetch(p.kind === "WALK_IN" ? "/api/upsell/sales/walk-in" : "/api/upsell/sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestKey: p.requestKey, ...p.body }) }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json();
      writePending(key, null);
      setView({ kind: "confirmed", sale: j.sale });
      void load();
      return;
    }
    if (r && r.status >= 400 && r.status < 500) {
      // A definite refusal: nothing was recorded, so the key is done with.
      const j = await r.json().catch(() => ({}));
      writePending(key, null);
      if (product && guests) setView({ kind: "sell", product, guests, lead: String(p.body.leadName ?? ""), error: j.message ?? "Not recorded.", restart: j.error === "PRICE_CHANGED" || j.error === "NOT_ON_SALE" });
      else { setView({ kind: "block" }); void load(); }
      return;
    }
    await check(); // no answer, or a server error: it may be saved — find out before anything else
  };

  const startSell = (product: Product) => setView({ kind: "sell", product, guests: 1, lead: "" });
  const confirmCash = (product: Product, guests: number, lead: string) => {
    if (!x || !x.show || inFlight.current || readPending(key)) return;
    void send({
      requestKey: newKey(),
      body: { jobSheetId: x.jobSheetId, productVersionId: product.productVersionId, guests, expectedUnitPriceSatang: product.unitPriceSatang,
        ...(product.kind === "WALK_IN" && lead.trim() ? { leadName: lead.trim() } : {}) },
      productName: product.name, kind: product.kind,
    }, product, guests);
  };

  if (!x) return null;
  const pending = readPending(key);
  if (!x.show && !pending && view.kind === "block") return null;

  const shell = (children: React.ReactNode) => (
    <section className="js-upsell no-print" aria-labelledby="ups-h" style={{ borderTop: `1px solid ${C.line}`, marginTop: 14, paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      {children}
    </section>
  );
  const heading = (text: string, thai?: string) => (
    <h3 id="ups-h" tabIndex={-1} ref={(el) => { focusRef.current = el; }} style={{ margin: 0, fontSize: 15, outline: "none" }}>
      {text}{thai && <small style={{ fontSize: 12, fontWeight: 500, color: C.soft }}> {thai}</small>}
    </h3>
  );

  if (view.kind === "checking" || view.kind === "sending") {
    return shell(<>
      {heading("Extras", "ขายเพิ่ม")}
      <div role="status" className="ups-checking" style={{ background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "10px 12px", color: C.warnInk, fontWeight: 700 }}>
        {view.kind === "sending" ? "Recording…" : "Checking the status…"}
        <br /><small style={{ fontWeight: 500 }}>
          {view.kind === "sending" ? "Keep the cash in hand until this says Recorded." : <>The sale may already be saved. Keep the cash and don’t sell again — we are asking the server about this same sale.<br />กำลังตรวจสอบสถานะ อาจบันทึกแล้ว ห้ามขายซ้ำ</>}
          {view.kind === "checking" && view.note && <><br />{view.note}</>}
        </small>
      </div>
      {view.kind === "checking" && <button type="button" className="ups-check" onClick={() => void check()} style={btn(true)}>Check again</button>}
    </>);
  }

  if (view.kind === "notRecorded" && pending) {
    return shell(<>
      {heading("Extras", "ขายเพิ่ม")}
      <div role="alert" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk, fontWeight: 700 }}>
        Not recorded<br /><small style={{ fontWeight: 500 }}>The server never received this sale. Send it again — it keeps the same request, so it can only be recorded once.</small>
      </div>
      <button type="button" className="ups-resend" onClick={() => void send(pending)} style={btn(true)}>Send again</button>
      <button type="button" onClick={() => { writePending(key, null); setView({ kind: "block" }); void load(); }} style={plain}>Discard — the guest did not pay</button>
    </>);
  }

  if (view.kind === "confirmed") {
    const s = view.sale;
    return shell(<>
      <div role="status" className="ups-recorded" style={{ display: "flex", alignItems: "center", gap: 10, background: C.okBg, border: `1px solid ${C.okLine}`, borderRadius: 12, padding: "12px 14px", color: C.okInk, fontWeight: 700 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        <span>Recorded · {baht(s.grossSatang)} cash with you<br /><small style={{ fontWeight: 500 }}>บันทึกแล้ว · เงินสด {(s.grossSatang / 100).toLocaleString("en-US")} บาทอยู่กับคุณ</small></span>
      </div>
      <div className="ups-confirmation" aria-labelledby="ups-h" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: C.brand, fontWeight: 700 }}>Folkpaths · payment acknowledgement</div>
          {heading(s.productName)}
        </div>
        <div>
          <div style={{ fontSize: 12.5, color: C.soft }}>Sale Ref</div>
          <div className="ups-sale-ref" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{s.saleNo}</div>
        </div>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px 12px", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
          <dt style={{ color: C.soft }}>Guests</dt><dd style={{ margin: 0, textAlign: "right" }}>{s.pricingBasis === "PER_GROUP" ? `${s.guests} · ${baht(s.unitPriceSatang)} per group` : `${s.guests} × ${baht(s.unitPriceSatang)}`}</dd>
          <dt style={{ color: C.soft }}>Paid in cash</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 800, fontSize: 17 }}>{baht(s.grossSatang)}</dd>
          <dt style={{ color: C.soft }}>Date</dt><dd style={{ margin: 0, textAlign: "right" }}>{at(s.recordedAt)}</dd>
        </dl>
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 10, fontSize: 12.5, color: C.soft, display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="ups-job-ref">Job Ref {s.jobRef ?? "—"}</span>
          {s.kind === "WALK_IN" && <span className="ups-walkin-added">Added to this job’s guest list · เพิ่มในรายชื่อแขกของงานนี้แล้ว</span>}
          <span className="ups-receipt-state">{receiptLine(s.receipt)}</span>
          <span>This acknowledges the cash paid to Folkpaths; it is not the official receipt. No tax invoice — Folkpaths is not VAT-registered.<br />ยืนยันการรับชำระเงินเท่านั้น ใบเสร็จรับเงินฉบับทางการออกจากระบบ PEAK ของบริษัท</span>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Show this payment acknowledgement to the guest. The Sale Ref and Job Ref are made by the system — nothing here can be typed or changed.</p>
      <button type="button" className="ups-back" onClick={() => setView({ kind: "block" })} style={btn(true)}>Back to the job</button>
      <p style={{ margin: 0, fontSize: 12.5, color: C.soft }}>Recorded the wrong number? Tell the operator — a recorded sale can’t be deleted from your phone.</p>
    </>);
  }

  if (view.kind === "sell") {
    const { product: p, guests, lead } = view;
    const walkIn = walkInName(p);
    const total = totalOf(p, guests);
    const max = p.guestsLeft;
    return shell(<>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          {heading(walkIn ? "Walk-in seat — joins this tour" : `Sell ${p.name}`)}
          <div style={{ fontSize: 13, color: C.soft, marginTop: 2 }}>{walkIn ? `${p.name} · a new guest joins the whole tour you are giving now` : "On this job"}{x.show && x.jobRef ? ` · ${x.jobRef}` : ""}</div>
        </div>
        <button type="button" aria-label="Close" onClick={() => setView({ kind: "block" })} style={{ width: 44, height: 44, flex: "none", border: "1px solid #D4D4D8", borderRadius: 10, background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.ink} strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {view.error && (
        <div role="alert" className="ups-error" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk, fontWeight: 700 }}>
          Not recorded<br /><small style={{ fontWeight: 500 }}>{view.error}</small>
        </div>
      )}
      {view.restart ? (
        <button type="button" className="ups-restart" onClick={() => { setView({ kind: "block" }); void load(); }} style={plain}>Start again</button>
      ) : <>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor="ups-guests" style={{ fontWeight: 700, fontSize: 14 }}>{walkIn ? "New guests" : "Guests"} <small style={{ fontWeight: 500, color: C.soft }}>{walkIn ? "แขกใหม่" : "จำนวนแขก"}</small></label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" aria-label="One guest fewer" disabled={guests <= 1} onClick={() => setView({ ...view, guests: guests - 1, error: undefined })} style={{ width: 48, height: 48, border: "1px solid #D4D4D8", borderRadius: 10, background: "#fff", fontSize: 22, fontWeight: 700, cursor: "pointer", color: C.ink }}>−</button>
            <input id="ups-guests" type="number" readOnly value={guests} aria-describedby="ups-guests-hint" style={{ width: 72, height: 48, boxSizing: "border-box", textAlign: "center", border: "1px solid #D4D4D8", borderRadius: 10, font: "inherit", fontSize: 20, fontWeight: 800, background: "#F7F7F5", color: C.ink }} />
            <button type="button" aria-label="One guest more" disabled={guests >= max} onClick={() => setView({ ...view, guests: guests + 1, error: undefined })} style={{ width: 48, height: 48, border: "1px solid #D4D4D8", borderRadius: 10, background: "#fff", fontSize: 22, fontWeight: 700, cursor: "pointer", color: C.ink }}>+</button>
          </div>
          {walkIn
            ? <div id="ups-guests-hint" className="ups-seats" style={{ fontSize: 12.5, color: C.soft }}>Seats left on this job: {max} of {p.seatsPerGuide} ({p.jobPax} guests now) · ที่นั่งว่าง {max}</div>
            : <div id="ups-guests-hint" style={{ fontSize: 12.5, color: C.soft }}>Up to {max}{x.show && max < x.jobPax ? ` now — ${x.jobPax} guests on this job, ${x.jobPax - max} already bought it` : " — the guests on this job"} · ไม่เกินจำนวนแขกในงานนี้</div>}
        </div>
        {walkIn && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="ups-lead" style={{ fontWeight: 700, fontSize: 14 }}>Lead guest’s name <small style={{ fontWeight: 500, color: C.soft }}>optional · ไม่บังคับ</small></label>
            <input id="ups-lead" value={lead} maxLength={120} autoComplete="off" onChange={(e) => setView({ ...view, lead: e.target.value })} placeholder="Leave empty if the guest prefers"
              style={{ minHeight: 48, border: "1px solid #D4D4D8", borderRadius: 10, padding: "0 12px", font: "inherit", fontSize: 15 }} />
            <div style={{ fontSize: 12.5, color: C.soft }}>Shown on the guest list. Empty: “Walk-in · Sale Ref”.</div>
          </div>
        )}
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px 12px", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
          <dt style={{ color: C.soft }}>Price {per(p.pricingBasis)}</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 700 }}>{baht(p.unitPriceSatang)} <small style={{ fontWeight: 500, color: C.soft }}>{walkIn ? "the total the guest pays" : "set by Folkpaths"}</small></dd>
          <dt style={{ color: C.soft }}>Payment</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 700 }}>Cash to you <small style={{ fontWeight: 500, color: C.soft }}>เงินสด</small></dd>
        </dl>
        <div style={{ background: "#F4F4F5", borderRadius: 10, padding: 12, fontVariantNumeric: "tabular-nums" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, fontWeight: 800 }}><span>Collect from the guest</span><span className="ups-total">{baht(total)}</span></div>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>This cash belongs to Folkpaths. Amount to remit: the full {baht(total)}, with this job’s end-tour report.<br /><small style={{ color: C.soft }}>เงินนี้เป็นของบริษัท ยอดนำส่งเต็ม {baht(total)} พร้อมรายงานจบทัวร์ของงานนี้</small></p>
        {walkIn && <p style={{ margin: 0, fontSize: 13 }}>They are added to this job’s guest list. Nothing is added to the price.</p>}
        <button type="button" className="ups-confirm" disabled={max < 1 || guests > max} onClick={() => confirmCash(p, guests, lead)} style={{ ...btn(true), minHeight: 52, fontSize: 16, fontWeight: 800 }}>
          I’ve received {baht(total)} cash<br /><small style={{ fontWeight: 500, fontSize: 12.5 }}>รับเงินสดแล้ว</small>
        </button>
        <button type="button" onClick={() => setView({ kind: "block" })} style={plain}>Cancel</button>
      </>}
    </>);
  }

  // The block.
  if (!x.show) return null;
  const cashRows = x.sales.length > 0 || x.cash.heldSatang !== 0;
  return shell(<>
    {heading("Extras", "ขายเพิ่ม")}
    {!x.closed && x.products.map((p) => (
      <div key={p.productCode} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {p.kind === "WALK_IN" ? <>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}><b>Walk-in seat</b> — a new guest joins this tour for <b>{baht(p.unitPriceSatang)} a guest</b>, the total they pay. {p.guestsLeft} of {p.seatsPerGuide} seats left.<br /><small style={{ color: C.soft }}>แขก walk-in ร่วมทัวร์นี้ คนละ {(p.unitPriceSatang / 100).toLocaleString("en-US")} บาท</small></p>
          {p.guestsLeft > 0
            ? <button type="button" className="ups-sell ups-sell-walkin" onClick={() => startSell(p)} style={btn(false)}>Sell a walk-in seat</button>
            : <p className="ups-full" style={{ margin: 0, fontSize: 13, color: C.soft }}>No walk-in seats left on this job ({p.seatsPerGuide} guests per guide). Ask Operations.</p>}
        </> : <>
          {x.sales.length === 0 && <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>Guests on this tour can add <b>{p.name}</b> for <b>{baht(p.unitPriceSatang)} {per(p.pricingBasis)}</b>.<br /><small style={{ color: C.soft }}>ขายเพิ่ม {p.name} {p.pricingBasis === "PER_GROUP" ? "ต่อกลุ่ม" : "คนละ"} {(p.unitPriceSatang / 100).toLocaleString("en-US")} บาท</small></p>}
          {p.guestsLeft > 0
            ? <button type="button" className="ups-sell" onClick={() => startSell(p)} style={btn(x.sales.length === 0)}>{x.sales.length === 0 ? `Sell ${p.name}` : `Sell ${p.name} to more guests`}</button>
            : <p style={{ margin: 0, fontSize: 13, color: C.soft }}>Every guest on this job already has {p.name}.</p>}
        </>}
      </div>
    ))}
    {x.closed && x.sales.length > 0 && <p style={{ margin: 0, fontSize: 13, color: C.soft }}>{x.closed.message}</p>}
    {x.sales.length > 0 && (
      <ul className="ups-sales" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {x.sales.map((s) => (
          <li key={s.saleNo} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 10, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
            <span><b>{s.kind === "WALK_IN" ? "Walk-in seat" : s.productName}</b> · {s.guests} {s.guests === 1 ? "guest" : "guests"}{s.status === "REVERSED" ? " · reversed" : ""}<br /><small style={{ color: C.soft, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{s.saleNo}</small><small style={{ color: C.soft }}> · cash · {time(s.recordedAt)}</small><br /><small className="ups-sale-receipt" style={{ color: C.soft }}>{receiptLine(s.receipt)}</small></span>
            <b>{baht(s.grossSatang)}</b>
            {(x.cash.status === "NOT_SENT" || x.cash.status === "DRAFT" || x.cash.status === "RETURNED") && <ErrorReversal saleNo={s.saleNo} />}
          </li>
        ))}
      </ul>
    )}
    {cashRows && (
      <dl className="ups-cash" style={{ margin: 0, background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: 12, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)", gap: "6px 12px", fontSize: 13.5, color: C.warnInk, fontVariantNumeric: "tabular-nums" }}>
        <dt>Cash held <small>เงินสดที่ถืออยู่</small></dt><dd className="ups-held" style={{ margin: 0, textAlign: "right", fontWeight: 800 }}>{baht(x.cash.heldSatang)}</dd>
        <dt style={{ fontWeight: 800, fontSize: 15 }}>Amount to remit <small style={{ fontWeight: 500, fontSize: 12 }}>ยอดที่ต้องนำส่ง</small></dt><dd className="ups-remit" style={{ margin: 0, textAlign: "right", fontWeight: 800, fontSize: 16 }}>{baht(x.cash.toRemitSatang)}</dd>
        <dt>Remit when</dt><dd style={{ margin: 0, textAlign: "right" }}>With this job’s end-tour report</dd>
        <dt>Remit by</dt><dd style={{ margin: 0, textAlign: "right" }}>Bank transfer to Folkpaths only · upload the slip</dd>
        <dt>Remittance status</dt><dd className="ups-status" style={{ margin: 0, textAlign: "right", fontWeight: 700 }}>{STATUS[x.cash.status] ?? x.cash.status}</dd>
        <dt>Guide payout</dt><dd style={{ margin: 0, textAlign: "right" }}>Unchanged</dd>
      </dl>
    )}
    {x.closed?.code === "REPORT_SENT" && <UpsellHandIn jobSheetId={x.jobSheetId} />}
  </>);
}

/** "This sale was recorded in error": the guide confirms the server's exact statement; an Admin
 *  decides (only then does the cash held change). Not after the hand-in is sent or confirmed. */
function ErrorReversal({ saleNo }: { saleNo: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setOpen(true); setMsg("");
    const r = await fetch(`/api/upsell/sales/${encodeURIComponent(saleNo)}/reversal`, { cache: "no-store" });
    if (r.ok) setText((await r.json()).affirmationText);
  };
  const submit = async () => {
    setBusy(true);
    const r = await fetch(`/api/upsell/sales/${encodeURIComponent(saleNo)}/reversal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ affirmationText: text, reason }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setMsg(r.ok ? "Sent to Admin — nothing changes until Admin approves it." : (d.reasons ?? [d.error]).join(" "));
    if (r.ok) setOpen(false);
  };
  if (!open) return (
    <div style={{ flexBasis: "100%" }}>
      <button type="button" className="ups-error-reversal" onClick={() => void start()} style={{ minHeight: 44, padding: "0 10px", border: 0, background: "none", color: C.badInk, font: "inherit", fontSize: 13, fontWeight: 700, textDecoration: "underline", cursor: "pointer" }}>Recorded in error?</button>
      {msg && <small role="status" style={{ display: "block", color: C.soft }}>{msg}</small>}
    </div>
  );
  return (
    <div className="ups-reversal-form" style={{ flexBasis: "100%", border: `1px solid ${C.badLine}`, background: C.badBg, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8, color: C.badInk }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, minHeight: 44 }}>
        <input type="checkbox" checked={agree} disabled={!text} onChange={(e) => setAgree(e.target.checked)} style={{ width: 20, height: 20, flex: "none", marginTop: 2 }} />
        <span>{text ?? "…"}</span>
      </label>
      <label htmlFor={`ups-rev-${saleNo}`} style={{ fontWeight: 700, fontSize: 13.5 }}>What happened?</label>
      <input id={`ups-rev-${saleNo}`} value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 44, border: "1px solid #A1A1AA", borderRadius: 8, padding: "8px 10px", font: "inherit" }} placeholder="e.g. pressed Sell twice for the same guest" />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setOpen(false)} style={plain}>Cancel</button>
        <button type="button" disabled={busy || !agree || reason.trim().length < 5} onClick={() => void submit()} style={{ ...plain, background: C.badInk, color: "#fff", borderColor: C.badInk }}>Send to Admin</button>
      </div>
      {msg && <small role="alert">{msg}</small>}
    </div>
  );
}
