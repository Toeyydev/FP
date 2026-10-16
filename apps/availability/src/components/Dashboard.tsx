"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { OperatorNav } from "@/components/OperatorNav";
import RecordPastTourDialog from "@/components/RecordPastTourDialog";
import { groupByDate } from "@/lib/past-unstaffed";
import { bangkokMinute, todayView } from "@/lib/today-list";

type Report = { noShow: number; leftEarly: number; completedPax: number | null; comments: string | null };
type Tour = { date: string; slotIdx: number; time: string; tour: string; guideId: string; guide: string; pax: number | null; state: string; checkedAt: string | null; overdue: boolean; report: Report | null; ref?: string | null; expenseReported?: boolean; payStatus?: string | null };

type Unassigned = { date: string; slotIdx: number; time: string; tour: string; pax: number; count: number; need: number; offer?: "DECLINED" | "EXPIRED" | "OPEN" | null };
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
type Data = { today: string; todayTours: Tour[]; tomorrowTours: Tour[]; upcomingTours: Tour[]; unassigned: Unassigned[]; understaffed: Understaffed[]; pastUnstaffed?: PastUnstaffed[]; conflicts: Conflict[]; orphaned: Orphaned[]; leaveRequests: Leave[]; reportsPending?: number; finance?: Finance ; process?: { awaitingReview: number; awaitingTransfer: number; awaitingPeak: number }};

