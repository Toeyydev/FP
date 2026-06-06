"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Report = { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null };
type Row = { date: string; time: string; tour: string; guideId: string; guide: string; pax: number | null; arrive: string | null; start: string | null; complete: string | null; report: Report | null };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function TourLog() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async (f?: string, t?: string) => {
    const p = new URLSearchParams();
    if (f) p.set("from", f); if (t) p.set("to", t);
    const r = await fetch(`/api/tour-log?${p.toString()}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setRows(d.rows ?? []); setFrom(d.from); setTo(d.to); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Tour log</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/reports">Reports</a></div>
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 8 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>From</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={from} onChange={(e) => { setFrom(e.target.value); load(e.target.value, to); }} />
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>To</label>
          <input className="search" style={{ flex: "none", width: 150 }} type="date" value={to} onChange={(e) => { setTo(e.target.value); load(from, e.target.value); }} />
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{rows.length} tours</span>
        </div>
        <div className="grid-scroll">
          <table className="acct-table">
            <thead><tr><th>Date</th><th>Tour</th><th>Guide</th><th>Pax</th><th>Check-in</th><th>Started</th><th>Done</th><th>Report</th></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={8} className="op-empty">No tours in range.</td></tr> : rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{dShort(r.date)}<br /><small style={{ color: "var(--ink-soft)" }}>{r.time}</small></td>
                  <td>{r.tour}</td>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{r.guideId}</span> {r.guide}</td>
                  <td>{r.pax ?? "—"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.arrive ?? "—"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.start ?? "—"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.complete ?? "—"}</td>
                  <td style={{ fontSize: 12.5 }}>{r.report ? (
                    <>
                      {r.report.completedPax != null ? `${r.report.completedPax} done` : "—"}
                      {r.report.noShow > 0 ? ` · ${r.report.noShow} no-show` : ""}
                      {r.report.leftEarly > 0 ? ` · ${r.report.leftEarly} left` : ""}
                      {r.report.comments ? <div style={{ color: "var(--danger)" }}>⚠ {r.report.comments}</div> : null}
                    </>
                  ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
