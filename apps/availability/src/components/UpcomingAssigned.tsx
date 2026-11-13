"use client";
import { useEffect, useState } from "react";
import type { Departure } from "@/lib/upcoming-assigned";
import { addDays, bkkToday, DEFAULT_DAYS } from "@/lib/upcoming-assigned";

// Jobs → Assigned jobs: every guide's accepted jobs ahead of today (default 30 days),
// filterable by guide and dates. Data: /api/ops/assigned-jobs.

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export default function UpcomingAssigned() {
  const start = addDays(bkkToday(), 1);
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState(addDays(start, DEFAULT_DAYS - 1));
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Departure[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      const p = new URLSearchParams({ from, to, ...(q.trim() ? { q: q.trim() } : {}) });
      const r = await fetch(`/api/ops/assigned-jobs?${p}`, { cache: "no-store" }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!live) return;
      if (!r || !r.ok) { setErr(d.hint || "Couldn't load assigned jobs."); setRows([]); return; }
      setErr(""); setRows(d.departures ?? []);
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [from, to, q]);

  const byDate: [string, Departure[]][] = [];
  for (const d of rows ?? []) { const g = byDate.find(([x]) => x === d.date); if (g) g[1].push(d); else byDate.push([d.date, [d]]); }

  return (
    <section className="panel js-upcoming">
      <div className="panel-head"><h2>Upcoming assigned jobs</h2><span className="hint">{rows ? `${rows.length} departure${rows.length === 1 ? "" : "s"}` : "Loading…"}</span></div>
      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12, fontSize: 13 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>From <input type="date" className="search js-up-from" style={{ flex: "none", width: 150 }} value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>To <input type="date" className="search js-up-to" style={{ flex: "none", width: 150 }} value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          <input type="search" className="search js-up-q" placeholder="Guide name or ID" style={{ flex: "1 1 160px", maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {err && <div className="op-empty" style={{ color: "var(--danger,#c0392b)" }}>{err}</div>}
        {rows && !err && rows.length === 0 && <div className="op-empty">No assigned jobs{q.trim() ? ` for “${q.trim()}”` : ""} in this range.</div>}
        {byDate.map(([date, items]) => (
          <div key={date} className="js-up-day" style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>{fmt(date)} <span style={{ fontWeight: 400, color: "var(--ink-soft)" }}>({items.length})</span></h3>
            {items.map((d) => (
              <div key={`${d.slotIdx}|${d.tourId}`} className="sched-card js-up-row" style={{ cursor: "default" }}>
                <div className="sched-when"><span>{d.time}</span></div>
                <div className="sched-mid"><b>{d.tourName}</b>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {d.guides.map((g) => (
                      <a key={g.guideId} className="btn sm js-up-sheet" href={`/job-sheet?guideId=${encodeURIComponent(g.guideId)}&date=${d.date}&slotIdx=${d.slotIdx}`} title="Open this guide's job sheet">
                        {g.guideId}{g.name ? ` ${g.name}` : ""} · Job sheet
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
