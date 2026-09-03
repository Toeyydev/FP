"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";

type Report = { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null };
type Tour = { date: string; slotIdx: number; time: string; tour: string; guideId: string; guide: string; pax: number | null; state: string; checkedAt: string | null; overdue: boolean; report: Report | null; ref?: string | null; expenseReported?: boolean; payStatus?: string | null };

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
type Orphaned = { date: string; slotIdx: number; time: string; tour: string; guideId: string; guide: string; pax: number; count: number };
type Leave = { id: string; guideId: string; guide: string; fromDate: string; toDate: string; reason: string | null };
type Finance = {
  expensesToReview: { count: number; total: number };
  guidePayable: { total: number; guides: number; tours: number };
  batches: { open: number; openTotal: number; latestOpenNo: string | null; paidWeekTotal: number; paidWeekCount: number };
  peak: { synced: number; pendingRef: number };
};
type PastUnstaffed = { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; daysAgo: number };
type Data = { today: string; todayTours: Tour[]; tomorrowTours: Tour[]; upcomingTours: Tour[]; unassigned: Unassigned[]; understaffed: Understaffed[]; pastUnstaffed?: PastUnstaffed[]; conflicts: Conflict[]; orphaned: Orphaned[]; leaveRequests: Leave[]; reportsPending?: number; finance?: Finance };

