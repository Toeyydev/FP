"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import LiveSyncBadge from "@/components/LiveSyncBadge";

type Report = { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null };
type Tour = { date: string; slotIdx: number; time: string; tour: string; guideId: string; guide: string; pax: number | null; state: string; checkedAt: string | null; overdue: boolean; report: Report | null };

const hhmm = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) : "";
function StateTag({ t }: { t: Tour }) {
  if (t.state === "COMPLETE") return <span className="ck ck-done">✓ Done {hhmm(t.checkedAt)}</span>;
  if (t.state === "START") return <span className="ck ck-live">● In progress</span>;
  if (t.state === "ARRIVE") return <span className="ck ck-in">✓ Checked in {hhmm(t.checkedAt)}</span>;
  if (t.overdue) return <span className="ck ck-late">⚠ Not checked in</span>;
  return <span className="ck ck-none">Not checked in</span>;
}
type Unassigned = { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; need: number };
type Understaffed = { date: string; slotIdx: number; time: string; tour: string; pax: number; have: number; need: number };
type Conflict = { guideId: string; guide: string; date: string; slots: string[] };
type Leave = { id: string; guideId: string; guide: string; fromDate: string; toDate: string; reason: string | null };
type Data = { today: string; todayTours: Tour[]; tomorrowTours: Tour[]; upcomingTours: Tour[]; unassigned: Unassigned[]; understaffed: Understaffed[]; conflicts: Conflict[]; leaveRequests: Leave[] };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function Kpi({ n, label, tone = "" }: { n: number; label: string; tone?: string }) {
  return <div className={`kpi ${n > 0 ? tone : ""}`}><b>{n}</b><span>{label}</span></div>;
}

