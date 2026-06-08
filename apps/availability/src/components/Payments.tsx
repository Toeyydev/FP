"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { thb } from "@/lib/jobsheet";

type Row = { guideId: string; guide: string; tours: number; netFee: number; expenses: number; payout: number; status: string; paidAt: string | null };
type Totals = { tours: number; netFee: number; expenses: number; payout: number };

export default function Payments() {
  const [period, setPeriod] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ tours: 0, netFee: 0, expenses: 0, payout: 0 });

  const load = useCallback(async (p?: string) => {
    const r = await fetch(`/api/payments${p ? `?period=${p}` : ""}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setPeriod(d.period); setRows(d.rows ?? []); setTotals(d.totals); }
  }, []);
  useEffect(() => { load(); }, [load]);

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
                <tr><td colSpan={7} className="op-empty">No job sheets in this month yet.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.guideId}>
                  <td><span className="gid">{r.guideId}</span> {r.guide}</td>
                  <td className="r">{r.tours}</td>
                  <td className="r">{thb(r.netFee)}</td>
                  <td className="r">{thb(r.expenses)}</td>
                  <td className="r"><b>{thb(r.payout)}</b></td>
                  <td><span className={`badge ${r.status === "paid" ? "active" : "invited"}`}>{r.status === "paid" ? "Paid" : "Pending"}</span></td>
                  <td style={{ display: "flex", gap: 6 }}>{r.status === "paid"
                    ? <button className="btn sm ghost" onClick={() => mark(r.guideId, "pending")}>Undo</button>
                    : <button className="btn sm primary" onClick={() => mark(r.guideId, "paid")}>Mark paid</button>}
                    <button className="btn sm danger" title="Delete this guide's pay for the month" onClick={() => removeRow(r.guideId, r.guide)}>🗑</button></td>
                </tr>
              ))}
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
    </div>
  );
}
