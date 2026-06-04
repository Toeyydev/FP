"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { SLOTS } from "@/lib/slots";

type Booking = {
  id: string; source: string; confirmationCode: string | null; productName: string | null;
  tourId: string | null; date: string | null; startTime: string | null; slotIdx: number | null;
  pax: number | null; customerName: string | null; status: string;
};
type Tour = { id: string; name: string; time: string };

async function post(body: unknown) {
  const r = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default function BookingsInbox() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [msg, setMsg] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [dur, setDur] = useState<Record<string, string>>({});
  // manual-add form
  const [m, setM] = useState({ tourId: "", date: "", slotIdx: 0, pax: "", confirmationCode: "", customerName: "", source: "viator" });

  const load = useCallback(async () => {
    const r = await fetch("/api/bookings", { cache: "no-store" });
    if (!r.ok) { setMsg("Operator only."); return; }
    const d = await r.json();
    setBookings(d.bookings); setTours(d.tours);
    if (!m.tourId && d.tours[0]) setM((x) => ({ ...x, tourId: d.tours[0].id }));
  }, [m.tourId]);
  useEffect(() => { load(); }, [load]);

  const tourName = (id: string | null) => tours.find((t) => t.id === id)?.name ?? id ?? "—";
  const needMap = bookings.filter((b) => b.status !== "OFFERED" && (!b.tourId || b.slotIdx == null || !b.date));
  const ready = bookings.filter((b) => b.status !== "OFFERED" && b.tourId && b.slotIdx != null && b.date);

  // Group ready bookings by date|slot|tour.
  const groups: Record<string, Booking[]> = {};
  for (const b of ready) { const k = `${b.date}|${b.slotIdx}|${b.tourId}`; (groups[k] ??= []).push(b); }

  async function offerGroup(key: string, items: Booking[]) {
    const [date, slotIdxStr, tourId] = key.split("|");
    const slotIdx = Number(slotIdxStr);
    const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0) || undefined;
    const durMin = dur[key] && Number(dur[key]) > 0 ? Math.round(Number(dur[key]) * 60) : undefined;
    const note = `${items.length} booking(s): ${items.map((b) => b.confirmationCode || b.customerName || "—").join(", ")}`.slice(0, 280);
    const r = await fetch("/api/offers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tourId, date, slotIdx, pax: pax && pax <= 10 ? pax : undefined, durationMin: durMin, note }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg("Offer failed."); return; }
    if (!d.candidates) { setMsg("⚠️ No available guides for that slot."); return; }
    await post({ action: "markOffered", ids: items.map((b) => b.id) });
    setMsg(`📣 Offer sent — ${d.candidates} guide(s), LINE ${d.lineSent}.`);
    await load();
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Bookings inbox</span></div></div>

      <section className="panel">
        <div className="panel-head"><h2>Incoming bookings</h2>
          <div className="head-tools">
            <span style={{ color: "var(--ink-soft)", fontWeight: 600, fontSize: 13 }}>{msg}</span>
            <button className="btn sm" onClick={() => setShowAdd((s) => !s)}>+ Add Viator / manual</button>
          </div>
        </div>

        <div style={{ padding: 14 }}>
          {showAdd && (
            <div className="op-toolbar" style={{ borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
              <select className="search" value={m.source} onChange={(e) => setM({ ...m, source: e.target.value })}>
                <option value="viator">Viator</option><option value="gyg">GetYourGuide</option><option value="manual">Other</option>
              </select>
              <select className="search" value={m.tourId} onChange={(e) => setM({ ...m, tourId: e.target.value })}>
                {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
              </select>
              <input className="search" type="date" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />
              <select className="search" value={m.slotIdx} onChange={(e) => setM({ ...m, slotIdx: Number(e.target.value) })}>
                {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}
              </select>
              <input className="search" style={{ width: 70 }} type="number" min={1} placeholder="pax" value={m.pax} onChange={(e) => setM({ ...m, pax: e.target.value })} />
              <input className="search" placeholder="Booking ref" value={m.confirmationCode} onChange={(e) => setM({ ...m, confirmationCode: e.target.value })} />
              <input className="search" placeholder="Customer" value={m.customerName} onChange={(e) => setM({ ...m, customerName: e.target.value })} />
              <button className="btn sm primary" onClick={async () => {
                if (!m.tourId || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) { setMsg("Pick tour + date."); return; }
                const r = await post({ action: "add", tourId: m.tourId, date: m.date, slotIdx: m.slotIdx, pax: m.pax ? Number(m.pax) : undefined, confirmationCode: m.confirmationCode || undefined, customerName: m.customerName || undefined, source: m.source });
                if (r.ok) { setShowAdd(false); setM({ ...m, pax: "", confirmationCode: "", customerName: "" }); await load(); }
              }}>Add booking</button>
            </div>
          )}

          {/* Needs mapping */}
          {needMap.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, margin: "4px 0 8px" }}>⚠️ Needs mapping ({needMap.length})</h3>
              <table className="acct-table">
                <thead><tr><th>Source</th><th>Ref / Customer</th><th>Product</th><th>Date</th><th>Tour</th><th>Slot</th><th /></tr></thead>
                <tbody>
                  {needMap.map((b) => (
                    <tr key={b.id}>
                      <td><span className="badge">{b.source}</span></td>
                      <td>{b.confirmationCode || b.customerName || "—"}</td>
                      <td style={{ color: "var(--ink-soft)", maxWidth: 180 }}>{b.productName || "—"}</td>
                      <td><input type="date" className="search" style={{ width: 140 }} defaultValue={b.date ?? ""} onBlur={(e) => e.target.value && post({ action: "update", id: b.id, date: e.target.value }).then(load)} /></td>
                      <td>
                        <select className="search" defaultValue={b.tourId ?? ""} onChange={(e) => post({ action: "update", id: b.id, tourId: e.target.value }).then(load)}>
                          <option value="">— tour —</option>
                          {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="search" defaultValue={b.slotIdx ?? ""} onChange={(e) => post({ action: "update", id: b.id, slotIdx: Number(e.target.value) }).then(load)}>
                          <option value="">{b.startTime ? `(${b.startTime})` : "— slot —"}</option>
                          {SLOTS.map((s) => <option key={s.idx} value={s.idx}>{s.start}</option>)}
                        </select>
                      </td>
                      <td style={{ textAlign: "right" }}><button className="btn sm danger" onClick={() => post({ action: "ignore", id: b.id }).then(load)}>Ignore</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Ready, grouped */}
          <h3 style={{ fontSize: 14, margin: "16px 0 8px" }}>Ready to offer</h3>
          {Object.keys(groups).length === 0 ? <div className="op-empty">No bookings ready. New Bokun bookings will appear here automatically.</div> : (
            Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => {
              const [date, slotIdxStr, tourId] = key.split("|");
              const slot = SLOTS[Number(slotIdxStr)];
              const pax = items.reduce((s, b) => s + (b.pax ?? 0), 0);
              return (
                <div key={key} className="op-toolbar" style={{ borderRadius: 12, border: "1.5px solid var(--line)", marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <b>{date} · {slot?.start} · {tourName(tourId)}</b>
                    <div style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 3 }}>
                      {items.length} booking(s) · {pax} pax{pax > 10 ? " ⚠️ over 10 — split into separate jobs" : ""}
                      <br />{items.map((b) => `${b.confirmationCode || "—"}${b.customerName ? ` (${b.customerName})` : ""} ×${b.pax ?? "?"}`).join(" · ")}
                    </div>
                  </div>
                  <label style={{ fontSize: 12 }}>Dur (h)<input className="search" style={{ width: 60, marginLeft: 4 }} type="number" min={0} step={0.5} value={dur[key] ?? "3"} onChange={(e) => setDur((x) => ({ ...x, [key]: e.target.value }))} /></label>
                  <button className="btn sm primary" onClick={() => offerGroup(key, items)}>📣 Offer to available</button>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