export default function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  const load = () => fetch("/api/dashboard", { cache: "no-store" }).then((r) => r.json()).then(setD).catch(() => {});
  useEffect(() => {
    load(); const id = window.setInterval(load, 20000); return () => window.clearInterval(id);
  }, []);
  async function decideLeave(id: string, status: "APPROVED" | "REJECTED") {
    const r = await fetch("/api/leave", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }) });
    if (r.ok) load();
  }

  // Broadcast a short message to every guide with an upcoming tour (in-app + push + LINE).
  const [bcOpen, setBcOpen] = useState(false);
  const [bcText, setBcText] = useState("");
  const [bcMsg, setBcMsg] = useState("");
  const [bcBusy, setBcBusy] = useState(false);
  // Collapsible dashboard sections — default shows Tomorrow, hides Today + Upcoming.
  const [hidden, setHidden] = useState<Set<string>>(new Set(["today", "upcoming"]));
  const toggleSec = (k: string) => setHidden((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  async function sendBroadcast() {
    const message = bcText.trim();
    if (!message) return;
    setBcBusy(true); setBcMsg("");
    const r = await fetch("/api/broadcast", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
    const j = await r.json().catch(() => ({}));
    setBcBusy(false);
    if (r.ok) { setBcMsg(j.count ? `✅ Sent to ${j.count} guide${j.count === 1 ? "" : "s"}${j.lineSent ? ` · LINE ${j.lineSent}` : ""}` : "No guides have an upcoming tour."); setBcText(""); }
    else setBcMsg("Failed to send.");
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Dashboard</span></div>
        <div className="nav"><LiveSyncBadge /><a className="btn sm" href="/">Board</a><a className="btn sm" href="/jobs">Dispatch</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      {!d ? (
        <div className="dash">
          <div className="kpi-row">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
          <section className="panel"><div style={{ padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" />)}</div></section>
        </div>
      ) : (
        <div className="dash">
          <div className="kpi-row">
            <Kpi n={d.todayTours.length} label="Today" />
            <Kpi n={d.tomorrowTours.length} label="Tomorrow" />
            <Kpi n={d.unassigned.length} label="Unassigned" tone="warn" />
            <Kpi n={d.understaffed.length} label="Understaffed" tone="bad" />
            <Kpi n={d.conflicts.length} label="Conflicts" tone="bad" />
            <Kpi n={d.upcomingTours.length} label="Upcoming · 7d" />
          </div>

          <div className="dash-main">
            <section className="panel">
              <button onClick={() => setBcOpen((o) => !o)} style={{ width: "100%", border: "none", background: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, font: "inherit", textAlign: "left", padding: "12px 14px" }}>
                <h2 style={{ margin: 0, flex: 1 }}>📢 Broadcast to guides</h2>
                <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>upcoming tours</span>
                <span style={{ color: "var(--ink-soft)", display: "inline-block", transform: bcOpen ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
              </button>
              {bcOpen && (
                <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea value={bcText} onChange={(e) => setBcText(e.target.value)} maxLength={500} rows={3} placeholder="Message to all guides with an upcoming tour — e.g. Heavy rain expected today, please bring umbrellas for guests." className="search" style={{ width: "100%", resize: "vertical", font: "inherit", lineHeight: 1.5 }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{bcText.length}/500 · in-app + push + LINE</span>
                    <button className="btn sm primary" style={{ marginLeft: "auto" }} disabled={bcBusy || !bcText.trim()} onClick={sendBroadcast}>{bcBusy ? "Sending…" : "Send broadcast"}</button>
                  </div>
                  {bcMsg && <div style={{ fontSize: 13, fontWeight: 600, color: bcMsg.startsWith("✅") ? "var(--green)" : "var(--danger)" }}>{bcMsg}</div>}
                </div>
              )}
            </section>
            {(d.unassigned.length > 0 || d.conflicts.length > 0 || d.understaffed.length > 0 || d.leaveRequests.length > 0) && (
              <section className="panel">
                <div className="panel-head"><h2>Needs attention</h2></div>
                <div className="dash-list">
                  {d.leaveRequests.map((l) => (
                    <div key={l.id} className="dash-row">
                      <span className="tag" style={{ background: "var(--grey)", color: "#fff" }}>Leave</span>
                      <span className="dr-main"><b>{l.guide}</b> · {dShort(l.fromDate)}{l.toDate !== l.fromDate ? `–${dShort(l.toDate)}` : ""}<div className="dr-sub">{l.reason || "leave request"}</div></span>
                      <span style={{ display: "flex", gap: 6 }}>
                        <button className="btn sm primary" onClick={() => decideLeave(l.id, "APPROVED")}>Approve</button>
                        <button className="btn sm ghost" onClick={() => decideLeave(l.id, "REJECTED")}>Reject</button>
                      </span>
                    </div>
                  ))}
                  {d.conflicts.map((c, i) => (
                    <a key={`c${i}`} className="dash-row bad" href="/jobs" title="Open Dispatch to resolve the clash">
                      <span className="tag bad">Conflict</span>
                      <span className="dr-main"><b>{c.guide}</b> · {dShort(c.date)}<div className="dr-sub">{c.slots.join("  ·  ")}</div></span>
                    </a>
                  ))}
                  {d.understaffed.map((u, i) => (
                    <a key={`s${i}`} className="dash-row bad" href="/jobs" title="Open Dispatch to assign a guide">
                      <span className="tag bad">Understaffed</span>
                      <span className="dr-main"><b>{u.tour}</b> · {dShort(u.date)} {u.time}<div className="dr-sub">{u.pax} pax · {u.have}/{u.need} guides — add {u.need - u.have} more</div></span>
                    </a>
                  ))}
                  {d.unassigned.map((u, i) => (
                    <a key={`u${i}`} className="dash-row warn" href={`/bookings?focus=${u.date}`} title="Open Bookings to dispatch this tour">
                      <span className="tag warn">Unassigned</span>
                      <span className="dr-main"><b>{u.tour}</b> · {dShort(u.date)} {u.time}<div className="dr-sub">{u.count} booking{u.count > 1 ? "s" : ""} · {u.pax} pax — needs {u.need} guide{u.need > 1 ? "s" : ""}</div></span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            <section className="panel">
              <div className="panel-head" onClick={() => toggleSec("today")} style={{ cursor: "pointer" }}><h2>{hidden.has("today") ? "▸ " : "▾ "}On tour today</h2><span className="hint">{dShort(d.today)} · live check-ins · tap a tour for details</span></div>
              <div className="dash-list" style={{ display: hidden.has("today") ? "none" : undefined }}>
                {d.todayTours.length === 0 ? <div className="op-empty">No tours today.</div> : d.todayTours.map((a, i) => (
                  <a key={i} className={`dash-row${a.overdue ? " warn" : ""}`} href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details">
                    <span className="dr-time">{a.time}</span>
                    <span className="dr-main"><b>{a.tour}</b>
                      <div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div>
                      {a.report && (a.report.noShow > 0 || a.report.leftEarly > 0 || a.report.comments) && (
                        <div className="dr-report">
                          {a.report.completedPax != null ? `✓ ${a.report.completedPax} completed` : ""}
                          {a.report.noShow > 0 ? ` · ${a.report.noShow} no-show` : ""}
                          {a.report.leftEarly > 0 ? ` · ${a.report.leftEarly} left early` : ""}
                          {a.report.comments ? <span className="dr-incident"> · ⚠ {a.report.comments}</span> : ""}
                        </div>
                      )}
                    </span>
                    <StateTag t={a} />
                  </a>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head" onClick={() => toggleSec("tomorrow")} style={{ cursor: "pointer" }}><h2>{hidden.has("tomorrow") ? "▸ " : "▾ "}Tomorrow</h2><span className="hint">{d.tomorrowTours.length} tour(s)</span></div>
              <div className="dash-list" style={{ display: hidden.has("tomorrow") ? "none" : undefined }}>
                {d.tomorrowTours.length === 0 ? <div className="op-empty">No tours tomorrow.</div> : d.tomorrowTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head" onClick={() => toggleSec("upcoming")} style={{ cursor: "pointer" }}><h2>{hidden.has("upcoming") ? "▸ " : "▾ "}Upcoming · next 7 days</h2></div>
              <div className="dash-list" style={{ display: hidden.has("upcoming") ? "none" : undefined }}>
                {d.upcomingTours.length === 0 ? <div className="op-empty">Nothing scheduled.</div> : d.upcomingTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
