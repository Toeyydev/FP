"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { computeTotals, expenseAmount, thb, type Booking, type Expense, type GuideFee } from "@/lib/jobsheet";
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

  const load = useCallback(async () => {
    const r = await fetch(`/api/jobsheet?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" });
    if (!r.ok) { setMsg("Could not load this job sheet."); return; }
    const d = await r.json();
    setHeader(d.header); setTour(d.tour); setSheet(d.sheet); setSaved(d.saved); setCanEdit(d.canEdit !== false); setCheckedIn(!!d.checkedIn);
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
  // Guide (or operator) taps a guest's no-show box — persists to the Booking so it
  // shows in the operator's Tour Log; updates the row locally without dirtying the sheet.
  const markNoShow = (i: number, b: Booking, on: boolean) => {
    setSheet((s) => s ? { ...s, bookings: s.bookings.map((x, j) => j === i ? { ...x, status: on ? "no-show" : "" } : x) } : s);
    if (!b.bookingNo) return;
    fetch("/api/jobsheet/noshow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx, bookingNo: b.bookingNo, noShow: on }) }).catch(() => {});
  };
  const setExpense = (i: number, p: Partial<Expense>) => up({ expenses: sheet.expenses.map((e, j) => j === i ? { ...e, ...p } : e) });
  const sum = (key: "bookedPax" | "actualPax") => sheet.bookings.reduce((s, b) => s + (b[key] ?? 0), 0);

  async function save(): Promise<boolean> {
    setBusy(true); setMsg("");
    const r = await fetch("/api/jobsheet", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: sheet!.guideId, date: sheet!.date, slotIdx: sheet!.slotIdx, tourId: sheet!.tourId, status: sheet!.status, bookings: sheet!.bookings, expenses: sheet!.expenses, guideFee: sheet!.guideFee }),
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
          <a className={`btn ${ro ? "primary" : ""}`} target="_blank" rel="noopener noreferrer"
            href={gcalUrl(tour?.name ?? "Tour", sheet.date, sheet.slotIdx, tour?.durationMin || 180, `Guide: ${header?.name ?? ""}\nFolkpath job · open the app for full details`)}>Add to Google Calendar</a>
          {ro && <button className="btn" onClick={() => window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener")} title="Open the full job sheet as a PDF for reference">📄 PDF</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/pdf?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>PDF</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.open(`/api/jobsheet/joborder?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, "_blank", "noopener"); }}>Job order</button>}
          {canEdit && <button className="btn" disabled={busy} onClick={async () => { if (!saved) await save(); window.location.href = `/api/jobsheet/export?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`; }}>Excel</button>}
          {canEdit && drive.enabled && !drive.connected && <a className="btn" href="/api/google/connect" title="Connect a Google account so the PDF can be saved to Drive">☁ Connect Google Drive</a>}
          {canEdit && <button className="btn" disabled={busy} onClick={sendToGuide}>Send to guide</button>}
          {canEdit && <button className="btn primary" disabled={busy} onClick={save}>{busy ? "…" : "Save"}</button>}
        </div>
      </div>

      {ro && (() => {
        const totalPax = sheet.bookings.reduce((s, b) => s + (b.actualPax ?? b.bookedPax ?? 0), 0);
        const exp = sheet.expenses.filter((e) => expenseAmount(e) > 0);
        return (
          <section className="panel guide-sum">
            <div className="gs-head">
              <h2>{tour?.name ?? "Your tour"}</h2>
              <div className="gs-when">📅 {sheet.date} · {SLOT_TIMES[sheet.slotIdx] ?? ""}{totalPax ? ` · 👥 ${totalPax} pax` : ""}</div>
            </div>
            <div className="gs-grid">
              <div>
                <h3>👥 Your customers ({sheet.bookings.length})</h3>
                {ro && !canMarkNoShow && <div style={{ fontSize: 11.5, color: "var(--ink-soft)", margin: "2px 0 6px" }}>{!checkedIn ? "Check in to report no-shows." : "No-show reporting is open for 30 minutes after the tour starts."}</div>}
                {sheet.bookings.length ? (
                  <ol className="gs-cust">
                    {sheet.bookings.map((b, i) => {
                      const ns = b.status === "no-show";
                      return (
                      <li key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ flex: 1, textDecoration: ns ? "line-through" : "none", color: ns ? "var(--danger)" : "inherit" }}><b>{b.name || "—"}</b>{b.bookingNo ? <span className="gs-ref"> · {b.bookingNo}</span> : ""}{(b.actualPax ?? b.bookedPax) != null ? <span className="gs-ref"> · {b.actualPax ?? b.bookedPax} pax</span> : ""}{b.tickets === "included" ? " 🎫 tickets incl." : b.tickets === "not" ? " 🎫 no tickets" : ""}</span>
                        {canMarkNoShow ? (
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 700, color: ns ? "var(--danger)" : "var(--ink-soft)", cursor: b.bookingNo ? "pointer" : "default", whiteSpace: "nowrap" }} title={b.bookingNo ? "Mark this guest as a no-show" : "No reference to mark"}>
                            <input type="checkbox" checked={ns} disabled={!b.bookingNo} onChange={(e) => markNoShow(i, b, e.target.checked)} style={{ width: 17, height: 17, accentColor: "var(--danger)" }} />
                            No-show
                          </label>
                        ) : (ns && <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--danger)", whiteSpace: "nowrap" }}>✗ No-show</span>)}
                      </li>
                      );
                    })}
                  </ol>
                ) : <div className="gs-empty">No customer list yet.</div>}
              </div>
              <div>
                <h3>💵 Expenses</h3>
                {exp.length ? (
                  <ul className="gs-exp">
                    {exp.map((e, i) => (
                      <li key={i}>
                        <span>{e.description}<br /><small className="gs-calc">{thb(e.price ?? 0)} × {e.pax ?? 0} pax (incl. guide)</small></span>
                        <b>{thb(expenseAmount(e))}</b>
                      </li>
                    ))}
                    <li className="gs-total"><span>Total expenses</span><b>{thb(t.totalExpenses)}</b></li>
                  </ul>
                ) : <div className="gs-empty">No expenses recorded.</div>}
                <div className="gs-payout">
                  <div className="gs-payout-row"><span>Expenses (reimbursed)</span><b>{thb(t.totalExpenses)}</b></div>
                  <div className="gs-payout-row"><span>Guide fee · after {sheet.guideFee.whtPct ?? 3}% WHT</span><b>{thb(t.netGuideFee)}</b></div>
                  <div className="gs-payout-row gs-grand"><span>💰 You&apos;ll receive</span><b>{thb(t.grandTotal)}</b></div>
                </div>
              </div>
            </div>
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
                {["Confirmed", "Pending", "Cancelled"].map((s) => <option key={s}>{s}</option>)}
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