// Compact baht for the home page lines — whole-baht, no decimals (the tables keep 2dp via thb).
const thb0 = (v: number) => `฿${Math.round(v).toLocaleString("en-US")}`;

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

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
  // "Record who guided" for one day that already happened (past unstaffed tours).
  const [recordDay, setRecordDay] = useState<string | null>(null);
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
  const [hidden, setHidden] = useState<Set<string>>(new Set(["tomorrow", "upcoming", "money"]));
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
          const todayPax = d.todayTours.reduce((s, t) => s + (t.pax ?? 0), 0);
          const orphaned = d.orphaned ?? [];
          const past = d.pastUnstaffed ?? [];
          // The admin's later steps in the process (lib/job-process), each a row of its own.
          const proc = d.process ?? { awaitingReview: 0, awaitingTransfer: 0, awaitingPeak: 0 };
          const procRows = ([["AWAITING_REVIEW", proc.awaitingReview, "job sheet", "to review and approve", "รอตรวจและอนุมัติ"], ["AWAITING_TRANSFER", proc.awaitingTransfer, "approved job", "to pay — transfer and upload the slip", "รอโอนเงิน"], ["AWAITING_PEAK", proc.awaitingPeak, "paid job", "not in PEAK yet", "จ่ายแล้ว รอลง PEAK"]] as const).filter((r) => r[1] > 0);
          const attention = past.length + d.unassigned.length + d.understaffed.length + orphaned.length + d.leaveRequests.length + procRows.length;
          const moneyNeeds = !d.finance ? 0 : [(d.reportsPending ?? 0) > 0, d.finance.expensesToReview.count > 0, d.finance.guidePayable.total > 0 && !procRows.some((r) => r[0] === "AWAITING_TRANSFER"), d.finance.batches.open > 0, d.finance.peak.pendingRef > 0].filter(Boolean).length;
          const needs = attention + moneyNeeds;
          return (
        <div className="dash">
          {/* Operator home (owner 2026-10-16, "simpler"): one column — Needs you, Today, then
              one summary line each for tomorrow, the week and money. No number tiles: every
              count is a line in Needs you with its button, or is not shown when it is 0. */}
          <div className="home-head">
            <h1 className="page-title">{new Date(`${d.today}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</h1>
            <button className="btn js-broadcast-open" aria-expanded={bcOpen} onClick={() => setBcOpen((o) => !o)}>📣 Broadcast</button>
            <a className="btn primary" href="/bookings">+ New booking</a>
          </div>
          {bcOpen && (
            <section className="panel home-bc">
              <div style={{ fontSize: 14, fontWeight: 650 }}>Broadcast to guides</div>
              <div className="dr-sub" style={{ marginTop: 2 }}>Send an update to guides with upcoming tours — in-app, push and LINE.</div>
              <textarea value={bcText} onChange={(e) => setBcText(e.target.value)} maxLength={500} rows={3} placeholder="e.g. Heavy rain expected today, please bring umbrellas for guests." className="search" style={{ width: "100%", resize: "vertical", font: "inherit", fontSize: 13, lineHeight: 1.5, marginTop: 8 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>{bcText.length}/500</span>
                <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setBcOpen(false)}>Cancel</button>
                <button className="btn sm primary" disabled={bcBusy || !bcText.trim()} onClick={sendBroadcast}>{bcBusy ? "Sending…" : "Send"}</button>
              </div>
              {bcMsg && <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 6, color: bcMsg.startsWith("✅") ? "var(--green)" : "var(--danger)" }}>{bcMsg}</div>}
            </section>
          )}

          <div className="home-col">
            <section className="panel" id="attention">
              <div className="panel-head"><h2>Needs you{needs > 0 ? ` · ${needs}` : ""}</h2>{d.unassigned.length > 0 && <button className="btn sm" style={{ marginLeft: "auto" }} onClick={exportUnassignedPdf} title="Print-ready list of tours that still need a guide — Save as PDF">PDF</button>}</div>
              <div className="dash-list">
                {needs === 0 && <div className="op-empty" style={{ padding: 14 }}>All on track ✓</div>}
                {/* Tours that already ran with nobody rostered. First in the list
                    and never ageing out: each one is either a guide owed money for
                    work already done, or a booking nobody honoured. Both need an
                    answer, and until now both silently vanished the day after. */}
                {/* One row per DAY: tours on the same day belong together, and the
                    guide who ran one of them often ran the others. Record opens that
                    day's tours in a dialog with a guide picker for each. */}
                {groupByDate(past).map((g) => {
                  const pax = g.items.reduce((t, u) => t + u.pax, 0);
                  return (
                    <button key={`p${g.date}`} type="button" className="att-row att-past" onClick={() => setRecordDay(g.date)}
                       style={{ width: "100%", textAlign: "left", font: "inherit", cursor: "pointer", border: 0 }}
                       title="These tours ran with no guide on the system — record who guided them, or close the bookings">
                      <span className="dr-main">
                        <b>{dShort(g.date)}</b> — {g.items.length === 1 ? "ran with no guide" : `${g.items.length} tours ran with no guide`}
                        {g.items.map((u, i) => <div key={i} className="dr-sub">{u.time} · {u.tour} · {u.pax} pax</div>)}
                        <div className="dr-sub">{g.items.length > 1 ? `${pax} pax · ` : ""}{g.items[0].daysAgo} day{g.items[0].daysAgo === 1 ? "" : "s"} ago</div>
                      </span>
                      <span className="att-go">Record →</span>
                    </button>
                  );
                })}
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
                {procRows.map(([stage, n, what, todo, th]) => (
                  <a key={stage} className="att-row js-proc-task" data-stage={stage} href={`/process?stage=${stage}`} title="Open these jobs on the Job process board">
                    <span className="att-dot" style={{ background: "var(--assign)" }} />
                    <span><b>{n} {what}{n === 1 ? "" : "s"}</b> {todo}{stage === "AWAITING_TRANSFER" && d.finance && d.finance.guidePayable.total > 0 ? ` · ${thb0(d.finance.guidePayable.total)}` : ""}<div className="dr-sub" title={th}>last 60 days</div></span>
                    <span className="att-go">Open →</span>
                  </a>
                ))}
                {orphaned.map((o, i) => (
                  <a key={`o${i}`} className="att-row" href={`/bookings?date=${o.date}`} title="Guests tagged to a guide with no assignment — re-dispatch them">
                    <span className="att-dot" style={{ background: "var(--danger)" }} />
                    <span><b>{o.tour}</b><div className="dr-sub">{dShort(o.date)} {o.time} · {o.pax} pax tagged to {o.guide}</div></span>
                    <span className="att-go">Fix →</span>
                  </a>
                ))}
                {groupByDate(d.unassigned, "asc").map((g) => {
                  // Today's tours whose start time has passed drop out of the Inbox: name
                  // their guide here instead (the same dialog as a past day).
                  const nowMin = (() => { const x = new Date(Date.now() + 7 * 3600 * 1000); return x.getUTCHours() * 60 + x.getUTCMinutes(); })();
                  const startedToday = g.date === d.today && g.items.some((u) => { const [h, m] = u.time.split(":").map(Number); return h * 60 + m <= nowMin; });
                  const body = (
                    <>
                      <span className="att-dot" style={{ background: "var(--assign)" }} />
                      <span><b>{dShort(g.date)}</b>{g.items.length > 1 ? ` · ${g.items.length} tours need a guide` : ""}
                        {g.items.map((u, i) => <div key={i} className="dr-sub">{u.time} · {u.tour} · {u.pax} pax · needs {u.need}{u.offer === "DECLINED" ? <b className="js-offer-back" style={{ color: "var(--danger)" }}> · offer declined — reassign</b> : u.offer === "EXPIRED" ? <b className="js-offer-back" style={{ color: "var(--danger)" }}> · offer expired — reassign</b> : u.offer === "OPEN" ? <span> · offered, waiting for the guide</span> : null}</div>)}
                      </span>
                      <span className="att-go">{startedToday ? "Record →" : "Assign →"}</span>
                    </>
                  );
                  return startedToday
                    ? <button key={`u${g.date}`} type="button" className="att-row" onClick={() => setRecordDay(g.date)} style={{ width: "100%", textAlign: "left", font: "inherit", cursor: "pointer", border: 0, background: "none" }} title="These tours have started with no guide — name who is guiding them">{body}</button>
                    : <a key={`u${g.date}`} className="att-row" href={`/bookings?date=${g.date}`} title="Open Bookings to dispatch this day's tours">{body}</a>;
                })}
                {/* Money that waits on the operator — one line each, only when there is some. */}
                {(d.reportsPending ?? 0) > 0 && (
                  <a className="att-row js-need-reports" href="/tour-log"><span className="att-dot" style={{ background: "var(--assign)" }} /><span><b>{d.reportsPending} report{d.reportsPending === 1 ? "" : "s"}</b> not filed yet</span><span className="att-go">Open →</span></a>
                )}
                {d.finance && d.finance.expensesToReview.count > 0 && (
                  <a className="att-row js-need-expenses" href="/expense-review"><span className="att-dot" style={{ background: "var(--assign)" }} /><span><b>{d.finance.expensesToReview.count} guide expense report{d.finance.expensesToReview.count === 1 ? "" : "s"}</b> to review · {thb0(d.finance.expensesToReview.total)}</span><span className="att-go">Review →</span></a>
                )}
                {d.finance && d.finance.guidePayable.total > 0 && !procRows.some((r) => r[0] === "AWAITING_TRANSFER") && (
                  <a className="att-row js-need-pay" href="/payments"><span className="att-dot" style={{ background: "var(--assign)" }} /><span><b>Pay {thb0(d.finance.guidePayable.total)}</b> · {d.finance.guidePayable.guides} guide{d.finance.guidePayable.guides === 1 ? "" : "s"} · {d.finance.guidePayable.tours} tour{d.finance.guidePayable.tours === 1 ? "" : "s"}</span><span className="att-go">Payments →</span></a>
                )}
                {d.finance && d.finance.batches.open > 0 && (
                  <a className="att-row js-need-batch" href="/payment-batches"><span className="att-dot" style={{ background: "var(--assign)" }} /><span><b>{d.finance.batches.open} open payment batch{d.finance.batches.open === 1 ? "" : "es"}</b> · {thb0(d.finance.batches.openTotal)}</span><span className="att-go">Open →</span></a>
                )}
                {d.finance && d.finance.peak.pendingRef > 0 && (
                  <a className="att-row js-need-peak" href="/payments"><span className="att-dot" style={{ background: "var(--assign)" }} /><span><b>{d.finance.peak.pendingRef} PEAK ref{d.finance.peak.pendingRef === 1 ? "" : "s"}</b> missing</span><span className="att-go">Payments →</span></a>
                )}
              </div>
            </section>

            {/* Today — one plain line per tour: time, tour, guide · pax, and one status
                (lib/today-list). A tour past its start with no check-in turns red and
                says how late. Job no., expense and pay live on the job sheet it opens. */}
            {(() => {
              const nowMin = bangkokMinute();
              const late = d.todayTours.filter((a) => todayView(a, nowMin).kind === "LATE").length;
              return (
            <section className="panel" id="today">
              <div className="panel-head"><h2>Today</h2><span className="hint">{dShort(d.today)}{d.todayTours.length ? ` · ${d.todayTours.length} tour${d.todayTours.length === 1 ? "" : "s"} · ${todayPax} guests` : ""}{late ? <b className="today-late-count"> · ⚠ {late} late</b> : null}</span></div>
              <div className="dash-list today-list">
                {d.todayTours.length === 0 ? <div className="op-empty">No tours today.</div> : d.todayTours.map((a) => {
                  const v = todayView(a, nowMin);
                  const chip = v.kind === "LATE" && v.rel !== "now" ? `⚠ ${v.rel}` : v.chip;
                  const r = a.report;
                  const note = r ? [r.noShow > 0 ? `${r.noShow} no-show` : "", r.leftEarly > 0 ? `${r.leftEarly} left early` : ""].filter(Boolean).join(" · ") : "";
                  return (
                    <a key={`${a.guideId}|${a.slotIdx}`} className={`dash-row today-row k-${v.kind.toLowerCase()}`} href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title={`Open the job sheet${a.ref ? ` · ${a.ref}` : ""}`}>
                      <span className="dr-time">{a.time}</span>
                      <span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}{note ? ` · ${note}` : ""}</div></span>
                      <span className={`today-ck t-${v.tone}`}>{chip}</span>
                    </a>
                  );
                })}
              </div>
            </section>
              );
            })()}

            {/* Tomorrow, the week and money: one summary line each; Show opens the detail. */}
            {(() => {
              const tomorrow = new Date(Date.parse(`${d.today}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
              const staffedTomorrow = !d.unassigned.some((u) => u.date === tomorrow) && !d.understaffed.some((u) => u.date === tomorrow);
              const fin = d.finance;
              const line = (key: string, title: string, sub: string) => (
                <button type="button" className={`home-line js-home-${key}`} aria-expanded={!hidden.has(key)} onClick={() => toggleSec(key)}>
                  <b>{title}</b><span>{sub}</span><em>{hidden.has(key) ? "Show ▸" : "Hide ▴"}</em>
                </button>
              );
              return (
                <section className="panel home-summary">
                  {line("tomorrow", "Tomorrow", `${d.tomorrowTours.length} tour${d.tomorrowTours.length === 1 ? "" : "s"}${d.tomorrowTours.length ? (staffedTomorrow ? " · all have a guide" : " · some need a guide") : ""}`)}
                  <div id="tomorrow" className="dash-list" style={{ display: hidden.has("tomorrow") ? "none" : undefined }}>
                {d.tomorrowTours.length === 0 ? <div className="op-empty">No tours tomorrow.</div> : d.tomorrowTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
                  </div>
                  {line("upcoming", "Next 7 days", `${d.upcomingTours.length} tour${d.upcomingTours.length === 1 ? "" : "s"}`)}
                  <div id="upcoming" className="dash-list" style={{ display: hidden.has("upcoming") ? "none" : undefined }}>
                {d.upcomingTours.length === 0 ? <div className="op-empty">Nothing scheduled.</div> : d.upcomingTours.map((a, i) => (
                  <a key={i} className="dash-row" href={`/job-sheet?guideId=${encodeURIComponent(a.guideId)}&date=${a.date}&slotIdx=${a.slotIdx}`} title="Open this tour’s job sheet — full details"><span className="dr-time">{dShort(a.date)}<br /><small>{a.time}</small></span><span className="dr-main"><b>{a.tour}</b><div className="dr-sub">{a.guide}{a.pax != null ? ` · ${a.pax} pax` : ""}</div></span></a>
                ))}
                  </div>
                  {fin && line("money", "Money & PEAK", [fin.batches.open ? `${fin.batches.open} open batch${fin.batches.open === 1 ? "" : "es"}` : "no open batch", fin.batches.paidWeekCount ? `paid this week ${thb0(fin.batches.paidWeekTotal)}` : "", fin.peak.pendingRef ? `${fin.peak.pendingRef} PEAK refs missing` : "PEAK refs all recorded"].filter(Boolean).join(" · "))}
                  {fin && (
                    <div className="home-money" style={{ display: hidden.has("money") ? "none" : undefined }}>
                      <div className="fin-row"><span>Expenses awaiting review</span><b>{fin.expensesToReview.count ? `${fin.expensesToReview.count} · ${thb0(fin.expensesToReview.total)}` : "0"}</b></div>
                      <div className="fin-row"><span>Guide payable</span><b>{thb0(fin.guidePayable.total)}{fin.guidePayable.guides ? ` · ${fin.guidePayable.guides} guide${fin.guidePayable.guides === 1 ? "" : "s"} · ${fin.guidePayable.tours} tour${fin.guidePayable.tours === 1 ? "" : "s"}` : ""}</b></div>
                      <div className="fin-row"><span>Payment batch</span><b>{fin.batches.open ? `${fin.batches.open} open · ${thb0(fin.batches.openTotal)}` : "No open batch"}</b></div>
                      <div className="fin-row"><span>Paid this week</span><b>{fin.batches.paidWeekCount ? thb0(fin.batches.paidWeekTotal) : "—"}</b></div>
                      <div className="fin-row"><span>PEAK refs</span><b>{fin.peak.pendingRef ? `${fin.peak.pendingRef} missing` : "All recorded"} · {fin.peak.synced} EXP this month</b></div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                        <a className="btn sm" href="/payments">Payments</a>
                        <a className="btn sm" href="/expense-review">Review expenses</a>
                        <a className="btn sm" href="/payment-batches">Batches</a>
                      </div>
                    </div>
                  )}
                </section>
              );
            })()}
          </div>
        </div>
        );
      })())}
        </div>
      </div>
      {recordDay && <RecordPastTourDialog date={recordDay} onClose={() => setRecordDay(null)} onChanged={() => load()} />}
    </div>
  );
}
