"use client";

import { useCallback, useEffect, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { thb } from "@/lib/jobsheet";
import { SLOTS } from "@/lib/slots";

type Row = { guideId: string; guide?: string; date: string; slotIdx: number; tour: string; pax?: number | null; fee: number; expenses: number; amount: number; status: string };
type Totals = { pending: number; approved: number; paid: number };

const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const GROUPS: { key: string; label: string }[] = [
  { key: "PENDING", label: "Pending" }, { key: "APPROVED", label: "Approved" }, { key: "PAID", label: "Paid" }, { key: "CANCELLED", label: "Cancelled" },
];
const mLabelFull = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
// Collect tours into month buckets, newest month first.
function byMonthDesc(rows: Row[]): [string, Row[]][] {
  const map: Record<string, Row[]> = {};
  for (const r of rows) { const m = (r.date || "").slice(0, 7); (map[m] ??= []).push(r); }
  return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
}

export default function Pay({ isOperator }: { isOperator: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ pending: 0, approved: 0, paid: 0 });
  const [monthFilter, setMonthFilter] = useState("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleGrp = (k: string) => setHidden((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const load = useCallback(async () => {
    const r = await fetch(`/api/pay${isOperator ? "?view=ops" : ""}`, { cache: "no-store" });
    if (r.ok) { const d = await r.json(); setRows(d.rows ?? []); setTotals(d.totals); }
  }, [isOperator]);
  useEffect(() => { load(); }, [load]);

  async function setStatus(r: Row, status: string) {
    const res = await fetch("/api/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: r.guideId, date: r.date, slotIdx: r.slotIdx, status }) });
    if (res.ok) load();
  }
  async function remove(r: Row) {
    if (!confirm(`Delete this payment?\n${dShort(r.date)} · ${r.tour}${r.guide ? ` · ${r.guide}` : ""}\nThis removes the tour from pay and the schedule (the job sheet is kept).`)) return;
    const res = await fetch("/api/pay", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId: r.guideId, date: r.date, slotIdx: r.slotIdx }) });
    if (res.ok) load();
  }

  return (
    <div className="wrap">
      <AuthHeader backHref="/" />
      <div id="appBar"><div className="subtabs"><span className="subtab active">{isOperator ? "Payment approvals" : "My pay"}</span></div></div>

      <section className="panel">
        <div className="op-toolbar" style={{ gap: 18 }}>
          <div className="stat"><b style={{ color: "#b45309" }}>{thb(totals.pending)}</b><span>Pending</span></div>
          <div className="stat"><b style={{ color: "var(--assign)" }}>{thb(totals.approved)}</b><span>Approved</span></div>
          <div className="stat"><b style={{ color: "var(--green)" }}>{thb(totals.paid)}</b><span>Paid</span></div>
          <select className="search" style={{ flex: "none", width: 170, marginLeft: "auto" }} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} title="Filter by month">
            <option value="all">All months</option>
            {byMonthDesc(rows).map(([m]) => <option key={m} value={m}>{mLabelFull(m)}</option>)}
          </select>
        </div>
        <div style={{ padding: 14 }}>
          {rows.length === 0 ? <div className="op-empty">No tours yet.</div> : byMonthDesc(rows).filter(([m]) => monthFilter === "all" || m === monthFilter).map(([month, mrows]) => (
            <div key={month} style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, borderBottom: "2px solid var(--line)", paddingBottom: 6, marginBottom: 12 }}>
                <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: "-0.01em" }}>{mLabelFull(month)}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-soft)", fontWeight: 600 }}>{mrows.length} tour{mrows.length === 1 ? "" : "s"} · {thb(mrows.filter((r) => r.status !== "CANCELLED").reduce((sum, r) => sum + (r.amount || 0), 0))}</span>
              </div>
              {(() => {
                const live = mrows.filter((r) => r.status !== "CANCELLED");
                const pax = live.reduce((sum, r) => sum + (r.pax ?? 0), 0);
                const fee = live.reduce((sum, r) => sum + (r.fee || 0), 0);
                const exp = live.reduce((sum, r) => sum + (r.expenses || 0), 0);
                const tot = live.reduce((sum, r) => sum + (r.amount || 0), 0);
                return (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "baseline", margin: "0 0 14px", padding: "10px 12px", background: "var(--grey-bg, #f6f5f3)", borderRadius: 10, fontSize: 12.5 }}>
                    <span><b style={{ fontSize: 16 }}>{live.length}</b> job{live.length === 1 ? "" : "s"}</span>
                    <span><b style={{ fontSize: 16 }}>{pax}</b> pax hosted</span>
                    <span>Guide fee <b>{thb(fee)}</b></span>
                    <span>Expenses <b>{thb(exp)}</b></span>
                    <span style={{ marginLeft: "auto" }}>Total <b style={{ fontSize: 16, color: "var(--green)" }}>{thb(tot)}</b></span>
                  </div>
                );
              })()}
              {GROUPS.map((g) => {
                const items = mrows.filter((r) => r.status === g.key);
                if (!items.length) return null;
                const gkey = `${month}|${g.key}`; const isHid = hidden.has(gkey);
                return (
                  <div key={g.key} style={{ marginBottom: 14 }}>
                    <h3 onClick={() => toggleGrp(gkey)} style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--ink-soft)", margin: "0 0 8px", cursor: "pointer" }}>{isHid ? "▸ " : "▾ "}{g.label} ({items.length})</h3>
                {!isHid && items.map((r, i) => (
                  <div key={i} className="pay-row">
                    <span className="pr-when">{dShort(r.date)}</span>
                    <span className="pr-main">
                      <b>{r.tour}</b>
                      <div className="pr-sub">{dShort(r.date)}{SLOTS[r.slotIdx]?.start ? ` · ${SLOTS[r.slotIdx].start}` : ""}{r.pax != null ? ` · ${r.pax} pax` : ""}</div>
                      <div className="pr-sub">Guide fee {thb(r.fee)}{r.expenses > 0 ? ` + expenses ${thb(r.expenses)}` : ""}</div>
                      {isOperator && r.guide ? <div className="pr-sub">{r.guideId} {r.guide}</div> : null}
                    </span>
                    <span className="pr-amt">{thb(r.amount)}</span>
                    {isOperator && (
                      <span style={{ display: "flex", gap: 6 }}>
                        {r.status === "PENDING" && <button className="btn sm primary" onClick={() => setStatus(r, "APPROVED")}>Approve</button>}
                        {r.status === "APPROVED" && <button className="btn sm primary" onClick={() => setStatus(r, "PAID")}>Mark paid</button>}
                        {r.status === "PAID" && <button className="btn sm ghost" onClick={() => setStatus(r, "APPROVED")}>Undo</button>}
                        {(r.status === "PENDING" || r.status === "APPROVED") && <button className="btn sm ghost danger" onClick={() => { if (confirm("Cancel this payment? It won't be counted as owed.")) setStatus(r, "CANCELLED"); }}>Cancel</button>}
                        {r.status === "CANCELLED" && <button className="btn sm ghost" onClick={() => setStatus(r, "PENDING")}>Restore</button>}
                        <button className="btn sm danger" title="Delete this payment entry" onClick={() => remove(r)}>🗑</button>
                      </span>
                    )}
                  </div>
                ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
