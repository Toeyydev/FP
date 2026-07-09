"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

function Kpi({ n, label, tone = "", sub, onClick }: { n: number; label: string; tone?: string; sub?: string; onClick?: () => void }) {
  return (
    <div className={`kpi ${n > 0 ? tone : ""}${onClick ? " kpi-click" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>
      <b>{n}</b><span>{label}</span>{sub ? <small className="kpi-sub">{sub}</small> : null}
    </div>
  );
}

// Google Drive connection — where job sheets + e-slips are saved. A visible button
// so the operator can (re)connect the company Drive account without hunting for a URL.
function DriveCard() {
  const [g, setG] = useState<{ enabled: boolean; connected: boolean; email: string | null } | null>(null);
  useEffect(() => { fetch("/api/google/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setG).catch(() => {}); }, []);
  if (!g || !g.enabled) return null;
  const ok = !!(g.connected && g.email);
  return (
    <div className={`drive-card${ok ? "" : " warn"}`}>
      <div className="dc-main">
        <b>☁ Google Drive</b>
        <span className="dc-status">{ok ? <>Saving to <b>{g.email}</b></> : "Not connected — job sheets & e-slips aren’t being saved to Drive"}</span>
      </div>
      <a className={`btn sm ${ok ? "" : "primary"}`} href="/api/google/connect">{ok ? "Switch account" : "Connect Google Drive"}</a>
    </div>
  );
}

export default function Dashboard() {
  const [d, setD] = useState<Data | null>(null);
  const acRef = useRef<AbortController | null>(null);
  // One dashboard fetch. Aborts any request still in flight before starting a new one,
  // so a manual refresh or the next poll can never overlap the previous call.
  const load = useCallback(async () => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store", signal: ac.signal });
      setD(await r.json());
    } catch { /* aborted or network blip — the next tick retries */ }
  }, []);
  useEffect(() => {
    // Self-scheduling poll: finish the previous response, wait the interval, THEN poll
    // again (setTimeout chain, not setInterval). Slow responses can't stack up and
    // hammer the server. Skips polling while the tab is hidden.
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) await load();
      if (!stopped) timer = window.setTimeout(tick, 60000);
    };
    tick();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); acRef.current?.abort(); };
  }, [load]);
  async function decideLeave(id: string, status: "APPROVED" | "REJECTED") {
    const r = await fetch("/api/leave", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }) });
    if (r.ok) load();
  }

  // Print-ready PDF of every tour that has bookings but no guide yet, so the
  // operator can work the list offline. Each row has an editable "Guide" field
  // (type a name or pick from the roster) that prints onto the saved PDF. Same
  // no-dependency approach as the job sheet — open an HTML doc, "Save as PDF".
  async function exportUnassignedPdf() {
    if (!d) return;
    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const list = [...d.unassigned].sort((a, b) => `${a.date}-${String(a.slotIdx).padStart(2, "0")}`.localeCompare(`${b.date}-${String(b.slotIdx).padStart(2, "0")}`));
    if (list.length === 0) { alert("No unassigned tours — every tour with bookings has a guide."); return; }
    // Roster for the pick-or-type datalist (best-effort — typing still works without it).
    let guides: { guideId: string; name: string }[] = [];
    try { const gr = await fetch("/api/guides", { cache: "no-store" }); if (gr.ok) guides = ((await gr.json()).rows ?? []).map((g: { guideId: string; name: string }) => ({ guideId: g.guideId, name: g.name })); } catch { /* offline-friendly */ }
    const opts = guides.map((g) => `<option value="${esc(g.guideId)} ${esc(g.name)}"></option>`).join("");
    const totalPax = list.reduce((s, u) => s + (u.pax || 0), 0);
    const genDate = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const body = list.map((u) => `<tr><td>${esc(dShort(u.date))}</td><td>${esc(u.time)}</td><td>${esc(u.tour)}</td><td class="r">${esc(u.count)}</td><td class="r">${esc(u.pax)}</td><td class="r b">${esc(u.need)}</td><td class="gcell"><input class="g-in" list="guides" placeholder="type or choose…"></td></tr>`).join("");
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Folkpaths unassigned tours</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Helvetica Neue",Arial,"Noto Sans Thai",sans-serif;color:#2a2520;padding:28px 30px;font-size:13px}
  .toolbar{position:sticky;top:0;background:#7e3a2c;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-radius:9px;margin-bottom:22px}
  .toolbar button{background:#fff;color:#7e3a2c;border:none;border-radius:7px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer}
  h1{font-size:21px;font-weight:800}
  .meta{color:#6f665b;font-size:12.5px;margin:3px 0 18px}
  .summary{background:#fbf4e8;border:1px solid #ecd9bf;border-radius:10px;padding:12px 16px;margin-bottom:8px;display:flex;justify-content:space-between;font-weight:700}
  .summary .tot{color:#7e3a2c;font-size:16px}
  .hint{color:#6f665b;font-size:11.5px;margin:0 2px 18px}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eee;font-size:12.5px;vertical-align:bottom}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6f665b}
  .r{text-align:right}.b{font-weight:700}
  .gcell{width:170px}
  .g-in{width:100%;border:none;border-bottom:1px solid #b9ae9a;background:transparent;font:inherit;font-size:12.5px;color:#7e3a2c;font-weight:700;padding:2px 1px;outline:none}
  .g-in::placeholder{color:#c8bda9;font-weight:400}
  @media print{.toolbar{display:none}body{padding:0}.g-in{border-bottom:1px solid #999}.g-in::placeholder{color:transparent}}
</style></head>
<body>
  <div class="toolbar"><span>Unassigned tours</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <h1>Folkpaths — Unassigned tours</h1>
  <div class="meta">Tours with bookings but no guide · generated ${esc(genDate)}</div>
  <div class="summary"><span>${list.length} unassigned tour${list.length === 1 ? "" : "s"}</span><span class="tot">${totalPax} pax waiting on a guide</span></div>
  <div class="hint">Assign a guide in the last column — type a name or pick from the roster, then Save as PDF / Print.</div>
  <table><thead><tr><th>Date</th><th>Time</th><th>Tour</th><th class="r">Bookings</th><th class="r">Pax</th><th class="r">Need</th><th>Assign guide</th></tr></thead><tbody>${body}</tbody></table>
  <datalist id="guides">${opts}</datalist>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups to export the PDF."); return; }
    w.document.write(html); w.document.close();
  }

  // Broadcast a short message to every guide with an upcoming tour (in-app + push + LINE).
  const [bcOpen, setBcOpen] = useState(false);
  const [bcText, setBcText] = useState("");
  const [bcMsg, setBcMsg] = useState("");
  const [bcBusy, setBcBusy] = useState(false);
  // Collapsible dashboard sections — default shows Tomorrow, hides Today + Upcoming.
  const [hidden, setHidden] = useState<Set<string>>(new Set(["tomorrow", "upcoming"]));
  const toggleSec = (k: string) => setHidden((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  // Tap a KPI → expand its section (if collapsible) and scroll to it.
  const jumpTo = (id: string, section?: string) => {
    if (section) setHidden((p) => { const n = new Set(p); n.delete(section); return n; });
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
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
      <AuthHeader backHref="/board" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Dashboard</span></div>
        <div className="nav"><LiveSyncBadge /><a className="btn sm" href="/board">Board</a><a className="btn sm" href="/jobs">Dispatch</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      <DriveCard />

      {!d ? (
        <div className="dash">
          <div className="kpi-row">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="kpi skel" />)}</div>
          <section className="panel"><div style={{ padding: 14 }}>{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-row" />)}</div></section>
        </div>
      ) : ((() => {
          const done = ["ARRIVE", "START", "COMPLETE"];
          const todayPax = d.todayTours.reduce((s, t) => s + (t.pax ?? 0), 0);
          const todayIn = d.todayTours.filter((t) => done.includes(t.state)).length;
          const todayOverdue = d.todayTours.filter((t) => t.overdue).length;
          const attention = d.unassigned.length + d.understaffed.length + d.conflicts.length + d.leaveRequests.length;
          return (
        <div className="dash">
          <div className="kpi-row">
            <Kpi n={d.todayTours.length} label="Today" sub={d.todayTours.length ? `${todayIn}/${d.todayTours.length} in · ${todayPax} guests` : undefined} onClick={() => jumpTo("today", "today")} />
            <Kpi n={d.tomorrowTours.length} label="Tomorrow" onClick={() => jumpTo("tomorrow", "tomorrow")} />
            <Kpi n={d.unassigned.length} label="Unassigned" tone="warn" onClick={() => jumpTo("attention")} />
            <Kpi n={d.understaffed.length} label="Understaffed" tone="bad" onClick={() => jumpTo("attention")} />
            <Kpi n={d.conflicts.length} label="Conflicts" tone="bad" onClick={() => jumpTo("attention")} />
            <Kpi n={d.upcomingTours.length} label="Upcoming · 7d" onClick={() => jumpTo("upcoming", "upcoming")} />
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
              <section className="panel" id="attention">
                <div className="panel-head"><h2>Needs attention{attention > 0 ? ` (${attention})` : ""}</h2>{d.unassigned.length > 0 && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={exportUnassignedPdf} title="Print-ready list of tours that still need a guide — Save as PDF">Export unassigned PDF</button>}</div>
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

            <section className="panel" id="today">
              <div className="panel-head" onClick={() => toggleSec("today")} style={{ cursor: "pointer" }}><h2>{hidden.has("today") ? "▸ " : "▾ "}On tour today</h2><span className="hint">{dShort(d.today)}{d.todayTours.length ? ` · ${todayIn}/${d.todayTours.length} checked in · ${todayPax} guests${todayOverdue ? ` · ⚠ ${todayOverdue} not checked in` : ""}` : " · no tours"}</span></div>
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

            <section className="panel" id="tomorrow">
              <div className="panel-head" onClick={() => toggleSec("tomorrow")} style={{ cursor: "pointer" }}><h2>{hidden.has("tomorrow") ? "▸ " : "▾ "}Tomorrow</h2><span className="hint">{d.tomorrowTours.length} tour(s)</span></div>
              <div className="dash-list" style={{ display: hidden.has("tomorrow") ? "none" : undefined }}>
                {d.tomorrowTours.length === 0 ? <div className="op-empty">No tours tomorrow.</div> : d.tomorrowTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
              </div>
            </section>

            <section className="panel" id="upcoming">
              <div className="panel-head" onClick={() => toggleSec("upcoming")} style={{ cursor: "pointer" }}><h2>{hidden.has("upcoming") ? "▸ " : "▾ "}Upcoming · next 7 days</h2></div>
              <div className="dash-list" style={{ display: hidden.has("upcoming") ? "none" : undefined }}>
                {d.upcomingTours.length === 0 ? <div className="op-empty">Nothing scheduled.</div> : d.upcomingTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
              </div>
            </section>
          </div>
        </div>
        );
      })())}
    </div>
  );
}
