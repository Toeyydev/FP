"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Sum = { total: number; cancelled: number; cancelRate: number; totalPax: number; toursAssigned: number; toursCompleted: number; guestsServed: number; noShow: number };
type Data = {
  from: string; to: string; summary: Sum;
  bySource: { source: string; count: number; pax: number }[];
  byTour: { tour: string; count: number; pax: number }[];
  byGuide: { guide: string; tours: number; pax: number }[];
  byMonth: { month: string; count: number }[];
};

const mLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });

function Bars({ rows, label, value }: { rows: { k: string; v: number }[]; label: string; value: string }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <div className="rep-bars">
      <div className="rep-bars-head"><span>{label}</span><span>{value}</span></div>
      {rows.length === 0 ? <div className="op-empty">No data.</div> : rows.map((r, i) => (
        <div key={i} className="rep-bar">
          <span className="rb-k" title={r.k}>{r.k}</span>
          <span className="rb-track"><i style={{ width: r.v > 0 ? `max(5px, ${(r.v / max) * 100}%)` : 0 }} /></span>
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

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Reports</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/payments">Payments</a></div>
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 8 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>From</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={from} onChange={(e) => { setFrom(e.target.value); load(e.target.value, to); }} />
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>To</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={to} onChange={(e) => { setTo(e.target.value); load(from, e.target.value); }} />
        </div>

        {!d ? (
          <div style={{ padding: 16 }}>
            <div className="kpi-row">{Array.from({ length: 7 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
            <div className="rep-grid">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" style={{ height: 140 }} />)}</div>
          </div>
        ) : (
          <div style={{ padding: 16 }}>
            <div className="kpi-row">
              <div className="kpi"><b>{d.summary.total}</b><span>Bookings</span></div>
              <div className="kpi"><b>{d.summary.totalPax}</b><span>Guests (pax)</span></div>
              <div className="kpi"><b>{d.summary.toursCompleted}</b><span>Tours completed</span></div>
              <div className="kpi"><b>{d.summary.guestsServed}</b><span>Guests served</span></div>
              <div className="kpi"><b>{d.summary.toursAssigned}</b><span>Tours assigned</span></div>
              <div className={`kpi ${d.summary.noShow > 0 ? "warn" : ""}`}><b>{d.summary.noShow}</b><span>No-shows</span></div>
              <div className={`kpi ${d.summary.cancelRate > 0 ? "bad" : ""}`}><b>{d.summary.cancelRate}%</b><span>Cancel rate ({d.summary.cancelled})</span></div>
            </div>

            <div className="rep-grid">
              <Bars label="Bookings by month" value="bookings" rows={d.byMonth.map((m) => ({ k: mLabel(m.month), v: m.count }))} />
              <Bars label="Bookings by source" value="bookings" rows={d.bySource.map((s) => ({ k: s.source, v: s.count }))} />
              <Bars label="Tour performance" value="bookings" rows={d.byTour.slice(0, 12).map((t) => ({ k: t.tour, v: t.count }))} />
              <Bars label="Guide utilization" value="tours" rows={d.byGuide.slice(0, 12).map((g) => ({ k: g.guide, v: g.tours }))} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
