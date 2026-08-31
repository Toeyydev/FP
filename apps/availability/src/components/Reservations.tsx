"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { OperatorNav } from "@/components/OperatorNav";
import { thb } from "@/lib/jobsheet";
import { SELL_STATE_LABEL, quote, partyPax, type SellState } from "@/lib/reservations";

// The reservation desk: inventory on the left, a booking form on the right.
//
// This is the half of Bokun that Folkpaths was paying a subscription for —
// what is on sale, how many seats are left, and taking a booking against them.
// It writes a normal Booking, so a direct sale reaches Dispatch, the Job Sheet
// and Payments through the machinery that already works.

type Departure = {
  id: string; tourId: string; tourName: string; date: string; time: string;
  slotIdx: number | null; status: string; capacity: number; note: string | null;
  priceAdult: number | null; priceChild: number | null; currency: string;
  seats: { capacity: number; sold: number; remaining: number; oversold: number };
  state: SellState; guidesNeeded: number; unlinked: number;
};

type Tour = { id: string; name: string; priceAdult?: number | null; priceChild?: number | null; currency?: string };
type Channel = { id: string; name: string; commissionPct: number | null; isDirect: boolean; active: boolean; bookings: number };

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Reservations() {
  const [tab, setTab] = useState<"inventory" | "commission" | "channels">("inventory");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(addDays(today(), 21));
  const [tourFilter, setTourFilter] = useState("");

  const [departures, setDepartures] = useState<Departure[] | null>(null);
  const [tours, setTours] = useState<Tour[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [msg, setMsg] = useState("");
  const [booking, setBooking] = useState<Departure | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ from, to, ...(tourFilter ? { tourId: tourFilter } : {}) });
    const r = await fetch(`/api/departures?${qs}`, { cache: "no-store" });
    if (!r.ok) { setDepartures([]); return; }
    const d = await r.json();
    setDepartures(d.departures ?? []);
  }, [from, to, tourFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/tours", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => setTours(d?.tours ?? [])).catch(() => {});
    fetch("/api/channels", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => setChannels(d?.channels ?? [])).catch(() => {});
  }, []);

  // Grouped by date so the list reads like a calendar rather than a flat table.
  const byDate = useMemo(() => {
    const m = new Map<string, Departure[]>();
    for (const d of departures ?? []) {
      if (!m.has(d.date)) m.set(d.date, []);
      m.get(d.date)!.push(d);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [departures]);

  const totals = useMemo(() => {
    const list = departures ?? [];
    return {
      departures: list.length,
      seats: list.reduce((n, d) => n + d.capacity, 0),
      sold: list.reduce((n, d) => n + d.seats.sold, 0),
      oversold: list.filter((d) => d.seats.oversold > 0).length,
    };
  }, [departures]);

  async function post(url: string, body: unknown) {
    setMsg("");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.detail || d.error || "Something went wrong."); return null; }
    return d;
  }

  return (
    <div className="op-layout">
      <OperatorNav active="reservations" />
      <div className="op-main">
        <div className="wrap">
          <div id="appBar">
            <div className="subtabs"><span className="subtab active">Reservations</span></div>
            <div className="nav">
              <a className="btn sm" href="/dashboard">Dashboard</a>
              <a className="btn sm" href="/bookings">Bookings</a>
            </div>
          </div>

          <div className="subtabs no-print" style={{ marginBottom: 14 }}>
            {([["inventory", "Departures"], ["commission", "What the channels cost"], ["channels", "Channels"]] as const).map(([k, l]) => (
              <button key={k} type="button" className={`subtab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {msg && <div className="acct-warn-bar" style={{ marginBottom: 12 }}><b>Couldn&apos;t do that</b><span>{msg}</span></div>}

          {tab === "inventory" && (
            <>
              <section className="panel" style={{ marginBottom: 14 }}>
                <div className="panel-head">
                  <h2>Departures</h2>
                  <span className="hint">What is on sale, and how full it is.</span>
                  <div className="res-toolbar">
                    <input type="date" className="acct-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
                    <span className="acct-sub">to</span>
                    <input type="date" className="acct-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
                    <select className="acct-input" value={tourFilter} onChange={(e) => setTourFilter(e.target.value)} aria-label="Tour">
                      <option value="">All tours</option>
                      {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
                    </select>
                    <button className="btn primary" onClick={() => setShowSchedule((v) => !v)}>{showSchedule ? "Close" : "+ Schedule departures"}</button>
                  </div>
                </div>

                {showSchedule && (
                  <ScheduleForm
                    tours={tours}
                    onDone={(m) => { setShowSchedule(false); setMsg(m); load(); }}
                    post={post}
                  />
                )}

                <div style={{ padding: "10px 16px", display: "flex", gap: 18, flexWrap: "wrap", fontSize: 13 }}>
                  <Stat label="Departures" value={String(totals.departures)} />
                  <Stat label="Seats offered" value={String(totals.seats)} />
                  <Stat label="Seats sold" value={String(totals.sold)} />
                  {totals.oversold > 0 && <Stat label="Oversold departures" value={String(totals.oversold)} warn />}
                </div>
              </section>

              {departures === null ? (
                <section className="panel"><div style={{ padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" />)}</div></section>
              ) : !byDate.length ? (
                <section className="panel">
                  <div className="op-empty" style={{ padding: 28 }}>
                    <b>No departures in this range.</b>
                    <div style={{ marginTop: 6 }}>Use <b>+ Schedule departures</b> to put a tour on sale — pick the tour, the times it runs and the days of the week, and FolkOPS creates the inventory.</div>
                  </div>
                </section>
              ) : (
                byDate.map(([date, list]) => (
                  <section className="panel" key={date} style={{ marginBottom: 12 }}>
                    <div className="panel-head"><h2 style={{ fontSize: 14 }}>{dayLabel(date)}</h2><span className="hint">{date}</span></div>
                    <div className="grid-scroll">
                      <table className="acct-table">
                        <thead><tr>
                          <th style={{ width: 70 }}>Time</th>
                          <th>Tour</th>
                          <th style={{ width: 190 }}>Seats</th>
                          <th style={{ width: 110 }}>Status</th>
                          <th style={{ width: 120 }}>Price</th>
                          <th style={{ width: 210 }}>Actions</th>
                        </tr></thead>
                        <tbody>
                          {list.map((d) => (
                            <DepartureRow
                              key={d.id} d={d}
                              onBook={() => setBooking(d)}
                              onUpdate={async (patch) => { await post("/api/departures", { action: "update", id: d.id, ...patch }); load(); }}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))
              )}
            </>
          )}

          {tab === "commission" && <CommissionReport />}
          {tab === "channels" && <ChannelRates channels={channels} onSaved={(c) => setChannels(c)} />}
        </div>
      </div>

      {booking && (
        <BookingDrawer
          departure={booking}
          channels={channels.filter((c) => c.active)}
          onClose={() => setBooking(null)}
          onBooked={(m) => { setBooking(null); setMsg(""); load(); alert(m); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="acct-sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: warn ? "var(--assign)" : "var(--ink)" }}>{value}</div>
    </div>
  );
}

// ── Departure row ───────────────────────────────────────────────────────────

function DepartureRow({ d, onBook, onUpdate }: { d: Departure; onBook: () => void; onUpdate: (patch: Record<string, unknown>) => void }) {
  const [cap, setCap] = useState(String(d.capacity));
  const pct = d.capacity > 0 ? Math.min(100, (d.seats.sold / d.capacity) * 100) : 0;
  const sellable = d.state === "SELLING";

  return (
    <tr>
      <td style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{d.time}</td>
      <td>
        <div style={{ fontWeight: 600 }}>{d.tourName}</div>
        <div className="acct-code">{d.tourId}{d.note ? ` · ${d.note}` : ""}</div>
      </td>
      <td>
        <div className="res-bar" aria-hidden>
          <span className={`res-bar-fill${d.seats.oversold > 0 ? " over" : ""}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="acct-sub" style={{ marginTop: 3 }}>
          <b style={{ color: "var(--ink)" }}>{d.seats.sold}</b> / {d.capacity} sold
          {d.seats.remaining > 0 && <> · {d.seats.remaining} left</>}
          {d.seats.oversold > 0 && <> · <b style={{ color: "var(--assign)" }}>{d.seats.oversold} oversold</b></>}
        </div>
        {/* Sold seats an operator did not sell here are worth naming, or the
            number looks wrong. */}
        {d.unlinked > 0 && <div className="acct-code">{d.unlinked} from channels</div>}
        {d.guidesNeeded > 1 && <div className="acct-code">needs {d.guidesNeeded} guides</div>}
      </td>
      <td><span className={`acct-pill ${sellable ? "ok" : "warn"}`}>{SELL_STATE_LABEL[d.state]}</span></td>
      <td className="acct-sub">
        {d.priceAdult == null ? <span style={{ color: "var(--assign)" }}>No price</span> : thb(d.priceAdult)}
        {d.priceChild != null && d.priceChild !== d.priceAdult && <div className="acct-code">child {thb(d.priceChild)}</div>}
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn sm primary" disabled={!sellable} onClick={onBook}>Book</button>
          <input
            className="acct-input" style={{ width: 56 }} value={cap} aria-label="Capacity"
            onChange={(e) => setCap(e.target.value.replace(/\D/g, ""))}
            onBlur={() => { const n = Number(cap); if (n >= 1 && n !== d.capacity) onUpdate({ capacity: n }); else setCap(String(d.capacity)); }}
          />
          <button className="btn sm ghost" onClick={() => onUpdate({ status: d.status === "OPEN" ? "CLOSED" : "OPEN" })}>
            {d.status === "OPEN" ? "Close" : "Open"}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Bulk schedule ───────────────────────────────────────────────────────────

const WEEKDAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]] as const;

function ScheduleForm({ tours, onDone, post }: { tours: Tour[]; onDone: (msg: string) => void; post: (u: string, b: unknown) => Promise<Record<string, unknown> | null> }) {
  const [tourId, setTourId] = useState(tours[0]?.id ?? "");
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(addDays(today(), 30));
  const [times, setTimes] = useState("09:00");
  const [days, setDays] = useState<number[]>([]);
  const [capacity, setCapacity] = useState("12");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!tourId && tours[0]) setTourId(tours[0].id); }, [tours, tourId]);

  const parsedTimes = times.split(",").map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    .map((t) => (t.length === 4 ? `0${t}` : t));

  async function submit() {
    setBusy(true);
    const d = await post("/api/departures", {
      action: "generate", tourId, from, to, times: parsedTimes,
      weekdays: days.length ? days : undefined, capacity: Number(capacity) || 12, skipExisting: true,
    });
    setBusy(false);
    if (d) onDone(`Created ${d.created} departure${d.created === 1 ? "" : "s"}${Number(d.skipped) > 0 ? ` · ${d.skipped} already existed and were left alone` : ""}.`);
  }

  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", background: "var(--grey-bg)" }}>
      <div className="res-toolbar" style={{ marginLeft: 0, alignItems: "flex-end" }}>
        <Field label="Tour">
          <select className="acct-input" value={tourId} onChange={(e) => setTourId(e.target.value)}>
            {tours.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.name}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" className="acct-input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="acct-input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Times (comma separated)">
          <input className="acct-input" style={{ width: 160 }} value={times} onChange={(e) => setTimes(e.target.value)} placeholder="09:00, 14:00" />
        </Field>
        <Field label="Seats each"><input className="acct-input" style={{ width: 70 }} value={capacity} onChange={(e) => setCapacity(e.target.value.replace(/\D/g, ""))} /></Field>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="acct-sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700, marginBottom: 4 }}>Days (none selected = every day)</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {WEEKDAYS.map(([label, n]) => (
            <button key={n} type="button" className={`btn sm${days.includes(n) ? " primary" : " ghost"}`}
              onClick={() => setDays((p) => p.includes(n) ? p.filter((x) => x !== n) : [...p, n])}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn primary" disabled={busy || !tourId || !parsedTimes.length} onClick={submit}>
          {busy ? "Creating…" : "Create departures"}
        </button>
        <span className="acct-sub">
          Existing departures are never touched — regenerating a schedule cannot reset a capacity that has already sold seats.
        </span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <div className="acct-sub" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700, marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

// ── Booking drawer ──────────────────────────────────────────────────────────

function BookingDrawer({ departure, channels, onClose, onBooked }: {
  departure: Departure; channels: Channel[]; onClose: () => void; onBooked: (msg: string) => void;
}) {
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [nationality, setNationality] = useState("");
  const [channel, setChannel] = useState(channels.find((c) => c.isDirect)?.id ?? channels[0]?.id ?? "direct");
  const [requests, setRequests] = useState("");
  const [paid, setPaid] = useState<"unpaid" | "paid" | "deposit">("unpaid");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const pax = partyPax({ adults, children });
  // Priced with the same function the server uses, so the figure quoted to the
  // customer on the phone is the figure that gets stored.
  const q = quote(
    { priceAdult: departure.priceAdult, priceChild: departure.priceChild, currency: departure.currency },
    null, { adults, children },
  );
  const overCapacity = pax > departure.seats.remaining;
  const ch = channels.find((c) => c.id === channel);
  const commissionPreview = ch && !ch.isDirect && ch.commissionPct != null && q.ok
    ? (q.gross * ch.commissionPct) / 100 : null;

  async function submit() {
    setBusy(true); setErr("");
    const r = await fetch("/api/reservations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create", departureId: departure.id, customerName: name.trim(),
        email: email.trim() || null, phone: phone.trim() || null, nationality: nationality.trim() || null,
        adults, children, channel, specialRequests: requests.trim() || null, paymentStatus: paid,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.detail || d.error || "Could not create the booking."); return; }
    // Say whether the guest was actually emailed — otherwise the operator assumes
    // it was and never follows up by phone or LINE.
    const mail = !email.trim() ? "No email address given — send the code yourself."
      : d.emailed ? "Confirmation emailed."
      : "Email could NOT be sent — pass the code to the guest yourself.";
    onBooked(`Booked ${pax} guest${pax === 1 ? "" : "s"} · ${d.booking?.voucherCode ?? ""}\n${d.seatsLeft} seat(s) left on this departure.\n${mail}`);
  }

  return (
    <div className="res-scrim" role="dialog" aria-modal="true" aria-label="New booking" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="res-drawer panel">
        <div className="panel-head">
          <h2>New booking</h2>
          <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button>
        </div>

        <div style={{ padding: "12px 16px" }}>
          <div className="acct-sub" style={{ marginBottom: 10 }}>
            <b style={{ color: "var(--ink)" }}>{departure.tourName}</b> · {dayLabel(departure.date)} · {departure.time}
            <div>{departure.seats.remaining} of {departure.capacity} seats left</div>
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <Field label="Adults"><input className="acct-input" style={{ width: 70 }} type="number" min={0} value={adults} onChange={(e) => setAdults(Math.max(0, Number(e.target.value)))} /></Field>
            <Field label="Children"><input className="acct-input" style={{ width: 70 }} type="number" min={0} value={children} onChange={(e) => setChildren(Math.max(0, Number(e.target.value)))} /></Field>
            <Field label="Channel">
              <select className="acct-input" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isDirect ? " (no commission)" : ""}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Guest name"><input className="acct-input" style={{ width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></Field>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <div style={{ flex: 1 }}><Field label="Email"><input className="acct-input" style={{ width: "100%" }} value={email} onChange={(e) => setEmail(e.target.value)} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Phone"><input className="acct-input" style={{ width: "100%" }} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field></div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <div style={{ flex: 1 }}><Field label="Nationality"><input className="acct-input" style={{ width: "100%" }} value={nationality} onChange={(e) => setNationality(e.target.value)} /></Field></div>
            <div style={{ flex: 1 }}><Field label="Payment">
              <select className="acct-input" style={{ width: "100%" }} value={paid} onChange={(e) => setPaid(e.target.value as typeof paid)}>
                <option value="unpaid">Not paid yet</option>
                <option value="deposit">Deposit taken</option>
                <option value="paid">Paid in full</option>
              </select>
            </Field></div>
          </div>
          <div style={{ marginTop: 8 }}>
            <Field label="Special requests"><textarea className="acct-input" style={{ width: "100%", minHeight: 54 }} value={requests} onChange={(e) => setRequests(e.target.value)} /></Field>
          </div>

          <div className="res-quote">
            {q.ok ? (
              <>
                {q.lines.map((l) => (
                  <div key={l.label} className="res-quote-line"><span>{l.label} × {l.qty}</span><span>{thb(l.amount)}</span></div>
                ))}
                <div className="res-quote-line total"><span>Total</span><span>{thb(q.gross)}</span></div>
                {commissionPreview != null && (
                  <div className="res-quote-line" style={{ color: "var(--assign)" }}>
                    <span>{ch?.name} commission ({ch?.commissionPct}%)</span><span>−{thb(commissionPreview)}</span>
                  </div>
                )}
                {ch && !ch.isDirect && ch.commissionPct == null && (
                  <div className="acct-sub" style={{ marginTop: 4 }}>This channel has no commission rate set — the booking is stored without one.</div>
                )}
              </>
            ) : (
              <div style={{ color: "var(--assign)", fontWeight: 600 }}>{q.reason}</div>
            )}
          </div>

          {overCapacity && <div className="acct-warn-bar" style={{ margin: "10px 0 0" }}><b>Not enough seats</b><span>{departure.seats.remaining} left, {pax} requested.</span></div>}
          {err && <div className="acct-warn-bar" style={{ margin: "10px 0 0" }}><b>Not booked</b><span>{err}</span></div>}

          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn primary" disabled={busy || !name.trim() || pax <= 0 || overCapacity || !q.ok} onClick={submit}>
              {busy ? "Booking…" : `Confirm ${pax} guest${pax === 1 ? "" : "s"}`}
            </button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ── Commission report ───────────────────────────────────────────────────────

type Report = {
  from: string; to: string;
  channels: { id: string; name: string; isDirect: boolean; pct: number | null; bookings: number; pax: number; gross: number; commission: number; net: number; unknownRate: number; unpriced: number }[];
  ota: { gross: number; commission: number };
  direct: { gross: number; bookings: number };
  coverage: { bookings: number; priced: number; unpriced: number; unknownRate: number };
};

function CommissionReport() {
  const [from, setFrom] = useState(`${today().slice(0, 8)}01`);
  const [to, setTo] = useState(today());
  const [rep, setRep] = useState<Report | null>(null);

  useEffect(() => {
    fetch(`/api/reservations/commission?from=${from}&to=${to}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null)).then((d) => setRep(d)).catch(() => setRep(null));
  }, [from, to]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>What the channels cost</h2>
        <span className="hint">Commission paid, next to revenue you kept.</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input type="date" className="acct-input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <input type="date" className="acct-input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        </div>
      </div>

      {!rep ? <div style={{ padding: 14 }}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel-row" />)}</div> : (
        <>
          <div style={{ padding: "12px 16px", display: "flex", gap: 22, flexWrap: "wrap" }}>
            <Stat label="Commission paid" value={thb(rep.ota.commission)} warn={rep.ota.commission > 0} />
            <Stat label="Channel revenue" value={thb(rep.ota.gross)} />
            <Stat label="Direct revenue" value={thb(rep.direct.gross)} />
          </div>

          {/* Coverage is stated before the table: a total built from a third of
              the bookings is not a total, and the reader has to know that. */}
          {(rep.coverage.unpriced > 0 || rep.coverage.unknownRate > 0) && (
            <div className="acct-warn-bar">
              <b>These figures cover part of the period</b>
              <span>
                {rep.coverage.priced} of {rep.coverage.bookings} bookings have a price recorded
                {rep.coverage.unpriced > 0 && <> · {rep.coverage.unpriced} have none (the channel sync never sent one)</>}
                {rep.coverage.unknownRate > 0 && <> · {rep.coverage.unknownRate} are on a channel with no commission rate set</>}.
                Set the rates under <b>Channels</b> to complete the picture.
              </span>
            </div>
          )}

          <div className="grid-scroll">
            <table className="acct-table">
              <thead><tr>
                <th>Channel</th><th style={{ width: 70 }}>Rate</th><th style={{ width: 80 }}>Bookings</th>
                <th style={{ width: 70 }}>Guests</th><th style={{ width: 120 }}>Revenue</th>
                <th style={{ width: 120 }}>Commission</th><th style={{ width: 120 }}>You keep</th>
              </tr></thead>
              <tbody>
                {rep.channels.map((c) => (
                  <tr key={c.id}>
                    <td><div style={{ fontWeight: 600 }}>{c.name}</div>{c.isDirect && <div className="acct-code">direct — no commission</div>}</td>
                    <td className="acct-sub">{c.isDirect ? "—" : c.pct == null ? <span style={{ color: "var(--assign)" }}>not set</span> : `${c.pct}%`}</td>
                    <td className="acct-sub">{c.bookings}{c.unpriced > 0 && <div className="acct-code">{c.unpriced} unpriced</div>}</td>
                    <td className="acct-sub">{c.pax}</td>
                    <td className="acct-sub">{thb(c.gross)}</td>
                    <td style={{ color: c.commission > 0 ? "var(--assign)" : undefined, fontWeight: c.commission > 0 ? 600 : 400 }}>{c.commission > 0 ? `−${thb(c.commission)}` : "—"}</td>
                    <td style={{ fontWeight: 600 }}>{thb(c.net)}</td>
                  </tr>
                ))}
                {!rep.channels.length && <tr><td colSpan={7} className="acct-sub">No bookings in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ── Channel rates ───────────────────────────────────────────────────────────

function ChannelRates({ channels, onSaved }: { channels: Channel[]; onSaved: (c: Channel[]) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setDraft(Object.fromEntries(channels.map((c) => [c.id, c.commissionPct == null ? "" : String(c.commissionPct)])));
  }, [channels]);

  const dirty = channels.some((c) => (draft[c.id] ?? "") !== (c.commissionPct == null ? "" : String(c.commissionPct)));

  async function save() {
    setBusy(true); setMsg("");
    const payload = channels.filter((c) => !c.isDirect).map((c) => {
      const raw = (draft[c.id] ?? "").trim();
      return { id: c.id, commissionPct: raw === "" ? null : Number(raw) };
    });
    const r = await fetch("/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channels: payload }) });
    setBusy(false);
    if (!r.ok) { setMsg("Couldn't save the rates."); return; }
    setMsg("Rates saved");
    const fresh = await fetch("/api/channels", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (fresh?.channels) onSaved(fresh.channels);
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channels</h2>
        <span className="hint">What each channel keeps from a sale.</span>
      </div>
      <div className="acct-warn-bar">
        <b>Enter these from your contracts</b>
        <span>
          FolkOPS never guesses a commission rate. Every figure in the cost report is derived from what you
          type here, so a plausible-looking default would produce a confident wrong answer about your own money.
          A blank rate reports as &quot;not set&quot;, never as free.
        </span>
      </div>
      <div className="grid-scroll">
        <table className="acct-table">
          <thead><tr><th>Channel</th><th style={{ width: 110 }}>Bookings</th><th style={{ width: 160 }}>Commission %</th></tr></thead>
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}>
                <td><div style={{ fontWeight: 600 }}>{c.name}</div><div className="acct-code">{c.id}</div></td>
                <td className="acct-sub">{c.bookings}</td>
                <td>
                  {c.isDirect ? <span className="acct-pill ok">Direct — 0%</span> : (
                    <input className="acct-input" style={{ width: 90 }} inputMode="decimal" placeholder="not set"
                      value={draft[c.id] ?? ""} aria-label={`Commission for ${c.name}`}
                      onChange={(e) => setDraft((p) => ({ ...p, [c.id]: e.target.value.replace(/[^\d.]/g, "") }))} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="acct-foot">
        <span className="acct-sub">Rates apply to new bookings. Existing bookings keep the commission recorded when they were taken.</span>
        {msg && <span className="acct-msg">{msg}</span>}
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>{busy ? "Saving…" : "Save rates"}</button>
      </div>
    </section>
  );
}