// Compact baht for KPI cards — whole-baht, no decimals (the tables keep 2dp via thb).
const thb0 = (v: number) => `฿${Math.round(v).toLocaleString("en-US")}`;

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function Kpi({ n, label, tone = "", sub, onClick }: { n: number; label: string; tone?: string; sub?: string; onClick?: () => void }) {
  return (
    <div className={`kpi ${n > 0 ? tone : ""}${onClick ? " kpi-click" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}>
      <b>{n}</b><span>{label}</span>{sub ? <small className="kpi-sub">{sub}</small> : null}
    </div>
  );
}

// A KPI whose headline is a formatted string (e.g. ฿24,800) instead of a count.
// Same .kpi visual; `hot` applies the tone even though the value isn't numeric.
function MoneyKpi({ v, label, tone = "", hot = false, sub, href }: { v: string; label: string; tone?: string; hot?: boolean; sub?: string; href?: string }) {
  const body = <><b style={{ fontVariantNumeric: "tabular-nums" }}>{v}</b><span>{label}</span>{sub ? <small className="kpi-sub">{sub}</small> : null}</>;
  return href
    ? <a className={`kpi ${hot ? tone : ""} kpi-click`} href={href} style={{ textDecoration: "none", color: "inherit" }}>{body}</a>
    : <div className={`kpi ${hot ? tone : ""}`}>{body}</div>;
}

// Google Drive connection — where job sheets + e-slips are saved. A visible button
// so the operator can (re)connect the company Drive account without hunting for a URL.
function DriveCard() {
  const [g, setG] = useState<{ enabled: boolean; connected: boolean; email: string | null } | null>(null);
  useEffect(() => { fetch("/api/google/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setG).catch(() => {}); }, []);
  if (!g || !g.enabled) return null;
  const ok = !!(g.connected && g.email);
  // Connected → a tiny footer status line (nav should dominate the sidebar);
  // NOT connected → keep the prominent connect button, since that's actionable.
  if (ok) {
    return (
      <div className="drive-card">
        <div className="dc-main">
          <b>Google Drive · <span style={{ color: "var(--green,#0E7A43)" }}>Connected</span></b>
          <span className="dc-status">{g.email} · <a href="/api/google/connect" style={{ color: "inherit" }}>switch</a></span>
        </div>
      </div>
    );
  }
  return (
    <div className="drive-card warn">
      <div className="dc-main">
        <b>☁ Google Drive</b>
        <span className="dc-status">Not connected — job sheets &amp; e-slips aren’t being saved to Drive</span>
      </div>
      <a className="btn sm primary" href="/api/google/connect">Connect Google Drive</a>
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
      <AuthHeader home={false} />
      <div className="op-layout">
        <OperatorNav active="dashboard">
          <DriveCard />
        </OperatorNav>
        <div className="op-main">

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
          const orphaned = d.orphaned ?? [];
          const past = d.pastUnstaffed ?? [];
          const attention = past.length + d.unassigned.length + d.understaffed.length + orphaned.length + d.leaveRequests.length;
          return (
        <div className="dash">
          {/* Page header — title left, primary actions right. */}
          <div className="dash-head">
            <div>
              <h1 className="page-title">Operator Dashboard</h1>
              <div className="page-sub">Today&rsquo;s tours, guide assignments, pending actions and payments.</div>
            </div>
            <div className="dash-head-actions">
              <a className="btn" href="/board">Dispatch board</a>
              <a className="btn primary" href="/bookings">+ New booking</a>
            </div>
          </div>

          {/* One compact KPI band — operations + money, all computed server-side. */}
          <div className="kpi-row">
            <Kpi n={d.todayTours.length} label="Tours today" sub={d.todayTours.length ? `${todayIn}/${d.todayTours.length} in · ${todayPax} guests` : undefined} onClick={() => jumpTo("today")} />
            <Kpi n={d.tomorrowTours.length} label="Tomorrow" onClick={() => jumpTo("tomorrow", "tomorrow")} />
            <Kpi n={d.unassigned.length} label="Unassigned" tone="warn" onClick={() => jumpTo("attention")} />
            <Kpi n={d.understaffed.length} label="Understaffed" tone="bad" onClick={() => jumpTo("attention")} />
            {orphaned.length > 0 && <Kpi n={orphaned.length} label="Orphaned" tone="bad" onClick={() => jumpTo("attention")} />}
            {d.finance && <>
              <MoneyKpi v={String(d.reportsPending ?? 0)} label="Reports pending" tone="warn" hot={(d.reportsPending ?? 0) > 0} sub="end-tour report" href="/tour-log" />
              <MoneyKpi v={String(d.finance.expensesToReview.count)} label="Expenses to review" tone="warn" hot={d.finance.expensesToReview.count > 0} sub={d.finance.expensesToReview.count ? thb0(d.finance.expensesToReview.total) : undefined} href="/payments" />
              <MoneyKpi v={thb0(d.finance.guidePayable.total)} label="Guide payable" sub={d.finance.guidePayable.guides ? `${d.finance.guidePayable.guides} guide${d.finance.guidePayable.guides === 1 ? "" : "s"} · ${d.finance.guidePayable.tours} tour${d.finance.guidePayable.tours === 1 ? "" : "s"}` : "all settled"} href="/payments" />
              <MoneyKpi v={String(d.finance.batches.open)} label="Open batches" tone="warn" hot={d.finance.batches.open > 0} sub={d.finance.batches.open ? `${thb0(d.finance.batches.openTotal)}` : "none open"} href="/payment-batches" />
              <MoneyKpi v={`${d.finance.peak.synced}`} label="PEAK refs" tone="warn" hot={d.finance.peak.pendingRef > 0} sub={d.finance.peak.pendingRef ? `${d.finance.peak.pendingRef} missing` : "all recorded"} href="/payments" />
            </>}
          </div>

          <div className="dash-cols">
          <div className="dash-main">
            {/* Today's Operations — the centrepiece: one dense row per running job.
                Row click opens the job sheet. Extra columns (job no. / report /
                expense / pay) come from the same single dashboard request. */}
            <section className="panel" id="today">
              <div className="panel-head"><h2>Today&rsquo;s operations</h2><span className="hint">{dShort(d.today)}{d.todayTours.length ? ` · ${d.todayTours.length} tour${d.todayTours.length === 1 ? "" : "s"} · ${todayPax} guests${todayOverdue ? ` · ⚠ ${todayOverdue} not checked in` : ""}` : ""}</span></div>
              {d.todayTours.length === 0 ? <div className="op-empty" style={{ padding: 18 }}>No tours today.</div> : (
                <div className="grid-scroll" style={{ padding: "0 6px 8px" }}>
                  <table className="ops-table">
                    <thead><tr><th>Time</th><th>Job No.</th><th>Tour</th><th>Guide</th><th>Guests</th><th>Check-in</th><th>Report</th><th>Expense</th><th>Pay</th></tr></thead>
                    <tbody>
                      {d.todayTours.map((a, i) => {
                        const reportNote = a.report && (a.report.noShow > 0 || a.report.leftEarly > 0 || a.report.comments);
                        return (
                          <tr key={i} onClick={() => { window.location.href = `/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`; }} title="Open this tour’s job sheet — full details">
                            <td style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{a.time}</td>
                            <td style={{ fontFamily: "monospace", fontSize: 11.5, whiteSpace: "nowrap" }}>{a.ref || "—"}</td>
                            <td><b>{a.tour}</b>{reportNote ? <div className="dr-sub">{a.report!.noShow > 0 ? `${a.report!.noShow} no-show` : ""}{a.report!.leftEarly > 0 ? ` · ${a.report!.leftEarly} left early` : ""}{a.report!.comments ? ` · ⚠ ${a.report!.comments}` : ""}</div> : null}</td>
                            <td>{a.guide}</td>
                            <td style={{ fontVariantNumeric: "tabular-nums" }}>{a.pax ?? "—"}</td>
                            <td><StateTag t={a} /></td>
                            <td>{a.report ? <span className="ob ok">✓ Reported</span> : a.state === "COMPLETE" ? <span className="ob warn">Pending</span> : <span className="ob mut">—</span>}</td>
                            <td>{a.expenseReported ? <span className="ob ok">✓ Reported</span> : <span className="ob mut">—</span>}</td>
                            <td>{a.payStatus === "PAID" ? <span className="ob ok">Paid</span> : a.payStatus === "APPROVED" ? <span className="ob warn">Approved</span> : <span className="ob mut">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
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

          {/* Right rail — exceptions + money snapshot. Only actionable state. */}
          <div className="dash-side">
            <section className="panel" id="attention">
              <div className="panel-head"><h2>Needs attention{attention > 0 ? ` (${attention})` : ""}</h2>{d.unassigned.length > 0 && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={exportUnassignedPdf} title="Print-ready list of tours that still need a guide — Save as PDF">PDF</button>}</div>
              <div className="dash-list">
                {attention === 0 && <div className="op-empty" style={{ padding: 14 }}>All operations are on track.</div>}
                {/* Tours that already ran with nobody rostered. First in the list
                    and never ageing out: each one is either a guide owed money for
                    work already done, or a booking nobody honoured. Both need an
                    answer, and until now both silently vanished the day after. */}
                {past.map((u, i) => (
                  <a key={`p${i}`} className="att-row att-past" href={`/bookings?focus=${u.date}`}
                     title="This tour ran with no guide on the system — record who guided it, or close the bookings">
                    <span className="dr-main">
                      <b>{dShort(u.date)} · {u.time}</b> — ran with no guide
                      <div className="dr-sub">{u.tour} · {u.pax} pax · {u.daysAgo} day{u.daysAgo === 1 ? "" : "s"} ago</div>
                    </span>
                    <span className="att-go">Record →</span>
                  </a>
                ))}
                {d.leaveRequests.map((l) => (
                  <div key={l.id} className="dash-row">
                    <span className="dr-main"><b>{l.guide}</b> · leave {dShort(l.fromDate)}{l.toDate !== l.fromDate ? `–${dShort(l.toDate)}` : ""}<div className="dr-sub">{l.reason || "leave request"}</div></span>
                    <span style={{ display: "flex", gap: 5 }}>
                      <button className="btn sm primary" onClick={() => decideLeave(l.id, "APPROVED")}>✓</button>
                      <button className="btn sm ghost" onClick={() => decideLeave(l.id, "REJECTED")}>✕</button>
                    </span>
                  </div>
                ))}
                {d.understaffed.map((u, i) => (
                  <a key={`s${i}`} className="att-row" href={`/jobs?split=${u.date}&slot=${u.slotIdx}`} title="Open Dispatch and split this tour to add a guide to the remaining guests">
                    <span className="att-dot" style={{ background: "var(--danger)" }} />
                    <span><b>{u.tour}</b><div className="dr-sub">{dShort(u.date)} {u.time} · {u.have}/{u.need} guides</div></span>
                    <span className="att-go">Assign →</span>
                  </a>
                ))}
                {orphaned.map((o, i) => (
                  <a key={`o${i}`} className="att-row" href={`/bookings?focus=${o.date}`} title="Guests tagged to a guide with no assignment — re-dispatch them">
                    <span className="att-dot" style={{ background: "var(--danger)" }} />
                    <span><b>{o.tour}</b><div className="dr-sub">{dShort(o.date)} {o.time} · {o.pax} pax tagged to {o.guide}</div></span>
                    <span className="att-go">Fix →</span>
                  </a>
                ))}
                {d.unassigned.map((u, i) => (
                  <a key={`u${i}`} className="att-row" href={`/bookings?focus=${u.date}`} title="Open Bookings to dispatch this tour">
                    <span className="att-dot" style={{ background: "var(--assign)" }} />
                    <span><b>{u.tour}</b><div className="dr-sub">{dShort(u.date)} {u.time} · {u.pax} pax · needs {u.need}</div></span>
                    <span className="att-go">Assign →</span>
                  </a>
                ))}
              </div>
            </section>

            {d.finance && (
              <section className="panel">
                <div className="panel-head"><h2>Finance &amp; accounting</h2></div>
                <div style={{ padding: "4px 16px 12px" }}>
                  <div className="fin-row"><span>Expenses awaiting review</span><b>{d.finance.expensesToReview.count ? `${d.finance.expensesToReview.count} · ${thb0(d.finance.expensesToReview.total)}` : "0"}</b></div>
                  <div className="fin-row"><span>Guide payable</span><b>{thb0(d.finance.guidePayable.total)}</b></div>
                  {d.finance.guidePayable.guides > 0 && <div className="fin-row"><span><small>{d.finance.guidePayable.guides} guide{d.finance.guidePayable.guides === 1 ? "" : "s"} · {d.finance.guidePayable.tours} tour{d.finance.guidePayable.tours === 1 ? "" : "s"}</small></span><b /></div>}
                  <div className="fin-row"><span>Payment batch</span><b>{d.finance.batches.open ? `${d.finance.batches.open} open · ${thb0(d.finance.batches.openTotal)}` : "No open batch"}</b></div>
                  <div className="fin-row"><span>Paid this week</span><b>{d.finance.batches.paidWeekCount ? thb0(d.finance.batches.paidWeekTotal) : "—"}</b></div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    <a className="btn sm" href="/payments">Review expenses</a>
                    <a className="btn sm" href="/payment-batches">Batches</a>
                  </div>
                </div>
              </section>
            )}

            {d.finance && (
              <section className="panel">
                <div className="panel-head"><h2>PEAK accounting</h2></div>
                <div style={{ padding: "4px 16px 12px" }}>
                  <div className="fin-row">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span className="att-dot" style={{ background: d.finance.peak.pendingRef ? "var(--assign)" : "var(--green)" }} />
                      Reference tracking
                    </span>
                    <b>{d.finance.peak.pendingRef ? `${d.finance.peak.pendingRef} missing` : "All recorded"}</b>
                  </div>
                  <div className="fin-row"><span>EXP refs this month</span><b>{d.finance.peak.synced}</b></div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-soft)", marginTop: 6 }}>Expense refs are recorded on Payments when payouts are posted.</div>
                  <div style={{ marginTop: 8 }}><a className="btn sm" href="/payments">Open Payments</a></div>
                </div>
              </section>
            )}

            {/* Broadcast — demoted to a secondary card; opens the composer in place. */}
            <section className="panel">
              <div style={{ padding: "12px 16px" }}>
                <div style={{ fontSize: 14, fontWeight: 650 }}>Broadcast to guides</div>
                <div className="dr-sub" style={{ marginTop: 2 }}>Send an update to guides with upcoming tours — in-app, push and LINE.</div>
                {!bcOpen ? (
                  <button className="btn sm" style={{ marginTop: 9 }} onClick={() => setBcOpen(true)}>Create broadcast</button>
                ) : (
                  <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 7 }}>
                    <textarea value={bcText} onChange={(e) => setBcText(e.target.value)} maxLength={500} rows={3} placeholder="e.g. Heavy rain expected today, please bring umbrellas for guests." className="search" style={{ width: "100%", resize: "vertical", font: "inherit", fontSize: 13, lineHeight: 1.5 }} />
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{bcText.length}/500</span>
                      <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setBcOpen(false)}>Cancel</button>
                      <button className="btn sm primary" disabled={bcBusy || !bcText.trim()} onClick={sendBroadcast}>{bcBusy ? "Sending…" : "Send"}</button>
                    </div>
                    {bcMsg && <div style={{ fontSize: 12.5, fontWeight: 600, color: bcMsg.startsWith("✅") ? "var(--green)" : "var(--danger)" }}>{bcMsg}</div>}
                  </div>
                )}
              </div>
            </section>
          </div>
          </div>
        </div>
        );
      })())}
        </div>
      </div>
    </div>
  );
}
