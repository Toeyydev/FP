"use client";

import { useCallback, useEffect, useState } from "react";
import { HandInStatusCard, type View } from "@/components/UpsellHandIn";
import { HandInDecide } from "@/components/UpsellCash";

// The Extras cash of one job, as staff see it in the Job Sheet's Finance & accounting panel (owner,
// 21 Nov 2026): every sale (Sale Ref), the Job Ref the guide puts in the transfer memo, the Hand-in
// Ref, where the cash is (รอไกด์โอน / บริษัทได้รับเงินแล้ว), the dates and the slips.
// Owner, 22 Nov 2026: the office records a sale the guide told them about ("+ Record a sale for the
// guide…"), and an Admin checks the guide's transfer here — the same server rules as Finance ›
// Extras cash. Draws nothing while Extras is off (404) or when there is nothing to show or do.

const baht = (s: number) => `฿${(s / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const head = { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ink-soft)", fontWeight: 700 } as const;

type GuestRow = { bookingId: string; name: string; bookingRef: string; pax: number; remaining: number; state: string; reason: string | null; fingerprint: string };
type Product = { kind: "ROUTE_EXTENSION" | "WALK_IN"; productCode: string; name: string; productVersionId: string; unitPriceSatang: number; guestsLeft: number; rows?: GuestRow[] };
type Office = { jobSheetId: string; guideId: string; jobRef: string | null; date: string; closed: { code: string; message: string } | null; products: Product[] };

const bangkokToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}-office`).replace(/[^A-Za-z0-9-]/g, "");

export default function UpsellJobStaff({ guideId, date, slotIdx, isAdmin = false }: { guideId: string; date: string; slotIdx: number; isAdmin?: boolean }) {
  const [v, setV] = useState<View | null>(null);
  const [office, setOffice] = useState<Office | null>(null);
  const [canRecord, setCanRecord] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const d = await fetch(`/api/upsell/hand-in/by-job?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setV(d?.view ?? null);
    if (d?.jobSheetId) {
      const o = await fetch(`/api/upsell/jobs/office-extras?jobSheetId=${encodeURIComponent(d.jobSheetId)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      setOffice(o?.extras ?? null); setCanRecord(o?.canRecord === true);
    } else { setOffice(null); }
  }, [guideId, date, slotIdx]);
  useEffect(() => { void load(); }, [load]);

  const sales = v?.sales ?? [];
  const canSell = canRecord && !!office && !office.closed && office.products.some((p) => p.guestsLeft > 0);
  const hasCash = !!v && (sales.length > 0 || v.slips.length > 0 || v.transfers.length > 0);
  if (!hasCash && !canSell && !msg) return null;
  const total = sales.filter((s) => s.status !== "REVERSED").reduce((n, s) => n + s.grossSatang, 0);
  return (
    <div className="js-extras-staff" style={{ marginBottom: 12 }}>
      <div style={head}>Extras cash · เงินขายเพิ่ม</div>
      {hasCash && v && (
        <>
          <div style={{ fontSize: 12.5, margin: "4px 0 6px", overflowWrap: "anywhere" }}>
            Job Ref <b className="js-extras-jobref">{v.jobRef ?? "—"}</b>{v.settlementNo ? <> · Hand-in <b className="js-extras-handin">{v.settlementNo}</b></> : null}
          </div>
          <ul className="js-extras-sales" style={{ listStyle: "none", margin: "0 0 8px", padding: 0, fontSize: 12.5, display: "grid", gap: 2 }}>
            {sales.map((s) => (
              <li key={s.saleNo} className="js-extras-sale" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere", textDecoration: s.status === "REVERSED" ? "line-through" : "none" }}>{s.saleNo} · {s.productName} · {s.guests} {s.guests === 1 ? "guest" : "guests"}</span>
                <b style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{baht(s.grossSatang)}</b>
              </li>
            ))}
            {sales.length > 1 && <li style={{ display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 2 }}><span>Total sold</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{baht(total)}</b></li>}
          </ul>
          <HandInStatusCard v={v} staff />
          <HandInDecide settlementNo={v.status === "SUBMITTED" ? v.settlementNo : null} isAdmin={isAdmin} onChanged={load} />
        </>
      )}
      {!hasCash && <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 4 }}>No extras on this job.</div>}
      {msg && <div className="ob ok js-office-sale-done" role="status" style={{ display: "block", whiteSpace: "normal", marginTop: 6 }}>{msg}</div>}
      {canSell && !formOpen && <button className="btn sm js-office-sale-open" style={{ marginTop: 8 }} onClick={() => { setMsg(""); setFormOpen(true); }}>+ Record a sale for the guide…</button>}
      {canSell && formOpen && office && <OfficeSaleForm office={office} onCancel={() => setFormOpen(false)} onDone={async (m) => { setFormOpen(false); setMsg(m); await load(); }} />}
    </div>
  );
}

