"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import UpsellHandIn from "@/components/UpsellHandIn";
import WalkInGuestQr from "@/components/WalkInGuestQr";
import { EXTRA, InlineExtra, baht, readPending, useUpsellJob, type Product, type Receipt } from "@/components/upsell/UpsellJob";

// The Extras block on the guide's own job sheet, under "Your customers" (owner, 20 Nov 2026:
// "ถ้าขายติ๊กหลังชื่อลูกค้า แล้ว send to admin แล้วก็เพิ่ม ref. ในการโอนเงิน"; mockup v11):
//  • the guide ticks "ขายเพิ่ม +฿200" after each customer's name (components/upsell/UpsellJob);
//  • here, ONE Send to Admin · ยืนยันเก็บเงินแล้ว ฿X records it — the cash-received statement
//    (allocations, cash custody, PEAK receipt queue in one transaction); nothing else to confirm;
//  • the sales, each visible to Admin at once (Finance › Extras cash), and ONE ref.โอนเงิน — the
//    Job Ref — for the transfer memo. "Recorded in error" stays hidden under แก้ไข….
// A walk-in seat (a new guest joining the tour) keeps its own entry and the guest QR.
//
// What the guest is shown is a payment confirmation only — "ยืนยันการชำระเงินเท่านั้น" (owner,
// 20 Nov 2026): the official receipt lives in PEAK.

const C = { ink: "#18181B", soft: "#71717A", brand: "#0E3B2E", line: "#E5E7EB", warnBg: "#FBF4E4", warnLine: "#EADFC3", warnInk: "#5C3B06", okBg: "#EAF4EF", okLine: "#CBE5D6", okInk: "#0E5A33", badBg: "#FBEDEA", badLine: "#EFCFC7", badInk: "#8A2A1C" };
const at = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", " ·");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit" });
/** The sale's PEAK sync status, short, for the guide's own list (never shown to the guest). */
const peakLine = (r: Receipt) => r.state === "SYNCED" ? `PEAK: synced · ${r.peakCode}`
  : r.state === "QUEUED" ? "PEAK: queued"
  : r.state === "CHECKING" ? "PEAK: being checked"
  : r.state === "WAITING" ? "PEAK: waiting for set-up"
  : "";
