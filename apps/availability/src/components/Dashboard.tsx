"use client";

import { useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

type Tour = { date: string; slotIdx: number; time: string; tour: string; guideId: string; guide: string; pax: number | null };
type Unassigned = { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number };
type Conflict = { guideId: string; guide: string; date: string; slots: string[] };
type Activity = { action: string; entityType: string | null; actorRole: string | null; createdAt: string };
type Data = { today: string; todayTours: Tour[]; upcomingTours: Tour[]; unassigned: Unassigned[]; conflicts: Conflict[]; recent: Activity[] };

const dShort = (s: string) => { const d = new Date(`${s}T00:00:00`); return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); };

const ACTION_LABEL: Record<string, string> = {
  "offer.created": "Job offer sent", "offer.accepted": "Guide accepted", "offer.denied": "Guide declined",
  "booking.added": "Booking added", "booking.updated": "Booking edited", "booking.deleted": "Booking deleted",
  "assignment.created": "Guide assigned", "assignment.deleted": "Assignment removed",
  "invite.issued": "Guide invited", "invite.claimed": "Guide joined", "request.created": "Access requested",
};
function relTime(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    const f = () => fetch("/api/dashboard", { cache: "no-store" }).then((r) => r.json()).then(setD).catch(() => {});
    f(); const id = window.setInterval(f, 20000); return () => window.clearInterval(id);
  }, []);

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Dashboard</span></div>
        <div className="nav"><a className="btn sm" href="/">Board</a><a className="btn sm" href="/jobs">Dispatch</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      {!d ? <section className="panel"><div className="op-empty">…</div></section> : (
        <div className="dash">
          {/* compact summary — counts, not KPI cards */}
          <div className="dash-sum">
            <span><b>{d.todayTours.length}</b> today</span>
            <span className={d.unassigned.length ? "warn" : ""}><b>{d.unassigned.length}</b> unassigned</span>
            <span className={d.conflicts.length ? "bad" : ""}><b>{d.conflicts.length}</b> conflicts</span>
            <span><b>{d.upcomingTours.length}</b> upcoming (7d)</span>
          </div>

          <div className="dash-grid">
            <div className="dash-main">
              {/* Needs attention first */}
              {(d.unassigned.length > 0 || d.conflicts.length > 0) && (
                <section className="panel">
                  <div className="panel-head"><h2>Needs attention</h2></div>
                  <div className="dash-list">
                    {d.conflicts.map((c, i) => (
                      <a key={`c${i}`} className="dash-row bad" href="/">
                        <span className="tag bad">Conflict</span>
                        <span className="dr-main"><b>{c.guide}</b> · {dShort(c.date)}<div className="dr-sub">{c.slots.join("  ·  ")}</div></span>
                      </a>
                    ))}
                    {d.unassigned.map((u, i) => (
                      <a key={`u${i}`} className="dash-row warn" href="/bookings">
                        <span className="tag warn">Unassigned</span>
                        <span className="dr-main"><b>{u.tour}</b> · {dShort(u.date)} {u.time}<div className="dr-sub">{u.count} booking{u.count > 1 ? "s" : ""} · {u.pax} pax — needs a guide</div></span>
                      </a>
                    ))}
                  </div>
                </section>
              )}

              <section className="panel">
                <div className="panel-head"><h2>Today</h2><span className="hint">{dShort(d.today)}</span></div>
                <div className="dash-list">
                  {d.todayTours.length === 0 ? <div className="op-empty">No tours today.</div> : d.todayTours.map((a, i) => (
                    <div key={i} className="dash-row"><span className="dr-time">{a.time}</span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></div>
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

            <aside className="dash-side">
              <section className="panel">
                <div className="panel-head"><h2>Recent activity</h2></div>
                <div className="dash-list">
                  {d.recent.length === 0 ? <div className="op-empty">—</div> : d.recent.map((a, i) => (
                    <div key={i} className="act-row"><span>{ACTION_LABEL[a.action] ?? a.action}</span><small>{relTime(a.createdAt)}</small></div>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
