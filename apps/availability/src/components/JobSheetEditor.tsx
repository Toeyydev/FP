"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { computeTotals, expenseAmount, noShowStatus, thb, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
import { SLOT_TIMES } from "@/lib/slots";

type Header = { guideId: string; name: string; email: string; tel: string; taxId: string; address: string } | null;
type Tour = { id: string; name: string; time: string; durationMin?: number | null } | null;

// Google Calendar "add event" link — opens a pre-filled event the guide saves
// in one tap (Google then sends its own reminders). Bangkok time → UTC.
function gcalUrl(tourName: string, date: string, slotIdx: number, durationMin: number, details: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [H, M] = (SLOT_TIMES[slotIdx] || "09:00").split(":").map(Number);
  const startMs = Date.UTC(y, m - 1, d, H, M) - 7 * 3600 * 1000;
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dates = `${f(startMs)}/${f(startMs + durationMin * 60000)}`;
  const params = new URLSearchParams({ action: "TEMPLATE", text: `Folkpaths tour — ${tourName}`, dates, details });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
type Sheet = {
  ref: string | null; guideId: string; date: string; slotIdx: number; tourId: string; status: string;
  bookings: Booking[]; expenses: Expense[]; guideFee: GuideFee; updatedAt?: string | null;
  guideExpenses?: Expense[] | null; guideExpensesAt?: string | null; guideExpensesNote?: string | null;
};

const numOrNull = (v: string): number | null => { if (v.trim() === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export default function JobSheetEditor() {
  const router = useRouter();
  const sp = useSearchParams();
  const guideId = sp.get("guideId") || "";
  const date = sp.get("date") || "";
  const slotIdx = Number(sp.get("slotIdx") ?? "-1");

  const [header, setHeader] = useState<Header>(null);
  const [tour, setTour] = useState<Tour>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [checkedIn, setCheckedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showFull, setShowFull] = useState(false); // guides see the summary; expand for full sheet
  const [drive, setDrive] = useState<{ enabled: boolean; connected: boolean }>({ enabled: false, connected: false }); // Google Drive save
  const [guideExp, setGuideExp] = useState<Expense[]>([]); // guide's own expense report (separate from official)
  const [guideNote, setGuideNote] = useState(""); // free-text note with the guide's report
  const [expBusy, setExpBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/jobsheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" });
    if (!r.ok) { setMsg("Could not load this job sheet."); return; }
    const d = await r.json();
    setHeader(d.header); setTour(d.tour); setSheet(d.sheet); setSaved(d.saved); setCanEdit(d.canEdit !== false); setCheckedIn(!!d.checkedIn);
    // Seed the guide's expense report: their last submission if any, else the standard
    // expense lines (with prices) as a starting template to fill in.
    const s = d.sheet as Sheet;
    setGuideExp((s?.guideExpenses && s.guideExpenses.length ? s.guideExpenses : (s?.expenses ?? [])).map((e: Expense) => ({ ...e })));
    setGuideNote(s?.guideExpensesNote ?? "");
  }, [guideId, date, slotIdx]);
  useEffect(() => { if (guideId && date && slotIdx >= 0) load(); }, [load, guideId, date, slotIdx]);
  useEffect(() => { fetch("/api/jobsheet/drive").then((r) => (r.ok ? r.json() : null)).then((d) => d && setDrive({ enabled: !!d.enabled, connected: !!d.connected })).catch(() => {}); }, []);

  // Entrance-fee items (Grand Palace, Wat Pho, Wat Arun) are paid only for guests
  // whose tickets are "Included". Keep their pax in sync with that count.
  useEffect(() => {
    setSheet((prev) => {
      if (!prev) return prev;
      const ATTRACTIONS = ["grand palace", "wat pho", "wat arun"];
      const inclPax = prev.bookings.reduce((s, b) => s + (b.tickets === "included" ? (b.actualPax ?? b.bookedPax ?? 0) : 0), 0);
      let changed = false;
      const expenses = prev.expenses.map((e) => {
        const isAttraction = ATTRACTIONS.some((a) => e.description.trim().toLowerCase().startsWith(a));
        if (isAttraction && e.pax !== inclPax) { changed = true; return { ...e, pax: inclPax }; }
        return e;
      });
      return changed ? { ...prev, expenses } : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(sheet?.bookings?.map((b) => [b.tickets, b.actualPax, b.bookedPax]))]);

  if (!sheet) return <div className="wrap"><section className="panel"><div className="op-empty">{msg || "…"}</div></section></div>;

  const t = computeTotals(sheet.expenses, sheet.guideFee);
  const ro = !canEdit; // read-only (guide view)
  // Guides may tick no-shows only AFTER they've checked in AND within 30 min of the
  // tour start (that's when who turned up is known). Operators can mark any time.
  const startMs = Date.parse(`${sheet.date}T00:00:00Z`) + (((SLOT_TIMES[sheet.slotIdx] || "00:00").split(":").map(Number).reduce((h, m) => h * 60 + m, 0)) * 60_000) - 7 * 3600 * 1000;
  const inNoShowWindow = Date.now() >= startMs && Date.now() <= startMs + 30 * 60_000;
  const canMarkNoShow = canEdit || (checkedIn && inNoShowWindow);
  // Any edit marks the sheet dirty, so the PDF / Excel / e-slip buttons (which
  // auto-save only when !saved) always persist the change before exporting/uploading.
  const up = (patch: Partial<Sheet>) => { setSheet({ ...sheet, ...patch }); setSaved(false); if (msg) setMsg(""); };
  const setBooking = (i: number, p: Partial<Booking>) => up({ bookings: sheet.bookings.map((b, j) => j === i ? { ...b, ...p } : b) });
  // Guide (or operator) records how many of a booking's guests didn't arrive
  // (0 = all came, whole pax = fully absent, in between = partial). Persists to the
  // Booking so it shows in the operator's Tour Log; updates the row locally without
  // dirtying the sheet.
  const markNoShow = async (i: number, b: Booking, noShowPax: number) => {
    const P = b.bookedPax ?? 0;
    const ns = Math.max(0, Math.min(noShowPax, P || noShowPax));
    setSheet((s) => s ? { ...s, bookings: s.bookings.map((x, j) => j === i ? { ...x, noShowPax: ns, status: noShowStatus(ns, x.bookedPax), actualPax: Math.max(0, (x.bookedPax ?? 0) - ns) } : x) } : s);
    if (!b.bookingNo) return;
    // Record it first — the API also mirrors the count / status / actual pax onto the sheet.
    await fetch("/api/jobsheet/noshow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx, bookingNo: b.bookingNo, noShowPax: ns }) }).catch(() => {});
    // …then upload a fresh copy to the Folkpaths Drive right away so the operator's
    // record reflects it immediately (best-effort; needs a saved sheet + Drive).
    if (drive.enabled && drive.connected) {
      try {
        const r = await fetch("/api/jobsheet/drive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx }) });
        setMsg(r.ok ? (ns > 0 ? "No-show saved & uploaded to Drive ✓" : "Updated & uploaded to Drive ✓") : "No-show saved ✓");
      } catch { setMsg("No-show saved ✓"); }
    } else setMsg(ns > 0 ? "No-show saved ✓" : "Updated ✓");
  };
  const setExpense = (i: number, p: Partial<Expense>) => up({ expenses: sheet.expenses.map((e, j) => j === i ? { ...e, ...p } : e) });
  const sum = (key: "bookedPax" | "actualPax") => sheet.bookings.reduce((s, b) => s + (b[key] ?? 0), 0);
  // Total no-show pax reported across the sheet's bookings (per-booking count, with a
  // fallback for legacy rows that only carry the "no-show" status).
  const noShowTotal = sheet.bookings.reduce((s, b) => s + (b.noShowPax ?? (b.status === "no-show" ? (b.bookedPax ?? 0) : 0)), 0);

  // ---- Guide's own expense report (separate from the operator's official set) ----
  const setGExp = (i: number, p: Partial<Expense>) => setGuideExp((arr) => arr.map((e, j) => j === i ? { ...e, ...p } : e));
  const addGExp = () => setGuideExp((arr) => [...arr, { description: "", price: null, pax: null }]);
  const rmGExp = (i: number) => setGuideExp((arr) => arr.filter((_, j) => j !== i));
  const guideExpTotal = guideExp.reduce((s, e) => s + expenseAmount(e), 0);
  async function submitGuideExpenses() {
    if (!sheet) return;
    setExpBusy(true); setMsg("");
    const clean = guideExp.filter((e) => (e.description || "").trim() || expenseAmount(e) > 0);
    const r = await fetch("/api/jobsheet/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet.guideId, date: sheet.date, slotIdx: sheet.slotIdx, expenses: clean, note: guideNote.trim() }) });
    setExpBusy(false);
    if (r.ok) { setMsg("Expenses sent to the operator ✓"); load(); } else setMsg("Couldn't submit expenses — try again.");
  }
  // Operator: merge the guide's reported figures into the official expenses (then Save).
  // Make the official expenses EXACTLY the guide's reported figures — the guide ran the
  // tour, so their report is the actual spend. The Total updates to the guide's number
  // (an unreported template line like the lotus drops off). A line the guide left out
  // that still has a real amount is called out in the confirm so it isn't lost by
  // accident — the operator can cancel and add it back.
  async function acceptGuideExpenses() {
    if (!sheet?.guideExpenses) return;
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const gd = sheet.guideExpenses;
    const adopted = gd.map((e) => ({ ...e }));
    const gdKeys = new Set(gd.map((e) => norm(e.description)));
    const droppedReal = (sheet.expenses ?? []).filter((e) => !gdKeys.has(norm(e.description)) && expenseAmount(e) > 0);
    const gdTot = gd.reduce((s, e) => s + expenseAmount(e), 0);
    const warn = droppedReal.length
      ? `\n\nThe guide didn't report these — they'll be removed:\n${droppedReal.map((e) => `· ${e.description}  ${thb(expenseAmount(e))}`).join("\n")}`
      : "";
    if (!confirm(`Set the official expenses to the guide's reported figures (${thb(gdTot)})?${warn}`)) return;
    up({ expenses: adopted });                 // Total updates to the guide's number right away
    const ok = await save({ expenses: adopted }); // …and persist it in the same click
    if (ok) setMsg(`Official expenses set to the guide's report (${thb(gdTot)}) ✓`);
  }
  // Cross-check rows: merge official + guide-reported by description.
  const crossRows = (() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const op = sheet?.expenses ?? [], gd = sheet?.guideExpenses ?? [];
    const keys = [...new Set([...op.map((e) => norm(e.description)), ...gd.map((e) => norm(e.description))])];
    return keys.map((k) => {
      const o = op.find((e) => norm(e.description) === k), g = gd.find((e) => norm(e.description) === k);
      const oa = o ? expenseAmount(o) : null, ga = g ? expenseAmount(g) : null;
      const desc = (o?.description || g?.description || "").trim();
      let flag: "match" | "differ" | "added" | "opOnly" = "match";
      if (oa == null) flag = "added"; else if (ga == null) flag = "opOnly"; else if (Math.round(oa) !== Math.round(ga)) flag = "differ";
      return { desc, oa, ga, flag };
    });
  })();

  // `override` lets a caller save fields it just computed WITHOUT waiting for the
  // async setState to land (e.g. accept-guide-expenses saves the merged list right
  // away). Falls back to current sheet state when omitted.
  async function save(override?: Partial<Sheet>): Promise<boolean> {
    setBusy(true); setMsg("");
    const s = { ...sheet!, ...override };
    const r = await fetch("/api/jobsheet", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: s.guideId, date: s.date, slotIdx: s.slotIdx, tourId: s.tourId, status: s.status, bookings: s.bookings, expenses: s.expenses, guideFee: s.guideFee }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "bad-body" ? (d.detail ? `Check: ${d.detail}` : "Please check the values.") : d.error === "forbidden" ? "Operator only." : "Save failed."); return false; }
    setSheet(d.sheet); setSaved(true); setMsg("Saved ✓"); return true;
  }
  async function sendToGuide() {
    // Auto-save first so you never hit a "save first" dead-end.
    if (!saved) { const ok = await save(); if (!ok) return; }
    setBusy(true); setMsg("Sending…");
    const r = await fetch("/api/jobsheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ date: sheet!.date, guideId: sheet!.guideId }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg("Send failed."); return; }
    if ((d.count ?? 0) === 0) { setMsg("Nothing to send — assign a guide to this slot first."); return; }
    setMsg(d.lineSent > 0 ? `✅ Sent to guide on LINE` : `✅ Sent to guide's in-app inbox (link LINE to also send there)`);
  }

  const L = { width: "100%", boxSizing: "border-box" as const, padding: "5px 7px", border: "1px solid var(--line,#d9d9d9)", borderRadius: 6, font: "inherit" };

  return (
    <div className="wrap jobsheet">
      <div className="js-bar no-print">
        <button className="btn ghost" onClick={() => router.back()}>← Back</button>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {ro && <span style={{ color: "var(--ink-soft,#888)", fontWeight: 600, fontSize: 13 }}>View only</span>}
          <span style={{ color: saved ? "var(--green,#1a7f37)" : "var(--ink-soft,#888)", fontWeight: 600, fontSize: 13 }}>{msg}</span>
          {ro && <button className="btn primary" onClick={() => window.open(`/api/jobsheet/joborder?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener")} title="Open your official guide job order (ใบสั่งงานมัคคุเทศก์)">Job order</button>}
          {ro && <button className="btn" onClick={() => window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener")} title="Open the full job sheet as a PDF for reference">📄 PDF</button>}
          <a className="btn" target="_blank" rel="noopener noreferrer"
            href={gcalUrl(tour?.name ?? "Tour", sheet.date, sheet.slotIdx, tour?.durationMin || 180, `Guide: ${header?.name ?? ""}\nFolkpath job · open the app for full details`)}>Add to Google Calendar</a>
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>PDF</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/joborder?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>Job order</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.location.href = `/api/jobsheet/export?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`; }}>Excel</button>}
          {canEdit && drive.enabled && !drive.connected && <a className="btn" href="/api/google/connect" title="Connect a Google account so the PDF can be saved to Drive">☁ Connect Google Drive</a>}
          {canEdit && <button className="btn" disabled={busy} onClick={sendToGuide}>Send to guide</button>}
          {canEdit && <button className="btn primary" disabled={busy} onClick={() => save()}>{busy ? "…" : "Save"}</button>}
        </div>
      </div>

      {sheet.status === "Review: no-show" && (
        <div style={{ margin: "0 0 14px", padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", border: "1px solid var(--danger-line)", color: "var(--danger)", fontWeight: 600, fontSize: 13.5 }}>
          ⚠ A guide reported a no-show on this tour. Absent guests were removed from the pax counts and ticket expenses — confirm the numbers before payout.
        </div>
      )}

      {ro && (() => {
        const totalPax = sheet.bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0);
        const exp = sheet.expenses.filter((e) => expenseAmount(e) > 0);
        const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
        const canReport = checkedIn || sheet.date <= today; // tour done → guide reports expenses
        const expShown = canReport ? guideExpTotal : t.totalExpenses;
        const grandShown = t.netGuideFee + expShown;
        return (
          <section className="panel guide-sum">
            <div className="gs-head">
              <h2>{tour?.name ?? "Your tour"}</h2>
              <div className="gs-when">{sheet.date} · {SLOT_TIMES[sheet.slotIdx] ?? ""}{totalPax ? ` · ${totalPax} pax` : ""}</div>
            </div>
            <div className="gs-grid">
              <div>
                <h3>Your customers ({sheet.bookings.length}){noShowTotal > 0 ? <span style={{ color: "var(--danger)", fontWeight: 700 }}> · {noShowTotal} no-show</span> : null}</h3>
                {ro && !canMarkNoShow && <div style={{ fontSize: 11.5, color: "var(--ink-soft)", margin: "2px 0 6px" }}>{!checkedIn ? "Check in to report no-shows." : "No-show reporting is open for 30 minutes after the tour starts."}</div>}
                {sheet.bookings.length ? (
                  <ol className="gs-cust">
                    {sheet.bookings.map((b, i) => {
                      const P = b.bookedPax ?? 0;
                      const ns = b.noShowPax ?? (b.status === "no-show" ? P : 0); // absent pax on this booking
                      const full = P > 0 && ns >= P, partial = ns > 0 && ns < P;
                      return (
                      <li key={i} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <span style={{ flex: 1, minWidth: 130, textDecoration: full ? "line-through" : "none", color: full ? "var(--danger)" : "inherit" }}><b>{b.name || "—"}</b>{b.bookingNo ? <span className="gs-ref"> · {b.bookingNo}</span> : ""}{(b.actualPax ?? b.bookedPax) != null ? <span className="gs-ref"> · {partial ? `${P - ns} of ${P}` : (b.actualPax ?? b.bookedPax)} pax</span> : ""}</span>
                        {b.tickets && <span style={{ fontSize: 11, fontWeight: 700, color: b.tickets === "included" ? "#2e7d4f" : "var(--ink-soft)", whiteSpace: "nowrap" }} title="Set by the operator">{b.tickets === "included" ? "Tickets incl." : "No tickets"}</span>}
                        {canMarkNoShow ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: ns > 0 ? "var(--danger)" : "var(--ink-soft)", cursor: b.bookingNo ? "pointer" : "default" }} title={b.bookingNo ? "Mark this booking as a no-show" : "No reference to mark"}>
                              <input type="checkbox" checked={ns > 0} disabled={!b.bookingNo} onChange={(e) => markNoShow(i, b, e.target.checked ? P : 0)} style={{ width: 17, height: 17, accentColor: "var(--danger)" }} />
                              No-show
                            </label>
                            {P > 1 && b.bookingNo && (
                              <span style={{ fontSize: 11.5, color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 4 }} title="How many of this booking actually came">
                                came
                                <input type="number" min={0} max={P} value={P - ns} onChange={(e) => markNoShow(i, b, P - Math.max(0, Math.min(P, Number(e.target.value) || 0)))} style={{ width: 44, padding: "3px 5px", border: "1px solid var(--line-strong)", borderRadius: 6, font: "inherit", fontSize: 11.5, textAlign: "right" }} />
                                / {P}
                              </span>
                            )}
                          </span>
                        ) : (full ? <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--danger)", whiteSpace: "nowrap" }}>✗ No-show</span> : partial ? <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--danger)", whiteSpace: "nowrap" }}>✗ {ns} of {P} no-show</span> : null)}
                      </li>
                      );
                    })}
                  </ol>
                ) : <div className="gs-empty">No customer list yet.</div>}
              </div>
              <div>
                <h3>Payout</h3>
                {!canReport && (exp.length ? (
                  <ul className="gs-exp">
                    {exp.map((e, i) => (
                      <li key={i}>
                        <span>{e.description}<br /><small className="gs-calc">{thb(e.price ?? 0)} × {e.pax ?? 0} pax (incl. guide)</small></span>
                        <b>{thb(expenseAmount(e))}</b>
                      </li>
                    ))}
                    <li className="gs-total"><span>Total expenses</span><b>{thb(t.totalExpenses)}</b></li>
                  </ul>
                ) : <div className="gs-empty">No expenses recorded.</div>)}
                <div className="gs-payout">
                  <div className="gs-payout-row"><span>Expenses{canReport ? " (your report)" : " (reimbursed)"}</span><b>{thb(expShown)}</b></div>
                  <div className="gs-payout-row"><span>Guide fee · after {sheet.guideFee.whtPct ?? 3}% WHT</span><b>{thb(t.netGuideFee)}</b></div>
                  <div className="gs-payout-row gs-grand"><span>You&apos;ll receive</span><b>{thb(grandShown)}</b></div>
                </div>
                {canReport && <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 6 }}>Based on the expenses you report below · confirmed by the operator.</div>}
              </div>
            </div>
            {canReport && (
              <div style={{ marginTop: 16, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
                <h3 style={{ margin: "0 0 2px" }}>Report your expenses</h3>
                <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 10 }}>Enter what you actually paid on tour, then submit — the operator cross-checks it against the sheet.</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead><tr style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink-soft)" }}>
                    <th style={{ textAlign: "left", padding: "2px 4px" }}>Description</th><th style={{ width: 72, padding: "2px 4px" }}>Price</th><th style={{ width: 56, padding: "2px 4px" }}>Pax</th><th style={{ width: 84, textAlign: "right", padding: "2px 4px" }}>Amount</th><th style={{ width: 24 }}></th>
                  </tr></thead>
                  <tbody>
                    {guideExp.map((e, i) => (
                      <tr key={i}>
                        <td style={{ padding: "3px 4px" }}><input style={L} value={e.description} placeholder="e.g. Grand Palace ticket" onChange={(ev) => setGExp(i, { description: ev.target.value })} /></td>
                        <td style={{ padding: "3px 4px" }}><input style={{ ...L, textAlign: "right" }} type="number" value={e.price ?? ""} onChange={(ev) => setGExp(i, { price: numOrNull(ev.target.value) })} /></td>
                        <td style={{ padding: "3px 4px" }}><input style={{ ...L, textAlign: "right" }} type="number" value={e.pax ?? ""} onChange={(ev) => setGExp(i, { pax: numOrNull(ev.target.value) })} /></td>
                        <td style={{ padding: "3px 4px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(expenseAmount(e))}</td>
                        <td style={{ textAlign: "center" }}><button onClick={() => rmGExp(i)} title="Remove" style={{ border: "none", background: "none", color: "var(--ink-soft)", cursor: "pointer", fontSize: 14 }}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr style={{ borderTop: "1.5px solid var(--line)" }}><td colSpan={3} style={{ textAlign: "right", padding: "6px 4px", fontWeight: 700 }}>Total expenses</td><td style={{ textAlign: "right", padding: "6px 4px", fontWeight: 800, color: "var(--primary)" }}>{thb(guideExpTotal)}</td><td></td></tr></tfoot>
                </table>
                <div style={{ marginTop: 10 }}>
                  <label style={{ fontSize: 11, color: "var(--ink-soft)", fontWeight: 600 }}>Note (optional)</label>
                  <textarea value={guideNote} maxLength={500} onChange={(e) => setGuideNote(e.target.value)} placeholder="e.g. bought extra water — very hot day" rows={2} style={{ width: "100%", boxSizing: "border-box", marginTop: 3, padding: "6px 8px", border: "1px solid var(--line,#d9d9d9)", borderRadius: 6, font: "inherit", fontSize: 13, resize: "vertical" }} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={addGExp}>+ Add expense</button>
                  <button className="btn primary" disabled={expBusy} onClick={submitGuideExpenses} style={{ marginLeft: "auto" }}>{expBusy ? "Sending…" : "Submit expenses to operator"}</button>
                </div>
                {sheet.guideExpensesAt && <div style={{ fontSize: 11, color: "var(--ink-soft)", marginTop: 8 }}>✓ Last sent {new Date(sheet.guideExpensesAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</div>}
              </div>
            )}
            <div style={{ marginTop: 14, textAlign: "center" }}>
              <button className="btn" onClick={() => setShowFull((s) => !s)}>{showFull ? "Hide full details" : "📄 See full details"}</button>
            </div>
          </section>
        );
      })()}

      {(canEdit || showFull) && (
      <section className="panel js-sheet" style={{ padding: 18 }}>
       <fieldset disabled={ro} style={{ border: 0, margin: 0, padding: 0, minInlineSize: "auto" }}>
        {/* Header */}
        <div className="js-head">
          <div className="js-brand"><b>FOLKPATHS</b><div style={{ fontSize: 12, color: "var(--ink-soft,#888)" }}>บริษัท โฟล์คพาธส์ จำกัด</div></div>
          <table className="js-meta"><tbody>
            <tr><td>No.</td><td>{sheet.ref ?? <span style={{ color: "#aaa" }}>—</span>}</td></tr>
            <tr><td>Updated</td><td>{sheet.updatedAt ? new Date(sheet.updatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : <i style={{ color: "#aaa" }}>not saved yet</i>}</td></tr>
            <tr><td>Tour ID</td><td><b>{sheet.tourId || "—"}</b></td></tr>
            <tr><td>Guide ID</td><td>{sheet.guideId}</td></tr>
            <tr><td>Status</td><td>
              <select value={sheet.status} onChange={(e) => up({ status: e.target.value })} className="no-print-border">
                {/* include the live status (e.g. "Review: no-show", set by a guide's report) so it
                    renders instead of a blank box and is never lost when the operator saves */}
                {Array.from(new Set(["Confirmed", "Pending", "Cancelled", sheet.status])).map((s) => <option key={s}>{s}</option>)}
              </select>
              <span className="print-only">{sheet.status}</span>
            </td></tr>
          </tbody></table>
        </div>

        {/* Guide / tour block (auto-filled from profile) */}
        <div className="js-guide">
          <div><span>Tour Date</span><b>{date}</b></div>
          <div><span>Time</span><b style={{ color: "#1b4ef0" }}>{SLOT_TIMES[sheet.slotIdx] ?? tour?.time ?? ""}</b></div>
          <div><span>Tour Name</span><b style={{ color: "#1b4ef0" }}>{tour?.name || ""}</b></div>
          <div><span>Guide name</span>{header?.name || ""}</div>
          <div><span>Tax ID</span>{header?.taxId || "—"}</div>
          <div><span>Address</span>{header?.address || "—"}</div>
          <div><span>E-mail</span>{header?.email || ""}</div>
          <div><span>Tel no.</span>{header?.tel || "—"}</div>
        </div>

        {/* Job details */}
        <h3 className="js-section">Job Details</h3>
        <table className="js-table">
          <thead><tr><th>No.</th><th>Name lists</th><th>Booking No.</th><th>Booked Pax</th><th>Actual Pax</th><th>Tickets</th><th className="no-print" /></tr></thead>
          <tbody>
            {sheet.bookings.map((b, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td><input style={L} value={b.name} onChange={(e) => setBooking(i, { name: e.target.value })} /></td>
                <td><input style={L} value={b.bookingNo} onChange={(e) => setBooking(i, { bookingNo: e.target.value })} /></td>
                <td><input style={{ ...L, width: 70 }} type="number" value={b.bookedPax ?? ""} onChange={(e) => setBooking(i, { bookedPax: numOrNull(e.target.value) })} /></td>
                <td><input style={{ ...L, width: 70 }} type="number" value={b.actualPax ?? ""} onChange={(e) => setBooking(i, { actualPax: numOrNull(e.target.value) })} /></td>
                <td>
                  <select style={L} value={b.tickets} onChange={(e) => setBooking(i, { tickets: e.target.value as Booking["tickets"] })}>
                    <option value="">—</option><option value="included">Included</option><option value="not">Not incl.</option>
                  </select>
                </td>
                <td className="no-print"><button className="btn sm danger" onClick={() => up({ bookings: sheet.bookings.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
            <tr className="js-total"><td /><td colSpan={2} style={{ textAlign: "right" }}>Total</td><td>{sum("bookedPax")}</td><td>{sum("actualPax")}</td><td /><td className="no-print" /></tr>
            {noShowTotal > 0 && <tr className="js-total"><td /><td colSpan={2} style={{ textAlign: "right", color: "var(--danger)" }}>No-shows</td><td colSpan={2} style={{ color: "var(--danger)", fontWeight: 700 }}>{noShowTotal} pax</td><td /><td className="no-print" /></tr>}
          </tbody>
        </table>
        <button className="btn sm no-print" onClick={() => up({ bookings: [...sheet.bookings, { name: "", bookingNo: "", bookedPax: null, actualPax: null, tickets: "", status: "" }] })}>+ Add booking</button>

        {/* Expenses */}
        <h3 className="js-section" style={{ background: "#fff8c4" }}>Expense</h3>
        <table className="js-table">
          <thead><tr><th>Description</th><th>Price</th><th></th><th>Pax</th><th>Amount</th><th className="no-print" /></tr></thead>
          <tbody>
            {sheet.expenses.map((e, i) => (
              <tr key={i}>
                <td><input style={L} value={e.description} onChange={(ev) => setExpense(i, { description: ev.target.value })} /></td>
                <td><input style={{ ...L, width: 90 }} type="number" value={e.price ?? ""} onChange={(ev) => setExpense(i, { price: numOrNull(ev.target.value) })} /></td>
                <td style={{ textAlign: "center" }}>×</td>
                <td><input style={{ ...L, width: 70 }} type="number" value={e.pax ?? ""} onChange={(ev) => setExpense(i, { pax: numOrNull(ev.target.value) })} /></td>
                <td style={{ textAlign: "right" }}>{thb(expenseAmount(e))}</td>
                <td className="no-print"><button className="btn sm danger" onClick={() => up({ expenses: sheet.expenses.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
            <tr className="js-total"><td colSpan={4} style={{ textAlign: "right" }}>Total Expenses</td><td style={{ textAlign: "right" }}><b>{thb(t.totalExpenses)}</b></td><td className="no-print" /></tr>
          </tbody>
        </table>
        <button className="btn sm no-print" onClick={() => up({ expenses: [...sheet.expenses, { description: "", price: null, pax: null }] })}>+ Add expense</button>

        {/* Guide-reported expenses — cross-check (operator only) */}
        {canEdit && sheet.guideExpenses && sheet.guideExpenses.length > 0 && (() => {
          const opTot = sheet.expenses.reduce((s, e) => s + expenseAmount(e), 0);
          const gdTot = sheet.guideExpenses!.reduce((s, e) => s + expenseAmount(e), 0);
          return (
            <div className="no-print" style={{ marginTop: 18, border: "1px solid #ecd9bf", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: "#fff8c4", padding: "7px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b style={{ fontSize: 13 }}>Guide-reported expenses · cross-check</b>
                <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{sheet.guideExpensesAt ? `reported ${new Date(sheet.guideExpensesAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</span>
              </div>
              {sheet.guideExpensesNote && <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--ink)", background: "#fffdf4", borderBottom: "1px solid #f0e6cf" }}><b style={{ color: "var(--ink-soft)", fontWeight: 600 }}>Guide note: </b>{sheet.guideExpensesNote}</div>}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ background: "#f4f4f4", fontSize: 10.5, textTransform: "uppercase", color: "var(--ink-soft)" }}>
                  <th style={{ textAlign: "left", padding: "5px 10px" }}>Description</th><th style={{ textAlign: "right", padding: "5px 10px" }}>Operator</th><th style={{ textAlign: "right", padding: "5px 10px", color: "var(--primary)" }}>Guide</th><th style={{ textAlign: "right", padding: "5px 10px" }}>Check</th>
                </tr></thead>
                <tbody>
                  {crossRows.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #eee", background: r.flag === "differ" ? "#fdf3e7" : r.flag === "added" ? "#eef4ec" : undefined }}>
                      <td style={{ padding: "5px 10px" }}>{r.desc}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.oa == null ? "—" : thb(r.oa)}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: r.flag === "differ" || r.flag === "added" ? 700 : 400, color: r.flag === "differ" ? "#b45309" : r.flag === "added" ? "#2e7d4f" : "inherit" }}>{r.ga == null ? "—" : thb(r.ga)}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", fontWeight: 700, color: r.flag === "match" ? "#2e7d4f" : r.flag === "differ" ? "#b45309" : r.flag === "added" ? "#2e7d4f" : "var(--ink-soft)" }}>{r.flag === "match" ? "✓" : r.flag === "differ" ? "⚠ differs" : r.flag === "added" ? "+ added" : "operator only"}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "2px solid #ddd", background: "#fafafa", fontWeight: 800 }}>
                    <td style={{ padding: "6px 10px" }}>Total</td>
                    <td style={{ padding: "6px 10px", textAlign: "right" }}>{thb(opTot)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--primary)" }}>{thb(gdTot)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", color: Math.round(opTot) === Math.round(gdTot) ? "#2e7d4f" : "#b45309" }}>{Math.round(opTot) === Math.round(gdTot) ? "✓" : `Δ ${thb(Math.abs(gdTot - opTot))}`}</td>
                  </tr>
                </tbody>
              </table>
              <div style={{ padding: "10px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn sm primary" disabled={busy} onClick={acceptGuideExpenses}>{busy ? "Saving…" : "Accept guide’s figures"}</button>
                <span style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>sets the official expenses to the guide’s reported figures and saves — in one click</span>
              </div>
            </div>
          );
        })()}

        {/* Guide fee */}
        <h3 className="js-section" style={{ background: "#f4d9c4" }}>Guide</h3>
        <table className="js-table">
          <thead><tr><th>Description</th><th>Price</th><th></th><th>Time</th><th>WHT %</th><th>WHT</th><th>Net</th></tr></thead>
          <tbody>
            <tr>
              <td>Guide Fee</td>
              <td><input style={{ ...L, width: 100 }} type="number" value={sheet.guideFee.price ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, price: numOrNull(e.target.value) } })} /></td>
              <td style={{ textAlign: "center" }}>×</td>
              <td><input style={{ ...L, width: 60 }} type="number" value={sheet.guideFee.time ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, time: numOrNull(e.target.value) } })} /></td>
              <td><input style={{ ...L, width: 60 }} type="number" value={sheet.guideFee.whtPct ?? ""} onChange={(e) => up({ guideFee: { ...sheet.guideFee, whtPct: numOrNull(e.target.value) } })} /></td>
              <td style={{ textAlign: "right" }}>{thb(t.wht)}</td>
              <td style={{ textAlign: "right" }}><b>{thb(t.netGuideFee)}</b></td>
            </tr>
          </tbody>
        </table>

        {/* Summary */}
        <div className="js-summary">
          <div><span>Total Expenses</span><b>{thb(t.totalExpenses)}</b></div>
          <div><span>Net Guide Fee</span><b>{thb(t.netGuideFee)}</b></div>
          <div className="grand"><span>Total</span><b>{thb(t.grandTotal)}</b></div>
        </div>
       </fieldset>
      </section>
      )}
    </div>
  );
}
