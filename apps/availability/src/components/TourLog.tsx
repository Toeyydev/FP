"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Report = { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null };
type Row = { date: string; time: string; tour: string; guideId: string; slotIdx: number; guide: string; pax: number | null; arrive: string | null; start: string | null; complete: string | null; offSiteM: number | null; stars: number | null; completed: boolean; report: Report | null; noShows?: { name: string; ref: string; pax: number; noShowPax?: number }[] };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function TourLog({ canEdit = true }: { canEdit?: boolean }) {
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

  // Remove a tour-log entry (assignment + check-ins + report + rating).
  async function removeRow(r: Row) {
    if (!confirm(`Remove this tour log entry?\n${dShort(r.date)} · ${r.tour} · ${r.guide}\nThis deletes its check-ins, report and rating (the job sheet is kept).`)) return;
    const res = await fetch("/api/tour-log", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: r.guideId, date: r.date, slotIdx: r.slotIdx }) });
    if (res.ok) load(from, to);
  }
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
            <thead><tr><th>Date</th><th>Tour</th><th>Guide</th><th>Pax</th><th>Check-in</th><th>Started</th><th>Done</th><th>Report</th><th /></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={9} className="op-empty">No tours in range.</td></tr> : rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: "nowrap" }}>{dShort(r.date)}<br /><small style={{ color: "var(--ink-soft)" }}>{r.time}</small></td>
                  <td>{r.tour}</td>
                  <td style={{ whiteSpace: "nowrap" }}><span className="gid">{r.guideId}</span> {r.guide}</td>
                  <td>{r.pax ?? "—"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.arrive ?? "—"}{r.offSiteM != null && <div style={{ color: "var(--danger)", fontSize: 11, fontWeight: 700 }}>⚠ {r.offSiteM}m off</div>}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.start ?? "—"}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.complete ?? "—"}</td>
                  <td style={{ fontSize: 12.5 }}>{r.report ? (
                    <>
                      {r.report.completedPax != null ? `${r.report.completedPax} done` : "—"}
                      {r.report.noShow > 0 ? ` · ${r.report.noShow} no-show` : ""}
                      {r.report.leftEarly > 0 ? ` · ${r.report.leftEarly} left` : ""}
                      {r.report.comments ? <div style={{ color: "var(--danger)" }}>⚠ {r.report.comments}</div> : null}
                      {r.noShows && r.noShows.length > 0 && (
                        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {r.noShows.map((n, i) => { const nsp = n.noShowPax ?? n.pax; const partial = n.pax > 0 && nsp < n.pax; return (
                            <span key={i} title={partial ? "Partial no-show" : "Reported no-show"} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-line)", borderRadius: 7, padding: "2px 7px" }}>
                              ✗ {n.name}{n.ref ? ` · ${n.ref}` : ""}{partial ? ` · ${nsp} of ${n.pax} no-show` : (n.pax ? ` · ${n.pax} pax` : "")}
                            </span>
                          ); })}
                        </div>
                      )}
                    </>
                  ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(r.guideId)}&date=${r.date}&slotIdx=${r.slotIdx}`} title="Open this tour's job sheet — full job details">📄 Job sheet</a>{" "}
                    {canEdit && <button className="btn sm danger" title="Remove this tour log entry" onClick={() => removeRow(r)}>🗑</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
