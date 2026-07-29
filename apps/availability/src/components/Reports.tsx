"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";

type Sum = {
  bookings: number; cancelled: number; cancelRate: number; totalPax: number;
  toursAssigned: number; toursRan: number; guestsServed: number;
  noShows: number; noShowRate: number; checkins: number; onTimePct: number | null;
};
type Data = {
  from: string; to: string; summary: Sum;
  punctuality: { onTime: number; late: number };
  byMonth: { month: string; count: number }[];
  cancelByMonth: { month: string; count: number }[];
  bySource: { source: string; count: number; pax: number }[];
  byTour: { tour: string; count: number; pax: number }[];
  byGuide: { guide: string; tours: number; guestsServed: number; onTimePct: number | null }[];
};

const mLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

function Bars({ rows, label, value, accent }: { rows: { k: string; v: number }[]; label: string; value: string; accent?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <div className="rep-bars">
      <div className="rep-bars-head"><span>{label}</span><span>{value}</span></div>
      {rows.length === 0 ? <div className="op-empty">No data.</div> : rows.map((r, i) => (
        <div key={i} className="rep-bar">
          <span className="rb-k" title={r.k}>{r.k}</span>
          <span className="rb-track"><i style={{ width: r.v > 0 ? `max(5px, ${(r.v / max) * 100}%)` : 0, background: accent }} /></span>
          <span className="rb-v">{r.v}</span>
        </div>
      ))}
    </div>
  );
}

export default function Reports() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [d, setD] = useState<Data | null>(null);

  const load = useCallback(async (f?: string, t?: string) => {
    const p = new URLSearchParams();
    if (f) p.set("from", f); if (t) p.set("to", t);
    const r = await fetch(`/api/reports?${p.toString()}`, { cache: "no-store" });
    if (r.ok) { const j = await r.json(); setD(j); setFrom(j.from); setTo(j.to); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const s = d?.summary;
  const pct = (n: number | null) => (n == null ? "—" : `${n}%`);

  return (
    <div className="wrap">
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="reports" />
        <div className="op-main">
      <div id="appBar"><div className="subtabs"><span className="subtab active">Reports</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/payments">Payments</a></div>
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>From</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={from} onChange={(e) => { setFrom(e.target.value); load(e.target.value, to); }} />
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>To</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={to} onChange={(e) => { setTo(e.target.value); load(from, e.target.value); }} />
          {d && <span style={{ fontSize: 12.5, color: "var(--ink-soft)", marginLeft: "auto" }}>Work up to today · {d.from} → {d.to}</span>}
        </div>

        {!s ? (
          <div style={{ padding: 16 }}>
            <div className="kpi-row">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
            <div className="rep-grid">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" style={{ height: 140 }} />)}</div>
          </div>
        ) : (
          <div style={{ padding: 16 }}>
            {/* Demand */}
            <h3 className="rep-sec">Demand</h3>
            <div className="kpi-row">
              <div className="kpi"><b>{s.bookings}</b><span>Bookings</span></div>
              <div className="kpi"><b>{s.totalPax}</b><span>Guests booked</span></div>
              <div className={`kpi ${s.cancelRate >= 20 ? "warn" : ""}`}><b>{s.cancelRate}%</b><span>Cancel rate ({s.cancelled})</span></div>
            </div>

            {/* Delivery */}
            <h3 className="rep-sec">Delivery</h3>
            <div className="kpi-row">
              <div className="kpi"><b>{s.toursRan}</b><span>Tours ran</span></div>
              <div className="kpi"><b>{s.toursAssigned}</b><span>Tours assigned</span></div>
              <div className="kpi"><b>{s.guestsServed}</b><span>Guests served</span></div>
              <div className={`kpi ${s.noShowRate > 0 ? "warn" : ""}`}><b>{s.noShowRate}%</b><span>No-show rate ({s.noShows})</span></div>
              <div className={`kpi ${s.onTimePct != null && s.onTimePct < 90 ? "warn" : ""}`}><b>{pct(s.onTimePct)}</b><span>On-time check-in</span></div>
            </div>

            <div className="rep-grid">
              <Bars label="Bookings by month" value="bookings" rows={d.byMonth.map((m) => ({ k: mLabel(m.month), v: m.count }))} />
              <Bars label="Cancellations by month" value="cancelled" accent="var(--danger)" rows={d.cancelByMonth.map((m) => ({ k: mLabel(m.month), v: m.count }))} />
              <Bars label="Bookings by channel" value="bookings" rows={d.bySource.map((x) => ({ k: x.source, v: x.count }))} />
              <Bars label="Tour performance" value="bookings" rows={d.byTour.slice(0, 12).map((t) => ({ k: t.tour, v: t.count }))} />
            </div>

            {/* Guides */}
            <h3 className="rep-sec">Guides</h3>
            <div className="grid-scroll">
              <table className="rep-table">
                <thead><tr><th>Guide</th><th className="n">Tours ran</th><th className="n">Guests served</th><th className="n">On-time</th></tr></thead>
                <tbody>
                  {d.byGuide.length === 0 ? <tr><td colSpan={4} className="op-empty">No tours ran in this range.</td></tr> :
                    d.byGuide.map((g, i) => (
                      <tr key={i}>
                        <td>{g.guide}</td>
                        <td className="n">{g.tours}</td>
                        <td className="n">{g.guestsServed}</td>
                        <td className="n" style={g.onTimePct != null && g.onTimePct < 90 ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{pct(g.onTimePct)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <div style={{ fontSize: 12, color: "var(--ink-soft)", marginTop: 12, lineHeight: 1.6 }}>
              <b>How these are counted:</b> a tour “ran” when it was assigned and the guide checked in or filed a report.
              No-shows use the guide’s report where available, otherwise the guest-list flags. On-time = the first check-in within 5 min of the tour start. Revenue isn’t shown — booking prices aren’t stored.
            </div>
          </div>
        )}
      </section>
        </div>
      </div>
    </div>
  );
}
