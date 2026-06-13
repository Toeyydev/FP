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

export default function Pay({ isOperator }: { isOperator: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Totals>({ pending: 0, approved: 0, paid: 0 });

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
        </div>
        <div style={{ padding: 14 }}>
          {rows.length === 0 ? <div className="op-empty">No tours yet.</div> : GROUPS.map((g) => {
            const items = rows.filter((r) => r.status === g.key);
            if (!items.length) return null;
            return (
              <div key={g.key} style={{ marginBottom: 18 }}>
                <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--ink-soft)", margin: "0 0 8px" }}>{g.label} ({items.length})</h3>
                {items.map((r, i) => (
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
      </section>
    </div>
  );
}