function OfficeSaleForm({ office, onCancel, onDone }: { office: Office; onCancel: () => void; onDone: (m: string) => Promise<void> }) {
  const products = office.products.filter((p) => p.guestsLeft > 0);
  const [pick, setPick] = useState(products[0]?.productVersionId ?? "");
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [seats, setSeats] = useState(1);
  const [lead, setLead] = useState("");
  const today = bangkokToday();
  const [receivedOn, setReceivedOn] = useState(office.date);
  const [reason, setReason] = useState("");
  const [key] = useState(newKey);
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const p = products.find((x) => x.productVersionId === pick) ?? products[0];
  if (!p) return null;
  const rows = (p.rows ?? []).filter((r) => r.remaining > 0);
  const guests = p.kind === "WALK_IN" ? seats : rows.reduce((n, r) => n + (alloc[r.bookingId] ?? 0), 0);
  const ok = guests > 0 && guests <= p.guestsLeft && reason.trim().length >= 5 && receivedOn >= office.date && receivedOn <= today;
  const save = async () => {
    setBusy(true); setErr("");
    const body = {
      kind: p.kind, reason: reason.trim(), receivedOn, requestKey: key, jobSheetId: office.jobSheetId, productVersionId: p.productVersionId, guests, expectedUnitPriceSatang: p.unitPriceSatang,
      ...(p.kind === "WALK_IN" ? (lead.trim() ? { leadName: lead.trim() } : {}) : { allocations: rows.filter((r) => (alloc[r.bookingId] ?? 0) > 0).map((r) => ({ bookingId: r.bookingId, guests: alloc[r.bookingId], fingerprint: r.fingerprint })) }),
    };
    try {
      const r = await fetch("/api/upsell/sales/office", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message ?? d.reasons?.join(" ") ?? d.error ?? `HTTP ${r.status}`);
      await onDone(`${d.sale?.saleNo ?? "Sale"} recorded for ${office.guideId} — ${baht(d.sale?.grossSatang ?? 0)}. The guide hands it in with ref ${office.jobRef ?? d.sale?.jobRef ?? "the Job Ref"}.`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const lbl = { display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", marginTop: 8 } as const;
  return (
    <div className="js-office-sale" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10, marginTop: 8, fontSize: 13 }}>
      <div style={head}>Record a sale for {office.guideId}{office.jobRef ? ` · ${office.jobRef}` : ""}</div>
      <div style={lbl}>What the guest paid for</div>
      <div style={{ display: "grid", gap: 4, marginTop: 4 }}>
        {products.map((x) => (
          <label key={x.productVersionId} style={{ display: "flex", gap: 8, alignItems: "flex-start", minHeight: 32 }}>
            <input type="radio" name="office-sale-product" className="js-office-sale-product" checked={x.productVersionId === p.productVersionId} onChange={() => { setPick(x.productVersionId); setAlloc({}); }} style={{ marginTop: 3 }} />
            <span><b>{x.name}</b> · {baht(x.unitPriceSatang)} / guest<br /><span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{x.kind === "WALK_IN" ? "No OTA booking — added to this job's guest list" : "Booked guests who joined it"}</span></span>
          </label>
        ))}
      </div>
      {p.kind === "ROUTE_EXTENSION" ? (
        <>
          <div style={lbl}>Guests</div>
          {rows.length === 0 ? <div style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>No booked guest can take it.</div> : rows.map((r) => (
            <div key={r.bookingId} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{r.name || "Guest"} · {r.bookingRef}</span>
              <input type="number" inputMode="numeric" min={0} max={r.remaining} aria-label={`Guests for ${r.bookingRef}`} className="js-office-sale-alloc" value={alloc[r.bookingId] ?? 0}
                onChange={(e) => setAlloc((a) => ({ ...a, [r.bookingId]: Math.max(0, Math.min(r.remaining, Math.floor(Number(e.target.value) || 0))) }))} style={{ width: 56, textAlign: "center" }} />
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>of {r.remaining}</span>
            </div>
          ))}
        </>
      ) : (
        <>
          <label style={lbl}>Guests<input type="number" inputMode="numeric" min={1} max={p.guestsLeft} className="js-office-sale-seats" value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(p.guestsLeft, Math.floor(Number(e.target.value) || 1))))} style={{ width: 70, display: "block", marginTop: 3 }} /></label>
          <label style={lbl}>Guest name (optional)<input value={lead} maxLength={120} onChange={(e) => setLead(e.target.value)} style={{ width: "100%", display: "block", marginTop: 3 }} /></label>
        </>
      )}
      <label style={lbl}>Cash received on<input type="date" className="js-office-sale-date" min={office.date} max={today} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} style={{ display: "block", marginTop: 3 }} /></label>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>Tour day or later · the sale&apos;s accounting date</div>
      <label style={lbl}>Why the office is recording it<textarea className="js-office-sale-reason" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Guide told us by LINE — forgot to press Sell" style={{ width: "100%", display: "block", marginTop: 3 }} /></label>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}><span>Total</span><b className="js-office-sale-total" style={{ fontVariantNumeric: "tabular-nums" }}>{baht(guests * p.unitPriceSatang)}</b></div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 2 }}>The cash is with the guide. They hand it in with this job, as usual.</div>
      {err && <div className="ob bad" role="alert" style={{ display: "block", whiteSpace: "normal", marginTop: 6 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button className="btn sm primary js-office-sale-save" disabled={busy || !ok} onClick={() => void save()}>{busy ? "…" : "Record sale"}</button>
        <button className="btn sm" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
