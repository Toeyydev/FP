"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Assignment = { guideId: string; guideName: string; date: string; slotIdx: number; time: string; tourName: string; pax: number | null; note: string | null };
type Offer = { id: string; tourName: string; date: string; slotIdx: number; time: string; pax: number | null; note: string | null; status: string; expiresAt: string; assignedGuide: string | null; candidates: number; accepted: string[]; denied: string[]; pending: number };

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Dispatch() {
  const [data, setData] = useState<{ assignments: Assignment[]; offers: Offer[] } | null>(null);
  const [tab, setTab] = useState<"assigned" | "offers">("assigned");

  const load = useCallback(async () => {
    const r = await fetch("/api/offers", { cache: "no-store" });
    if (r.ok) setData(await r.json());
  }, []);
  useEffect(() => { load(); const id = window.setInterval(load, 15000); return () => window.clearInterval(id); }, [load]);

  if (!data) return <div className="wrap"><AuthHeader backHref="/" /><section className="panel"><div className="op-empty">…</div></section></div>;

  const openOffers = data.offers.filter((o) => o.status === "OPEN");
  const unfilled = data.offers.filter((o) => o.status === "EXPIRED");
  const badge = (s: string) => {
    const map: Record<string, string> = { OPEN: "invited", ASSIGNED: "active", EXPIRED: "suspended", CANCELLED: "suspended" };
    const label: Record<string, string> = { OPEN: "Waiting", ASSIGNED: "Filled", EXPIRED: "Unfilled", CANCELLED: "Cancelled" };
    return <span className={`badge ${map[s] ?? ""}`}>{label[s] ?? s}</span>;
  };

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs">
        <button className={`subtab ${tab === "assigned" ? "active" : ""}`} onClick={() => setTab("assigned")}>Assigned jobs ({data.assignments.length})</button>
        <button className={`subtab ${tab === "offers" ? "active" : ""}`} onClick={() => setTab("offers")}>Offers ({openOffers.length} waiting{unfilled.length ? `, ${unfilled.length} unfilled` : ""})</button>
      </div></div>

      {tab === "assigned" ? (
        <section className="panel">
          <div className="panel-head"><h2>On-going tours</h2><span className="hint">Today &amp; tomorrow — auto-updates</span></div>
          <div style={{ padding: 14 }}>
            {data.assignments.length === 0 ? <div className="op-empty">No upcoming assigned jobs yet.</div> : (() => {
              // Group by date (each date shown once), tours numbered 1, 2, 3…
              const todayStr = new Date().toLocaleDateString("en-CA");
              const byDate: [string, Assignment[]][] = [];
              for (const a of data.assignments) {
                const g = byDate.find(([d]) => d === a.date);
                if (g) g[1].push(a); else byDate.push([a.date, [a]]);
              }
              return byDate.map(([date, items]) => (
                <div key={date} style={{ marginBottom: 18 }}>
                  <h3 style={{ fontSize: 14, margin: "0 0 8px", color: date === todayStr ? "#1b4ef0" : undefined }}>
                    {date === todayStr ? "📅 Today · " : ""}{fmt(date)} <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>({items.length})</span>
                  </h3>
                  {items.map((a, i) => (
                    <div key={i} className="sched-card" style={{ cursor: "default" }}>
                      <div className="sched-when"><b style={{ fontSize: 18 }}>{i + 1}</b><span>{a.time}</span></div>
                      <div className="sched-mid"><b>{a.tourName}</b><div className="sched-sub">👤 {a.guideId} {a.guideName}{a.pax != null ? ` · 👥 ${a.pax} pax` : ""}{a.note ? ` · 📝 ${a.note}` : ""}</div></div>
                      <a className="btn sm" href={`/job-sheet?guideId=${a.guideId}&date=${a.date}&slotIdx=${a.slotIdx}`}>📄 Sheet</a>
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head"><h2>Job offers</h2><span className="hint">Live status of what you've sent out</span></div>
          <div style={{ padding: 14 }}>
            {data.offers.length === 0 ? <div className="op-empty">No offers sent yet. Send one from the board or the bookings inbox.</div> : (
              <table className="acct-table">
                <thead><tr><th>When</th><th>Tour</th><th>Status</th><th>Responses</th></tr></thead>
                <tbody>
                  {data.offers.map((o) => (
                    <tr key={o.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmt(o.date)}<br /><small style={{ color: "var(--ink-soft)" }}>{o.time}</small></td>
                      <td>{o.tourName}{o.pax != null ? <small style={{ color: "var(--ink-soft)" }}> · {o.pax} pax</small> : null}</td>
                      <td>{badge(o.status)}{o.assignedGuide && <div style={{ fontSize: 12, marginTop: 3 }}>✅ {o.assignedGuide}</div>}</td>
                      <td style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                        {o.status === "OPEN" ? `${o.pending} waiting of ${o.candidates}` : `${o.candidates} offered`}
                        {o.denied.length > 0 && <div>❌ declined: {o.denied.join(", ")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
