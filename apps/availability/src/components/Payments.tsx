"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { thb } from "@/lib/jobsheet";
import { SLOTS } from "@/lib/slots";

type Job = { date: string; slotIdx: number; tour: string; amount: number; paid: boolean; payStatus: string; peakRef?: string | null; paidAt?: string | null; eslipUrl?: string | null; fee: number; expenses: number };
type Row = { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; status: string; paidAt: string | null; eslipUrl?: string | null; peakRef?: string | null; jobs: Job[] };
type Totals = { tours: number; netFee: number; expenses: number; payout: number };
type Bonus = { id: string; guideId: string; guide: string; amount: number; reason: string; ref: string; eslipUrl: string | null };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Payments({ canEdit = true }: { canEdit?: boolean }) {
  const [period, setPeriod] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ tours: 0, netFee: 0, expenses: 0, payout: 0 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [hideSec, setHideSec] = useState<Set<string>>(new Set());
  const toggleSec = (s: string) => setHideSec((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "paid">("all");
  const [q, setQ] = useState(""); // filter by guide id / name
  const [bonuses, setBonuses] = useState<{ rows: Bonus[]; total: number }>({ rows: [], total: 0 });
  const [bForm, setBForm] = useState({ guideId: "", amount: "", reason: "" });
  // Draft PEAK ref typed against a still-pending guide (keyed by guideId) — shown on
  // the row so the operator can record it before paying the guide's jobs together.
  const [payRef, setPayRef] = useState<Record<string, string>>({});
  const toggle = (gid: string) => setOpen((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  // Mark a single tour paid/unpaid (per-tour TourPayment via the /pay endpoint).
  async function setJobPaid(j: Job, guideId: string, status: "PAID" | "PENDING", peakRef?: string) {
    const r = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: j.date, slotIdx: j.slotIdx, status, ...(peakRef ? { peakRef } : {}) }) });
    if (r.ok) load(period);
  }
  // Pay several tours in ONE transfer with ONE PEAK ref — each tour carries that ref.
  // Uses the ref already typed on the row when present; otherwise prompts for it.
  async function payBatch(guideId: string, jobs: Job[]) {
    if (!jobs.length) return;
    const typed = (payRef[guideId] ?? "").trim();
    // A single pending job doesn't need a combined PEAK ref — pay it straight
    // through. Only the multi-job batch asks for one ref to tag them all.
    let ref: string | null = typed;
    if (!typed && jobs.length > 1) { ref = prompt(`PEAK ref for this payment (covers ${jobs.length} jobs):`, "EXP-"); if (ref === null) return; }
    const r = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, status: "PAID", peakRef: (ref ?? "").trim() || undefined, jobs: jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) }) });
    if (r.ok) { setPayRef((p) => { const n = { ...p }; delete n[guideId]; return n; }); load(period); }
  }
  // Remove a single uploaded job sheet + its tour records (operators only).
  async function removeJob(j: Job, guideId: string, guide: string) {
    if (!confirm(`Remove this job sheet?\n${guide} · ${dShort(j.date)} ${SLOTS[j.slotIdx]?.start} · ${j.tour}\n\nDeletes the job sheet, assignment, payment and any check-in/report for this tour. Cannot be undone.`)) return;
    const r = await fetch("/api/jobsheet", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: j.date, slotIdx: j.slotIdx }) });
    if (r.ok) load(period);
  }
  // Save the PEAK accounting ref (EXP-…) for a guide's combined monthly payout.
  async function savePeakRef(guideId: string, peakRef: string) {
    await fetch("/api/payments", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId, peakRef }) });
    load(period);
  }

  const load = useCallback(async (p?: string) => {
    const r = await fetch(`/api/payments${p ? `?period=${p}` : ""}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setPeriod(d.period); setRows(d.rows ?? []); setTotals(d.totals); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadBonuses = useCallback(async (p: string) => {
    if (!p) return;
    const r = await fetch(`/api/payments/bonus?period=${p}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setBonuses({ rows: d.rows ?? [], total: d.total ?? 0 }); }
  }, []);
  useEffect(() => { loadBonuses(period); }, [period, loadBonuses]);

  async function addBonus() {
    const amt = parseFloat(bForm.amount);
    if (!bForm.guideId || !(amt > 0)) return;
    const r = await fetch("/api/payments/bonus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId: bForm.guideId, amount: amt, reason: bForm.reason }) });
    if (r.ok) { setBForm({ guideId: "", amount: "", reason: "" }); loadBonuses(period); }
  }
  async function delBonus(id: string) {
    const r = await fetch("/api/payments/bonus", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    if (r.ok) loadBonuses(period);
  }
  async function uploadBonusEslip(bonusId: string, file: File) {
    const fd = new FormData(); fd.append("bonusId", bonusId); fd.append("file", file);
    const r = await fetch("/api/payments/bonus/eslip", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) loadBonuses(period); else alert(d.hint || d.detail || `E-slip upload failed (${r.status}).`);
  }
  async function editBonusRef(id: string, ref: string) {
    await fetch("/api/payments/bonus", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ref }) });
    loadBonuses(period);
  }

  async function mark(guideId: string, status: "pending" | "paid") {
    const r = await fetch("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId, status }) });
    if (r.ok) load(period);
  }
  // Upload a bank payment slip (e-slip) for a guide's month. The slip IS proof of
  // payment, so the backend flips the month — and all its tours — to PAID on upload.
  async function uploadEslip(guideId: string, file: File) {
    const fd = new FormData(); fd.append("period", period); fd.append("guideId", guideId); fd.append("file", file);
    const r = await fetch("/api/payments/eslip", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) load(period); else alert(d.hint || d.detail || `E-slip upload failed (${r.status}).`);
  }
  // Upload ONE slip that covers one or several tours paid in a single transfer
  // (the "merged payment"). Marks each listed tour paid + tags it with the slip.
  async function uploadTourSlip(guideId: string, jobs: Job[], file: File) {
    if (!jobs.length) return;
    const fd = new FormData();
    fd.append("guideId", guideId);
    fd.append("jobs", JSON.stringify(jobs.map((j) => ({ date: j.date, slotIdx: j.slotIdx }))));
    const ref = (payRef[guideId] ?? "").trim(); if (ref) fd.append("peakRef", ref);
    fd.append("file", file);
    const r = await fetch("/api/pay/eslip", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setPayRef((p) => { const n = { ...p }; delete n[guideId]; return n; }); load(period); }
    else alert(d.hint || d.detail || `Slip upload failed (${r.status}).`);
  }
  async function removeRow(guideId: string, guide: string) {
    if (!confirm(`Delete ${guide}'s entire pay for ${period}?\nThis permanently removes ALL their tours that month — assignments, job sheets, check-ins, reports and payments. Cannot be undone.`)) return;
    const r = await fetch("/api/payments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId }) });
    if (r.ok) load(period);
  }

  function exportCsv() {
    const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    // Per-JOB rows so each tour reconciles to the PEAK ref of the transfer that paid it.
    const head = ["Guide ID", "Guide", "Date", "Tour", "Amount", "Paid", "PEAK ref"];
    const lines = [head.join(",")].concat(
      rows.flatMap((r) => r.jobs.map((j) => [r.guideId, r.guide, j.date, j.tour, j.amount, j.paid ? "PAID" : "PENDING", j.peakRef ?? r.peakRef ?? ""].map(cell).join(",")))
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `folkpaths-payroll-${period}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Print-ready PDF of everything still owed (unpaid jobs), grouped by guide.
  // Same no-dependency approach as the job sheet: open an HTML doc and let the
  // browser "Save as PDF". Thai tour names render natively.
  function exportPendingPdf() {
    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
    const guides = rows
      .map((r) => ({ ...r, ujobs: r.jobs.filter((j) => !j.paid) }))
      .filter((r) => r.ujobs.length > 0)
      .sort((a, b) => a.guideId.localeCompare(b.guideId));
    if (guides.length === 0) { alert("No pending jobs to export — everyone is paid for this period."); return; }
    const grand = guides.reduce((s, r) => s + r.ujobs.reduce((a, j) => a + j.amount, 0), 0);
    const jobCount = guides.reduce((s, r) => s + r.ujobs.length, 0);
    const genDate = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const sections = guides.map((r) => {
      const sub = r.ujobs.reduce((a, j) => a + j.amount, 0);
      const ref = (payRef[r.guideId] ?? "").trim();
      const body = r.ujobs.map((j) => `<tr><td>${esc(dShort(j.date))} · ${esc(SLOTS[j.slotIdx]?.start ?? "")}</td><td>${esc(j.tour)}</td><td class="r">${esc(thb(j.fee))}</td><td class="r">${esc(thb(j.expenses))}</td><td class="r b">${esc(thb(j.amount))}</td></tr>`).join("");
      return `<section><h2><span class="gid">${esc(r.guideId)}</span> ${esc(r.guide)}${ref ? `<span class="ref">PEAK ref: ${esc(ref)}</span>` : ""}</h2>
        <table><thead><tr><th>Date</th><th>Tour</th><th class="r">Guide fee</th><th class="r">Expenses</th><th class="r">Amount</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td colspan="4" class="r b">Subtotal · ${r.ujobs.length} job${r.ujobs.length === 1 ? "" : "s"}</td><td class="r b">${esc(thb(sub))}</td></tr></tfoot></table></section>`;
    }).join("");
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Folkpaths pending payments ${esc(period)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Helvetica Neue",Arial,"Noto Sans Thai",sans-serif;color:#2a2520;padding:28px 30px;font-size:13px}
  .toolbar{position:sticky;top:0;background:#7e3a2c;color:#fff;display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-radius:9px;margin-bottom:22px}
  .toolbar button{background:#fff;color:#7e3a2c;border:none;border-radius:7px;padding:8px 14px;font-weight:700;font-size:13px;cursor:pointer}
  h1{font-size:21px;font-weight:800}
  .meta{color:#6f665b;font-size:12.5px;margin:3px 0 18px}
  .summary{background:#fbf4e8;border:1px solid #ecd9bf;border-radius:10px;padding:12px 16px;margin-bottom:22px;display:flex;justify-content:space-between;font-weight:700}
  .summary .tot{color:#7e3a2c;font-size:17px}
  section{margin-bottom:20px;break-inside:avoid}
  h2{font-size:15px;font-weight:800;margin-bottom:7px;padding-bottom:5px;border-bottom:2px solid #ecd9bf;display:flex;align-items:baseline;gap:8px}
  h2 .gid{color:#7e3a2c;font-family:monospace}
  h2 .ref{margin-left:auto;font-size:11.5px;color:#6f665b;font-weight:600}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;font-size:12.5px}
  th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#6f665b}
  .r{text-align:right}.b{font-weight:700}
  tfoot td{border-top:2px solid #ddd;border-bottom:none;padding-top:8px}
  @media print{.toolbar{display:none}body{padding:0}}
</style></head>
<body>
  <div class="toolbar"><span>Pending payments · ${esc(period)}</span><button onclick="window.print()">Save as PDF / Print</button></div>
  <h1>Folkpaths — Pending payments</h1>
  <div class="meta">${esc(period)} · generated ${esc(genDate)}</div>
  <div class="summary"><span>${jobCount} pending job${jobCount === 1 ? "" : "s"} · ${guides.length} guide${guides.length === 1 ? "" : "s"}</span><span class="tot">Total owed: ${esc(thb(grand))}</span></div>
  ${sections}
  <script>window.onload=function(){setTimeout(function(){window.print();},350);};</script>
</body></html>`;
    const w = window.open("", "_blank");
    if (!w) { alert("Please allow pop-ups to export the PDF."); return; }
    w.document.write(html); w.document.close();
  }

  const ql = q.trim().toLowerCase();
  // Guides with unpaid jobs float to the top so the operator sees who's still owed.
  const visible = rows
    .filter((r) => (statusFilter === "all" || r.status === statusFilter) && (!ql || `${r.guideId} ${r.guide}`.toLowerCase().includes(ql)))
    .sort((a, b) => a.guide.localeCompare(b.guide));
  // Split BY TOUR: a guide appears under Unpaid for their unpaid tours and under Paid
  // for their paid tours — so a single tour moves to Paid the moment it's paid.
  const unpaidGuides = visible.filter((r) => r.jobs.some((j) => !j.paid));
  const paidGuides = visible.filter((r) => r.jobs.some((j) => j.paid));
  const sumBy = (jobs: Job[], k: "amount" | "fee" | "expenses") => jobs.reduce((s, j) => s + (j[k] ?? 0), 0);

  function renderGuideRow(r: Row, jobs: Job[], mode: "unpaid" | "paid") {
    const okey = `${mode}|${r.guideId}`;
    const isOpen = open.has(okey);
    const refs = [...new Set(jobs.map((j) => j.peakRef).filter(Boolean))];
    return (
      <Fragment key={okey}>
        <tr style={{ cursor: "pointer", background: mode === "unpaid" ? "#fbf4e8" : undefined }} onClick={() => toggle(okey)}>
          <td><span style={{ color: "var(--ink-soft)", marginRight: 4 }}>{isOpen ? "▾" : "▸"}</span><span className="gid">{r.guideId}</span> {r.guide}</td>
          <td className="r">{jobs.length}</td>
          <td className="r">{thb(sumBy(jobs, "fee"))}</td>
          <td className="r">{thb(sumBy(jobs, "expenses"))}</td>
          <td className="r"><b>{thb(sumBy(jobs, "amount"))}</b></td>
          <td style={{ fontSize: 11.5, fontWeight: 700, color: "var(--primary)", fontVariantNumeric: "tabular-nums" }} onClick={(e) => e.stopPropagation()}>
            {mode === "unpaid" && canEdit && jobs.length > 1
              ? <input className="peak-ref-in" value={payRef[r.guideId] ?? ""} placeholder="EXP-…" title={`PEAK ref for paying ${jobs.length} jobs together`} onChange={(e) => setPayRef((p) => ({ ...p, [r.guideId]: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter" && (payRef[r.guideId] ?? "").trim()) payBatch(r.guideId, jobs); }} />
              : refs.join(", ")}
          </td>
          <td><span className={`badge ${mode === "paid" ? "active" : "invited"}`}>{mode === "paid" ? "Paid" : "Pending"}</span></td>
          <td style={{ display: "flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
            {mode === "paid" && r.eslipUrl && <a className="btn sm" href={r.eslipUrl} target="_blank" rel="noopener noreferrer" title="View payment slip in Drive">E-slip</a>}
            {mode === "paid" && r.paidAt && <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>{new Date(r.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
            {mode === "unpaid" && canEdit && jobs.length > 0 && <button className="btn sm primary" title={`Pay ${jobs.length} job${jobs.length === 1 ? "" : "s"} together and tag them with the PEAK ref`} onClick={() => payBatch(r.guideId, jobs)}>Pay {jobs.length}</button>}
            {mode === "unpaid" && canEdit && <label className="btn sm" style={{ cursor: "pointer" }} title="Upload payment slip — marks this guide's month paid">Slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadEslip(r.guideId, f); e.target.value = ""; }} /></label>}
            {mode === "paid" && canEdit && <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Replace the uploaded slip">Replace slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadEslip(r.guideId, f); e.target.value = ""; }} /></label>}
          </td>
        </tr>
        {isOpen && (
          <tr className="pay-jobs-row"><td colSpan={8} style={{ background: "var(--grey-bg)", padding: "6px 12px" }}>
            {mode === "unpaid" && canEdit && jobs.length > 0 && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "2px 0 8px" }}>
              <button className="btn sm primary" title="Mark these jobs paid in one transfer and tag them all with one PEAK ref" onClick={() => payBatch(r.guideId, jobs)}>Pay {jobs.length} job{jobs.length === 1 ? "" : "s"} together · one ref</button>
              <label className="btn sm" style={{ cursor: "pointer" }} title="Upload ONE bank slip that covers all these jobs (one transfer) — marks them paid and saves the slip to Drive">📎 Slip · covers {jobs.length}<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTourSlip(r.guideId, jobs, f); e.target.value = ""; }} /></label>
              <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>or use the per-tour Slip below for separate transfers</span>
            </div>}
            {jobs.map((j, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderTop: i ? "1px solid var(--line)" : "none", fontSize: 13 }}>
                <span style={{ minWidth: 150 }}>{dShort(j.date)} · {SLOTS[j.slotIdx]?.start}</span>
                <span style={{ flex: 1 }}>{j.tour}</span>
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 80, textAlign: "right" }}>{thb(j.amount)}</span>
                {j.peakRef && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--primary)", fontVariantNumeric: "tabular-nums" }} title="PEAK ref for this payment">{j.peakRef}</span>}
                <span className={`badge ${j.paid ? "active" : "invited"}`} style={{ minWidth: 64, textAlign: "center" }}>{j.paid ? "Paid" : "Pending"}</span>{j.paid && j.paidAt ? <span style={{ fontSize: 11, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{new Date(j.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span> : null}
                <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(r.guideId)}&date=${j.date}&slotIdx=${j.slotIdx}`} title="Open this tour's job sheet">Job sheet</a>
                {j.paid && j.eslipUrl && <a className="btn sm" href={j.eslipUrl} target="_blank" rel="noopener noreferrer" title="View this tour's payment slip in Drive">E-slip</a>}
                {canEdit && !j.paid && <label className="btn sm" style={{ cursor: "pointer" }} title="Upload the bank slip for THIS tour (separate transfer) — marks just this tour paid and saves the slip to Drive">📎 Slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadTourSlip(r.guideId, [j], f); e.target.value = ""; }} /></label>}
                {canEdit && (j.paid
                  ? <button className="btn sm ghost" onClick={() => setJobPaid(j, r.guideId, "PENDING")}>Undo</button>
                  : <button className="btn sm primary" title="Mark this one job paid (you can add its PEAK ref)" onClick={() => { const ref = prompt("PEAK ref for this payment (optional):", "EXP-"); if (ref !== null) setJobPaid(j, r.guideId, "PAID", ref.trim() || undefined); }}>Mark paid</button>)}
                {canEdit && <button className="btn sm danger" title="Remove this job sheet + its tour records" onClick={() => removeJob(j, r.guideId, r.guide)}>Delete</button>}
              </div>
            ))}
          </td></tr>
        )}
      </Fragment>
    );
  }
  const vTotals = visible.reduce((a, r) => ({ tours: a.tours + r.tours, netFee: a.netFee + r.netFee, expenses: a.expenses + r.expenses, payout: a.payout + r.payout }), { tours: 0, netFee: 0, expenses: 0, payout: 0 });
  // Month-overview figures for the dashboard band (whole month, not the filtered view).
  const allJobs = rows.flatMap((r) => r.jobs);
  const paidAmt = allJobs.filter((j) => j.paid).reduce((sum, j) => sum + (j.amount || 0), 0);
  const unpaidJobs = allJobs.filter((j) => !j.paid);
  const outstanding = unpaidJobs.reduce((sum, j) => sum + (j.amount || 0), 0);
  const paidFrac = totals.payout > 0 ? paidAmt / totals.payout : 0;
  const DC = 2 * Math.PI * 42; // donut circumference (r=42)

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Payments</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      <section className="panel" style={{ marginBottom: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 12, padding: 14 }}>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800 }}>{thb(totals.payout)}</div><div className="pay-kpi-l">Total payout</div></div>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800, color: "var(--green)" }}>{thb(paidAmt)}</div><div className="pay-kpi-l">Paid</div></div>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800, color: outstanding > 0 ? "#b45309" : "var(--ink-soft)" }}>{thb(outstanding)}</div><div className="pay-kpi-l">Pending{unpaidJobs.length ? ` · ${unpaidJobs.length} job${unpaidJobs.length === 1 ? "" : "s"}` : ""}</div></div>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800 }}>{rows.length}</div><div className="pay-kpi-l">Guides</div></div>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800 }}>{totals.tours}</div><div className="pay-kpi-l">Job sheets</div></div>
          <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800 }}>{thb(totals.expenses)}</div><div className="pay-kpi-l">Expenses</div></div>
          {bonuses.total > 0 && <div className="pay-kpi"><div style={{ fontSize: 21, fontWeight: 800 }}>{thb(bonuses.total)}</div><div className="pay-kpi-l">Bonuses</div></div>}
        </div>
        {rows.length > 0 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 30, flexWrap: "wrap", padding: "4px 16px 18px", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <svg viewBox="0 0 100 100" width="150" height="150" role="img" aria-label="Paid vs pending">
                <circle cx="50" cy="50" r="42" fill="none" stroke="#e8b06b" strokeWidth="15" />
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--green, #1a7f37)" strokeWidth="15" strokeLinecap="round" strokeDasharray={`${paidFrac * DC} ${DC}`} transform="rotate(-90 50 50)" />
                <text x="50" y="49" textAnchor="middle" fontSize="17" fontWeight="800" fill="var(--ink, #222)">{Math.round(paidFrac * 100)}%</text>
                <text x="50" y="63" textAnchor="middle" fontSize="8" fill="var(--ink-soft, #888)">paid</text>
              </svg>
              <div style={{ display: "flex", gap: 14, fontSize: 12.5, flexWrap: "wrap", justifyContent: "center" }}>
                <span style={{ color: "var(--ink-soft)" }}><span style={{ color: "var(--green)" }}>●</span> Paid <b style={{ color: "var(--ink)" }}>{thb(paidAmt)}</b></span>
                <span style={{ color: "var(--ink-soft)" }}><span style={{ color: "#e8b06b" }}>●</span> Pending <b style={{ color: "var(--ink)" }}>{thb(outstanding)}</b></span>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Month</label>
          <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} onChange={(e) => { setPeriod(e.target.value); load(e.target.value); }} />
          <select className="search" style={{ flex: "none", width: 150 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "all" | "pending" | "paid")} title="Filter by approval status">
            <option value="all">All statuses</option>
            <option value="pending">Pending only</option>
            <option value="paid">Paid only</option>
          </select>
          <input className="search" style={{ flex: "none", width: 180 }} placeholder="Search guide…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={exportCsv}>Export payroll CSV</button>
          <button className="btn sm" onClick={exportPendingPdf} title="Print-ready list of every unpaid job, grouped by guide — Save as PDF">Export pending PDF</button>
          <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600 }}>Month total: {thb(totals.payout)}</span>
        </div>
        <div className="grid-scroll">
          <table className="acct-table pay-table">
            <thead>
              <tr><th>Guide</th><th className="r">Tours</th><th className="r">Guide fee (net)</th><th className="r">Expenses</th><th className="r">Total payout</th><th>PEAK ref</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={8} className="op-empty">{rows.length === 0 ? "No tours assigned this month yet." : "No guides match this filter."}</td></tr>
              ) : (<>
                {unpaidGuides.length > 0 && <tr><td colSpan={8} onClick={() => toggleSec("unpaid")} style={{ cursor: "pointer", padding: "8px 12px 5px", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#b45309", background: "#fbf4e8" }}>{hideSec.has("unpaid") ? "▸" : "▾"} Unpaid — needs payment ({unpaidGuides.length}) · {thb(unpaidGuides.reduce((s, r) => s + r.jobs.filter((j) => !j.paid).reduce((a, j) => a + j.amount, 0), 0))}</td></tr>}
                {!hideSec.has("unpaid") && unpaidGuides.map((r) => renderGuideRow(r, r.jobs.filter((j) => !j.paid), "unpaid"))}
                {paidGuides.length > 0 && <tr><td colSpan={8} onClick={() => toggleSec("paid")} style={{ cursor: "pointer", padding: "12px 12px 5px", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--green)" }}>{hideSec.has("paid") ? "▸" : "▾"} Paid ({paidGuides.length}) · {thb(paidGuides.reduce((s, r) => s + r.jobs.filter((j) => j.paid).reduce((a, j) => a + j.amount, 0), 0))}</td></tr>}
                {!hideSec.has("paid") && paidGuides.map((r) => renderGuideRow(r, r.jobs.filter((j) => j.paid), "paid"))}
              </>)}
            </tbody>
            {visible.length > 0 && (
              <tfoot>
                <tr className="pay-foot">
                  <td><b>{statusFilter !== "all" || ql ? `Shown (${visible.length} of ${rows.length})` : `Total (${rows.length} guides)`}</b></td>
                  <td className="r">{vTotals.tours}</td>
                  <td className="r">{thb(vTotals.netFee)}</td>
                  <td className="r">{thb(vTotals.expenses)}</td>
                  <td className="r"><b>{thb(vTotals.payout)}</b></td>
                  <td colSpan={3}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head"><h2>Bonuses &amp; adjustments</h2><span className="hint">e.g. 5★ review rewards · {bonuses.rows.length} this month</span></div>
        <div style={{ padding: 14 }}>
          {bonuses.rows.length === 0 ? <div className="op-empty">No bonuses this month.</div> : (
            <table className="acct-table" style={{ marginBottom: 12 }}>
              <thead><tr><th>Guide</th><th>Ref no.</th><th>Reason</th><th className="r">Amount</th><th>E-slip</th><th /></tr></thead>
              <tbody>
                {bonuses.rows.map((b) => (
                  <tr key={b.id}>
                    <td style={{ whiteSpace: "nowrap" }}><span className="gid">{b.guideId}</span> {b.guide}</td>
                    <td><input className="search" style={{ width: 150, fontSize: 12, fontVariantNumeric: "tabular-nums" }} defaultValue={b.ref} disabled={!canEdit} title="Bonus reference no. (e.g. PEAK job no.)" onBlur={(e) => { if (e.target.value.trim() !== b.ref) editBonusRef(b.id, e.target.value.trim()); }} /></td>
                    <td style={{ color: "var(--ink-soft)" }}>{b.reason || "—"}</td>
                    <td className="r" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{thb(b.amount)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {b.eslipUrl
                        ? <span style={{ display: "inline-flex", gap: 6 }}>
                            <a className="btn sm" href={b.eslipUrl} target="_blank" rel="noopener noreferrer" title="View bonus slip in Drive">E-slip</a>
                            {canEdit && <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Replace">Replace<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>}
                          </span>
                        : (canEdit && <label className="btn sm" style={{ cursor: "pointer" }} title="Upload bonus payment slip">Slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>)}
                    </td>
                    <td style={{ textAlign: "right" }}>{canEdit && <button className="btn sm danger" title="Remove bonus" onClick={() => delBonus(b.id)}>×</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="pay-foot"><td colSpan={3}><b>Total bonuses</b></td><td className="r"><b>+{thb(bonuses.total)}</b></td><td colSpan={2} /></tr></tfoot>
            </table>
          )}
          {canEdit && (
          <div className="op-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="search" style={{ flex: "none", width: 200 }} value={bForm.guideId} onChange={(e) => setBForm((x) => ({ ...x, guideId: e.target.value }))}>
              <option value="">Choose guide…</option>
              {rows.map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.guide}</option>)}
            </select>
            <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Reason (e.g. 5★ review – Omari)" value={bForm.reason} onChange={(e) => setBForm((x) => ({ ...x, reason: e.target.value }))} />
            <input className="search" style={{ flex: "none", width: 120 }} type="number" min={0} placeholder="฿ amount" value={bForm.amount} onChange={(e) => setBForm((x) => ({ ...x, amount: e.target.value }))} />
            <button className="btn primary" disabled={!bForm.guideId || !(parseFloat(bForm.amount) > 0)} onClick={addBonus}>+ Add bonus</button>
          </div>
          )}
        </div>
      </section>
    </div>
  );
}