const STATUS: Record<string, string> = {
  NOT_SENT: "Not handed in yet", DRAFT: "Not handed in yet", SUBMITTED: "Slip sent — Admin is checking", RETURNED: "Returned — send again", CONFIRMED: "Confirmed", REVERSED: "Reversed",
};
const btn = (primary: boolean) => ({
  minHeight: 48, width: "100%", borderRadius: 10, border: `1px solid ${C.brand}`, background: primary ? C.brand : "#fff",
  color: primary ? "#fff" : C.brand, font: "inherit", fontSize: 15, fontWeight: 700, cursor: "pointer",
}) as const;
const plain = { minHeight: 44, width: "100%", borderRadius: 10, border: "1px solid #D4D4D8", background: "#fff", color: C.ink, font: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer" } as const;
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** ref.โอนเงิน — the one code the guide puts in the transfer memo: this job's Job Ref. */
export function TransferRef({ jobRef }: { jobRef: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!jobRef) return null;
  const copy = async () => { try { await navigator.clipboard.writeText(jobRef); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select it by hand */ } };
  return (
    <div className="ups-transfer-ref" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, border: `1px dashed ${C.brand}`, borderRadius: 10, padding: "8px 12px" }}>
      <span style={{ minWidth: 0 }}>
        <small style={{ color: C.soft, fontSize: 12 }}>ref.โอนเงิน — ใส่ในบันทึกช่วยจำตอนโอน</small><br />
        <b className="ups-transfer-ref-code" style={{ fontFamily: mono, fontSize: 16, overflowWrap: "anywhere", userSelect: "all" }}>{jobRef}</b>
      </span>
      <button type="button" className="ups-copy-ref" onClick={() => void copy()} style={{ minHeight: 44, padding: "0 14px", flex: "none", borderRadius: 8, border: `1px solid ${C.brand}`, background: "#fff", color: C.brand, font: "inherit", fontWeight: 700, cursor: "pointer" }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export default function UpsellExtras() {
  const c = useUpsellJob();
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { focusRef.current?.focus(); }, [c?.view.kind]);
  if (!c || !c.x) return null;
  const { x, view, setView } = c;
  const pending = readPending(c.key);
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
      {view.kind === "checking" && <button type="button" className="ups-check" onClick={() => void c.check()} style={btn(true)}>Check again</button>}
    </>);
  }

  if (view.kind === "notRecorded" && pending) {
    return shell(<>
      {heading("Extras", "ขายเพิ่ม")}
      <div role="alert" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk, fontWeight: 700 }}>
        Not recorded<br /><small style={{ fontWeight: 500 }}>The server never received this sale. Send it again — it keeps the same request, so it can only be recorded once.</small>
      </div>
      <button type="button" className="ups-resend" onClick={() => void c.send(pending)} style={btn(true)}>Send again</button>
      <button type="button" onClick={c.discard} style={plain}>Discard — the guest did not pay</button>
    </>);
  }

  if (view.kind === "confirmed") {
    const s = view.sale;
    return shell(<>
      <div role="status" className="ups-recorded" style={{ display: "flex", alignItems: "center", gap: 10, background: C.okBg, border: `1px solid ${C.okLine}`, borderRadius: 12, padding: "12px 14px", color: C.okInk, fontWeight: 700 }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        <span>ส่งให้ Admin แล้ว · {s.guests} {s.guests === 1 ? "guest" : "guests"} · {baht(s.grossSatang)}<br /><small style={{ fontWeight: 500 }}>Recorded — Admin sees it in Extras cash. The cash stays with you until you hand it in.</small></span>
      </div>
      <div className="ups-confirmation" aria-labelledby="ups-h" style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 14, padding: "16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: C.brand, fontWeight: 700 }}>Folkpaths · Payment confirmation</div>
          {heading(s.productName)}
        </div>
        <div>
          <div style={{ fontSize: 12.5, color: C.soft }}>Sale Ref</div>
          <div className="ups-sale-ref" style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, overflowWrap: "anywhere" }}>{s.saleNo}</div>
        </div>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "8px 12px", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
          {(s.allocations ?? []).map((a) => <Fragment key={a.bookingRef + a.guests}><dt className="ups-alloc" style={{ color: C.ink, overflowWrap: "anywhere" }}>{a.name || "Guest"} <small style={{ color: C.soft, fontFamily: mono }}>{a.bookingRef}</small></dt><dd style={{ margin: 0, textAlign: "right" }}>{a.guests} × {baht(s.unitPriceSatang)}</dd></Fragment>)}
          {!(s.allocations ?? []).length && <><dt style={{ color: C.soft }}>Guests</dt><dd style={{ margin: 0, textAlign: "right" }}>{s.pricingBasis === "PER_GROUP" ? `${s.guests} · ${baht(s.unitPriceSatang)} per group` : `${s.guests} × ${baht(s.unitPriceSatang)}`}</dd></>}
          <dt style={{ color: C.soft }}>Paid in cash</dt><dd style={{ margin: 0, textAlign: "right", fontWeight: 800, fontSize: 17 }}>{baht(s.grossSatang)}</dd>
          <dt style={{ color: C.soft }}>Date</dt><dd style={{ margin: 0, textAlign: "right" }}>{at(s.recordedAt)}</dd>
        </dl>
        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 10, fontSize: 12.5, color: C.soft, display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="ups-job-ref">Job Ref {s.jobRef ?? "—"}</span>
          {s.kind === "WALK_IN" && <span className="ups-walkin-added">Added to this job’s guest list · เพิ่มในรายชื่อแขกของงานนี้แล้ว</span>}
          <span className="ups-confirmation-only">ยืนยันการชำระเงินเท่านั้น · Payment confirmation only</span>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>Show this payment confirmation to the guest if they ask. Nothing here can be typed or changed.</p>
      <button type="button" className="ups-back" onClick={() => setView({ kind: "block" })} style={btn(true)}>Back to the job</button>
    </>);
  }

  if (view.kind === "sell") return shell(<WalkInSell />);

  // The block.
  if (!x.show) return null;
  const editable = x.cash.status === "NOT_SENT" || x.cash.status === "DRAFT" || x.cash.status === "RETURNED";
  const inline = c.inline;
  const walkIns = x.closed ? [] : x.products.filter((p) => p.kind === "WALK_IN");
  const otherRe = x.closed ? [] : x.products.filter((p) => p.kind === "ROUTE_EXTENSION" && p !== inline?.product);
  return shell(<>
    {heading("Extras", "ขายเพิ่ม")}
    {inline && !x.closed && (
      <div className="ups-send-box" style={{ border: `1px solid ${c.pickedGuests ? EXTRA.ink : C.line}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {inline.offSheet.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <small style={{ color: C.soft }}>Also booked on this job (not in the list above):</small>
            {inline.offSheet.map((r) => <div key={r.bookingId} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13.5 }}><span><b>{r.name || "Guest"}</b> <small style={{ color: C.soft }}>· {r.bookingRef} · {r.pax} pax</small></span><InlineExtra row={r} /></div>)}
          </div>
        )}
        {c.pickedGuests > 0 ? <>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}><span>{inline.product.name} · {c.pickedGuests} {c.pickedGuests === 1 ? "guest" : "guests"}</span><span className="ups-total">{baht(c.pickedTotal)}</span></div>
          <button type="button" className="ups-send-admin" disabled={c.busy} onClick={c.sendPicks} style={{ ...btn(true), minHeight: 52, fontSize: 16, fontWeight: 800 }}>Send to Admin · ยืนยันเก็บเงินแล้ว {baht(c.pickedTotal)}</button>
          <small style={{ color: C.soft }}>Press once the cash is in your hand. The cash belongs to Folkpaths — hand it in with this job.</small>
        </> : <small className="ups-tick-hint" style={{ color: C.soft }}>Sold {inline.product.name}? Tick <b style={{ color: EXTRA.ink }}>ขายเพิ่ม +{baht(inline.product.unitPriceSatang)}</b> after the guest’s name, then Send to Admin. Ticking alone records nothing.</small>}
        {c.inlineError && <div role="alert" className="ups-error" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "8px 12px", color: C.badInk, fontSize: 13.5 }}>{c.inlineError}</div>}
      </div>
    )}
    {otherRe.map((p) => <p key={p.productCode} style={{ margin: 0, fontSize: 12.5, color: C.soft }}>{p.name} is also on sale on this job — ask the operator.</p>)}
    {walkIns.map((p) => (
      <div key={p.productCode} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}><b>Walk-in seat</b> — a new guest joins this tour for <b>{baht(p.unitPriceSatang)} a guest</b>, the total they pay. {p.guestsLeft} of {p.seatsPerGuide} seats left.<br /><small style={{ color: C.soft }}>แขก walk-in ร่วมทัวร์นี้ คนละ {(p.unitPriceSatang / 100).toLocaleString("en-US")} บาท</small></p>
        {p.guestsLeft > 0
          ? <button type="button" className="ups-sell ups-sell-walkin" onClick={() => setView({ kind: "sell", product: p, guests: 1, lead: "" })} style={btn(false)}>Sell a walk-in seat</button>
          : <p className="ups-full" style={{ margin: 0, fontSize: 13, color: C.soft }}>No walk-in seats left on this job ({p.seatsPerGuide} guests per guide). Ask Operations.</p>}
        <WalkInGuestQr jobSheetId={x.jobSheetId} onSold={() => void c.load()} />
      </div>
    ))}
    {x.closed && x.sales.length > 0 && x.closed.code !== "REPORT_SENT" && <p style={{ margin: 0, fontSize: 13, color: C.soft }}>{x.closed.message}</p>}
    {x.sales.length > 0 && (
      <ul className="ups-sales" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {x.sales.map((s) => (
          <li key={s.saleNo} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "4px 10px", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ minWidth: 0, flex: "1 1 200px" }}><b>{s.kind === "WALK_IN" ? "Walk-in seat" : s.productName}</b> · {s.guests} {s.guests === 1 ? "guest" : "guests"}{s.status === "REVERSED" ? " · reversed" : ""}
              <br /><small style={{ color: C.soft, fontFamily: mono }}>{s.saleNo}</small><small style={{ color: C.soft }}> · cash · {time(s.recordedAt)}{s.status !== "REVERSED" ? " · " : ""}</small>{s.status !== "REVERSED" && <small className="ups-sale-admin" style={{ color: C.okInk, fontWeight: 700 }}>ส่งให้ Admin แล้ว</small>}
              {(s.allocations ?? []).length > 0 && <><br /><small className="ups-sale-guests" style={{ color: C.soft }}>{s.allocations!.map((a) => `${a.name || "Guest"} (${a.bookingRef}) × ${a.guests}${a.status === "RELEASED" ? " · reversed" : ""}`).join(" · ")}</small></>}
              {peakLine(s.receipt) && <><br /><small className="ups-sale-peak" style={{ color: C.soft }}>{peakLine(s.receipt)}</small></>}</span>
            <b>{baht(s.grossSatang)}</b>
            {editable && s.status !== "REVERSED" && <SaleEdit saleNo={s.saleNo} />}
          </li>
        ))}
      </ul>
    )}
    {(x.sales.length > 0 || x.cash.heldSatang !== 0) && <>
      {x.closed?.code !== "REPORT_SENT" && <TransferRef jobRef={x.jobRef} />}
      <dl className="ups-cash" style={{ margin: 0, background: C.warnBg, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: 12, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.3fr)", gap: "6px 12px", fontSize: 13.5, color: C.warnInk, fontVariantNumeric: "tabular-nums" }}>
        <dt>Cash held <small>เงินสดที่ถืออยู่</small></dt><dd className="ups-held" style={{ margin: 0, textAlign: "right", fontWeight: 800 }}>{baht(x.cash.heldSatang)}</dd>
        <dt style={{ fontWeight: 800 }}>To hand in <small style={{ fontWeight: 500, fontSize: 12 }}>ยอดที่ต้องนำส่ง</small></dt><dd className="ups-remit" style={{ margin: 0, textAlign: "right", fontWeight: 800, fontSize: 16 }}>{baht(x.cash.toRemitSatang)}</dd>
        <dt>Hand-in</dt><dd className="ups-status" style={{ margin: 0, textAlign: "right", fontWeight: 700 }}>{STATUS[x.cash.status] ?? x.cash.status}</dd>
        <dt>Guide payout</dt><dd style={{ margin: 0, textAlign: "right" }}>Unchanged</dd>
      </dl>
      {x.closed?.code !== "REPORT_SENT" && x.cash.toRemitSatang > 0 && <small className="ups-next" style={{ color: C.soft }}>Next: send the end-tour report, then transfer with the ref above and upload the slip here.</small>}
    </>}
    {x.closed?.code === "REPORT_SENT" && <UpsellHandIn jobSheetId={x.jobSheetId} />}
  </>);
}

/** The walk-in seat form (a new guest joining the tour) — unchanged in substance. */
function WalkInSell() {
  const c = useUpsellJob()!;
  const view = c.view;
  if (view.kind !== "sell" || !c.x || !c.x.show) return null;
  const { product: p, lead, guests } = view;
  const max = p.guestsLeft;
  const total = p.pricingBasis === "PER_GROUP" ? p.unitPriceSatang : p.unitPriceSatang * guests;
  const set = (v: Partial<typeof view>) => c.setView({ ...view, ...v });
  const stepBtn = { width: 48, height: 48, border: "1px solid #D4D4D8", borderRadius: 10, background: "#fff", fontSize: 22, fontWeight: 700, cursor: "pointer", color: C.ink } as const;
  return <>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <div>
        <h3 id="ups-h" style={{ margin: 0, fontSize: 15 }}>Walk-in seat — joins this tour</h3>
        <div style={{ fontSize: 13, color: C.soft, marginTop: 2 }}>{p.name} · a new guest joins the whole tour you are giving now{c.x.jobRef ? ` · ${c.x.jobRef}` : ""}</div>
      </div>
      <button type="button" aria-label="Close" onClick={() => c.setView({ kind: "block" })} style={{ width: 44, height: 44, flex: "none", border: "1px solid #D4D4D8", borderRadius: 10, background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.ink} strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
    {view.error && <div role="alert" className="ups-error" style={{ background: C.badBg, border: `1px solid ${C.badLine}`, borderRadius: 10, padding: "10px 12px", color: C.badInk, fontWeight: 700 }}>Not recorded<br /><small style={{ fontWeight: 500 }}>{view.error}</small></div>}
    {view.restart ? <button type="button" className="ups-restart" onClick={() => { c.setView({ kind: "block" }); void c.load(); }} style={plain}>Start again</button> : <>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="ups-guests" style={{ fontWeight: 700, fontSize: 14 }}>New guests <small style={{ fontWeight: 500, color: C.soft }}>แขกใหม่</small></label>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" aria-label="One guest fewer" disabled={guests <= 1} onClick={() => set({ guests: guests - 1, error: undefined })} style={stepBtn}>−</button>
          <input id="ups-guests" type="number" readOnly value={guests} style={{ width: 72, height: 48, boxSizing: "border-box", textAlign: "center", border: "1px solid #D4D4D8", borderRadius: 10, font: "inherit", fontSize: 20, fontWeight: 800, background: "#F7F7F5", color: C.ink }} />
          <button type="button" aria-label="One guest more" disabled={guests >= max} onClick={() => set({ guests: guests + 1, error: undefined })} style={stepBtn}>+</button>
        </div>
        <div className="ups-seats" style={{ fontSize: 12.5, color: C.soft }}>Seats left on this job: {max} of {p.seatsPerGuide} ({p.jobPax} guests now) · ที่นั่งว่าง {max}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="ups-lead" style={{ fontWeight: 700, fontSize: 14 }}>Lead guest’s name <small style={{ fontWeight: 500, color: C.soft }}>optional · ไม่บังคับ</small></label>
        <input id="ups-lead" value={lead} maxLength={120} autoComplete="off" onChange={(e) => set({ lead: e.target.value })} placeholder="Leave empty if the guest prefers" style={{ minHeight: 48, border: "1px solid #D4D4D8", borderRadius: 10, padding: "0 12px", font: "inherit", fontSize: 15 }} />
        <div style={{ fontSize: 12.5, color: C.soft }}>Shown on the guest list. Empty: “Walk-in · Sale Ref”.</div>
      </div>
      <div style={{ background: "#F4F4F5", borderRadius: 10, padding: 12, fontVariantNumeric: "tabular-nums" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, fontWeight: 800 }}><span>Collect from the guest</span><span className="ups-total">{baht(total)}</span></div>
      </div>
      <p style={{ margin: 0, fontSize: 13 }}>They are added to this job’s guest list. Nothing is added to the price. The cash belongs to Folkpaths.</p>
      <button type="button" className="ups-confirm" disabled={max < 1 || guests > max} onClick={() => c.sellWalkIn(p as Product, guests, lead)} style={{ ...btn(true), minHeight: 52, fontSize: 16, fontWeight: 800 }}>
        I’ve received {baht(total)} cash<br /><small style={{ fontWeight: 500, fontSize: 12.5 }}>รับเงินสดแล้ว</small>
      </button>
      <button type="button" onClick={() => c.setView({ kind: "block" })} style={plain}>Cancel</button>
    </>}
  </>;
}

/**
 * แก้ไข… — closed unless opened. Inside, only on purpose: "บันทึกผิด — ไม่ได้รับเงินสด" (this sale
 * was recorded in error). The guide confirms the server's exact statement and gives a reason; an
 * Admin decides — only then does the cash held change. Never part of Send.
 */
function SaleEdit({ saleNo }: { saleNo: string }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [form, setForm] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => { setForm(false); setAgree(false); setReason(""); if (ref.current) ref.current.open = false; };
  const start = async () => {
    setForm(true); setMsg("");
    const r = await fetch(`/api/upsell/sales/${encodeURIComponent(saleNo)}/reversal`, { cache: "no-store" });
    if (r.ok) setText((await r.json()).affirmationText);
  };
  const submit = async () => {
    setBusy(true);
    const r = await fetch(`/api/upsell/sales/${encodeURIComponent(saleNo)}/reversal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ affirmationText: text, reason }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { close(); setMsg("Sent to Admin — nothing changes until Admin approves it."); }
    else setMsg((d.reasons ?? [d.error]).join(" "));
  };
  return (
    <div style={{ flexBasis: "100%" }}>
      <details ref={ref} className="ups-sale-edit" onToggle={(e) => { if (!(e.currentTarget as HTMLDetailsElement).open) setForm(false); }}>
        <summary style={{ fontSize: 12.5, color: C.soft, cursor: "pointer", minHeight: 32, display: "inline-flex", alignItems: "center" }}>แก้ไข…</summary>
        {!form ? (
          <button type="button" className="ups-error-reversal" onClick={() => void start()} style={{ minHeight: 44, padding: "0 10px", border: `1px solid ${C.badLine}`, borderRadius: 8, background: "#fff", color: C.badInk, font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>บันทึกผิด — ไม่ได้รับเงินสด…</button>
        ) : (
          <div className="ups-reversal-form" style={{ border: `1px solid ${C.badLine}`, background: C.badBg, borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8, color: C.badInk }}>
            <b style={{ fontSize: 13.5 }}>แจ้งว่าบันทึกผิด · ไม่ได้รับเงินสดสำหรับรายการนี้</b>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, minHeight: 44 }}>
              <input type="checkbox" checked={agree} disabled={!text} onChange={(e) => setAgree(e.target.checked)} style={{ width: 20, height: 20, flex: "none", marginTop: 2 }} />
              <span>{text ?? "…"}</span>
            </label>
            <label htmlFor={`ups-rev-${saleNo}`} style={{ fontWeight: 700, fontSize: 13.5 }}>What happened?</label>
            <input id={`ups-rev-${saleNo}`} value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 44, border: "1px solid #A1A1AA", borderRadius: 8, padding: "8px 10px", font: "inherit" }} placeholder="e.g. ticked the wrong guest" />
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={close} style={plain}>Cancel</button>
              <button type="button" className="ups-reversal-send" disabled={busy || !agree || reason.trim().length < 5} onClick={() => void submit()} style={{ ...plain, background: C.badInk, color: "#fff", borderColor: C.badInk }}>Send to Admin</button>
            </div>
          </div>
        )}
      </details>
      {msg && <small role="status" style={{ display: "block", color: C.soft }}>{msg}</small>}
    </div>
  );
}
