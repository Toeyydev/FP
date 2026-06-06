"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

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
type Data = { today: string; todayTours: Tour[]; upcomingTours: Tour[]; unassigned: Unassigned[]; understaffed: Understaffed[]; conflicts: Conflict[]; leaveRequests: Leave[] };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

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

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Dashboard</span></div>
        <div className="nav"><a className="btn sm" href="/">Board</a><a className="btn sm" href="/jobs">Dispatch</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      {!d ? <section className="panel"><div className="op-empty">…</div></section> : (
        <div className="dash">
          <div className="dash-sum">
            <span><b>{d.todayTours.length}</b> today</span>
            <span className={d.unassigned.length ? "warn" : ""}><b>{d.unassigned.length}</b> unassigned</span>
            <span className={d.understaffed.length ? "bad" : ""}><b>{d.understaffed.length}</b> understaffed</span>
            <span className={d.conflicts.length ? "bad" : ""}><b>{d.conflicts.length}</b> conflicts</span>
            <span><b>{d.upcomingTours.length}</b> upcoming (7d)</span>
          </div>

          <div className="dash-main">
            {(d.unassigned.length > 0 || d.conflicts.length > 0 || d.understaffed.length > 0 || d.leaveRequests.length > 0) && (
              <section className="panel">
                <div className="panel-head"><h2>Needs attention</h2></div>
                <div className="dash-list">
                  {d.leaveRequests.map((l) => (
                    <div key={l.id} className="dash-row">
                      <span className="tag" style={{ background: "#9CA3AF", color: "#fff" }}>Leave</span>
                      <span className="dr-main"><b>{l.guide}</b> · {dShort(l.fromDate)}{l.toDate !== l.fromDate ? `–${dShort(l.toDate)}` : ""}<div className="dr-sub">{l.reason || "leave request"}</div></span>
                      <span style={{ display: "flex", gap: 6 }}>
                        <button className="btn sm primary" onClick={() => decideLeave(l.id, "APPROVED")}>Approve</button>
                        <button className="btn sm ghost" onClick={() => decideLeave(l.id, "REJECTED")}>Reject</button>
                      </span>
                    </div>
                  ))}
                  {d.conflicts.map((c, i) => (
                    <a key={`c${i}`} className="dash-row bad" href="/">
                      <span className="tag bad">Conflict</span>
                      <span className="dr-main"><b>{c.guide}</b> · {dShort(c.date)}<div className="dr-sub">{c.slots.join("  ·  ")}</div></span>
                    </a>
                  ))}
                  {d.understaffed.map((u, i) => (
                    <a key={`s${i}`} className="dash-row bad" href="/">
                      <span className="tag bad">Understaffed</span>
                      <span className="dr-main"><b>{u.tour}</b> · {dShort(u.date)} {u.time}<div className="dr-sub">{u.pax} pax · {u.have}/{u.need} guides — add {u.need - u.have} more</div></span>
                    </a>
                  ))}
                  {d.unassigned.map((u, i) => (
                    <a key={`u${i}`} className="dash-row warn" href="/bookings">
                      <span className="tag warn">Unassigned</span>
                      <span className="dr-main"><b>{u.tour}</b> · {dShort(u.date)} {u.time}<div className="dr-sub">{u.count} booking{u.count > 1 ? "s" : ""} · {u.pax} pax — needs {u.need} guide{u.need > 1 ? "s" : ""}</div></span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            <section className="panel">
              <div className="panel-head"><h2>On tour today</h2><span className="hint">{dShort(d.today)} · live check-ins</span></div>
              <div className="dash-list">
                {d.todayTours.length === 0 ? <div className="op-empty">No tours today.</div> : d.todayTours.map((a, i) => (
                  <div key={i} className={`dash-row${a.overdue ? " warn" : ""}`}>
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
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head"><h2>Upcoming · next 7 days</h2></div>
              <div className="dash-list">
                {d.upcomingTours.length === 0 ? <div className="op-empty">Nothing scheduled.</div> : d.upcomingTours.map((a, i) => (
                  <div key={i} className="dash-row"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
