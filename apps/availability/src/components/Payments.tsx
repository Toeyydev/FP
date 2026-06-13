"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { thb } from "@/lib/jobsheet";
import { SLOTS } from "@/lib/slots";

type Job = { date: string; slotIdx: number; tour: string; amount: number; paid: boolean; payStatus: string };
type Row = { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; status: string; paidAt: string | null; eslipUrl?: string | null; jobs: Job[] };
type Totals = { tours: number; netFee: number; expenses: number; payout: number };
type Bonus = { id: string; guideId: string; guide: string; amount: number; reason: string; ref: string; eslipUrl: string | null };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function Payments() {
  const [period, setPeriod] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ tours: 0, netFee: 0, expenses: 0, payout: 0 });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [bonuses, setBonuses] = useState<{ rows: Bonus[]; total: number }>({ rows: [], total: 0 });
  const [bForm, setBForm] = useState({ guideId: "", amount: "", reason: "" });
  const toggle = (gid: string) => setOpen((s) => { const n = new Set(s); n.has(gid) ? n.delete(gid) : n.add(gid); return n; });
  // Mark a single tour paid/unpaid (per-tour TourPayment via the /pay endpoint).
  async function setJobPaid(j: Job, guideId: string, status: "PAID" | "PENDING") {
    const r = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, date: j.date, slotIdx: j.slotIdx, status }) });
    if (r.ok) load(period);
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
  async function removeRow(guideId: string, guide: string) {
    if (!confirm(`Delete ${guide}'s entire pay for ${period}?\nThis permanently removes ALL their tours that month — assignments, job sheets, check-ins, reports and payments. Cannot be undone.`)) return;
    const r = await fetch("/api/payments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, guideId }) });
    if (r.ok) load(period);
  }

  function exportCsv() {
    const cell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ["Guide ID", "Guide", "Tours", "Guide fee (net)", "Expenses", "Total payout", "Status"];
    const lines = [head.join(",")].concat(rows.map((r) => [r.guideId, r.guide, r.tours, r.netFee, r.expenses, r.payout, r.status].map(cell).join(",")));
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `folkpaths-payroll-${period}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">Payments</span></div>
        <div className="nav"><a className="btn sm" href="/dashboard">Dashboard</a><a className="btn sm" href="/bookings">Bookings</a></div>
      </div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Month</label>
          <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} onChange={(e) => { setPeriod(e.target.value); load(e.target.value); }} />
          <button className="btn sm" onClick={exportCsv}>↓ Export payroll CSV</button>
          <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600 }}>Total: {thb(totals.payout)}</span>
        </div>
        <div className="grid-scroll">
          <table className="acct-table pay-table">
            <thead>
              <tr><th>Guide</th><th className="r">Tours</th><th className="r">Guide fee (net)</th><th className="r">Expenses</th><th className="r">Total payout</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="op-empty">No tours assigned this month yet.</td></tr>
              ) : rows.map((r) => {
                const unpaid = r.jobs.filter((j) => !j.paid);
                return (
                <Fragment key={r.guideId}>
                <tr style={{ cursor: "pointer" }} onClick={() => toggle(r.guideId)}>
                  <td><span style={{ color: "var(--ink-soft)", marginRight: 4 }}>{open.has(r.guideId) ? "▾" : "▸"}</span><span className="gid">{r.guideId}</span> {r.guide}</td>
                  <td className="r">{r.tours}{unpaid.length > 0 && <span className="badge invited" style={{ marginLeft: 6 }}>{unpaid.length} unpaid</span>}</td>
                  <td className="r">{thb(r.netFee)}</td>
                  <td className="r">{thb(r.expenses)}</td>
                  <td className="r"><b>{thb(r.payout)}</b></td>
                  <td><span className={`badge ${r.status === "paid" ? "active" : "invited"}`}>{r.status === "paid" ? "Paid" : "Pending"}</span></td>
                  <td style={{ display: "flex", gap: 6, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                    {r.status === "paid"
                    ? <button className="btn sm ghost" onClick={() => mark(r.guideId, "pending")}>Undo</button>
                    : <button className="btn sm primary" onClick={() => mark(r.guideId, "paid")}>Mark paid</button>}
                    <button className="btn sm danger" title="Delete this guide's pay for the month" onClick={() => removeRow(r.guideId, r.guide)}>🗑</button></td>
                </tr>
                {open.has(r.guideId) && (
                  <tr className="pay-jobs-row"><td colSpan={7} style={{ background: "var(--grey-bg)", padding: "6px 12px" }}>
                    {r.jobs.map((j, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderTop: i ? "1px solid var(--line)" : "none", fontSize: 13 }}>
                        <span style={{ minWidth: 150 }}>{dShort(j.date)} · {SLOTS[j.slotIdx]?.start}</span>
                        <span style={{ flex: 1 }}>{j.tour}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 80, textAlign: "right" }}>{thb(j.amount)}</span>
                        <span className={`badge ${j.paid ? "active" : "invited"}`} style={{ minWidth: 64, textAlign: "center" }}>{j.paid ? "Paid" : "Unpaid"}</span>
                        <a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(r.guideId)}&date=${j.date}&slotIdx=${j.slotIdx}`} title="Open this tour's job sheet">📄 Job sheet</a>
                        {j.paid
                          ? <button className="btn sm ghost" onClick={() => setJobPaid(j, r.guideId, "PENDING")}>Undo</button>
                          : <button className="btn sm primary" onClick={() => setJobPaid(j, r.guideId, "PAID")}>Mark paid</button>}
                      </div>
                    ))}
                  </td></tr>
                )}
                </Fragment>
              );})}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="pay-foot">
                  <td><b>Total ({rows.length} guides)</b></td>
                  <td className="r">{totals.tours}</td>
                  <td className="r">{thb(totals.netFee)}</td>
                  <td className="r">{thb(totals.expenses)}</td>
                  <td className="r"><b>{thb(totals.payout)}</b></td>
                  <td colSpan={2}></td>
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
                    <td><input className="search" style={{ width: 150, fontSize: 12, fontVariantNumeric: "tabular-nums" }} defaultValue={b.ref} title="Bonus reference no. (e.g. PEAK job no.)" onBlur={(e) => { if (e.target.value.trim() !== b.ref) editBonusRef(b.id, e.target.value.trim()); }} /></td>
                    <td style={{ color: "var(--ink-soft)" }}>{b.reason || "—"}</td>
                    <td className="r" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>+{thb(b.amount)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {b.eslipUrl
                        ? <span style={{ display: "inline-flex", gap: 6 }}>
                            <a className="btn sm" href={b.eslipUrl} target="_blank" rel="noopener noreferrer" title="View bonus slip in Drive">📎 E-slip</a>
                            <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Replace">↻<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>
                          </span>
                        : <label className="btn sm" style={{ cursor: "pointer" }} title="Upload bonus payment slip">📎 Slip<input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadBonusEslip(b.id, f); e.target.value = ""; }} /></label>}
                    </td>
                    <td style={{ textAlign: "right" }}><button className="btn sm danger" title="Remove bonus" onClick={() => delBonus(b.id)}>×</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="pay-foot"><td colSpan={3}><b>Total bonuses</b></td><td className="r"><b>+{thb(bonuses.total)}</b></td><td colSpan={2} /></tr></tfoot>
            </table>
          )}
          <div className="op-toolbar" style={{ gap: 8, flexWrap: "wrap" }}>
            <select className="search" style={{ flex: "none", width: 200 }} value={bForm.guideId} onChange={(e) => setBForm((x) => ({ ...x, guideId: e.target.value }))}>
              <option value="">Choose guide…</option>
              {rows.map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.guide}</option>)}
            </select>
            <input className="search" style={{ flex: 1, minWidth: 180 }} placeholder="Reason (e.g. 5★ review – Omari)" value={bForm.reason} onChange={(e) => setBForm((x) => ({ ...x, reason: e.target.value }))} />
            <input className="search" style={{ flex: "none", width: 120 }} type="number" min={0} placeholder="฿ amount" value={bForm.amount} onChange={(e) => setBForm((x) => ({ ...x, amount: e.target.value }))} />
            <button className="btn primary" disabled={!bForm.guideId || !(parseFloat(bForm.amount) > 0)} onClick={addBonus}>+ Add bonus</button>
          </div>
        </div>
      </section>
    </div>
  );
}
