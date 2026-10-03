"use client";

import { useState } from "react";
import OperatorNav from "@/components/OperatorNav";
import type { PlanSummary } from "@/lib/archived-restore";

// Past bookings that "Archive stale" hid, brought back when Bókun says they were confirmed
// (lib/archived-restore). Preview first — it changes nothing — then restore exactly that list.
// Restored bookings are PENDING with no guide: record who guided each day on Bookings.

export default function RestoreArchived() {
  const [from, setFrom] = useState("2026-02-01");
  const [to, setTo] = useState("2026-06-30");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const call = async (body: object) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/restore-archived", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "danger", text: (d.reasons ?? []).join(" ") || `That did not work (HTTP ${r.status}).` }); return null; }
      return d;
    } finally { setBusy(false); }
  };
  const preview = async () => { setPlan(null); const d = await call({ action: "preview", from, to }); if (d) setPlan(d as PlanSummary); };
  const apply = async () => {
    if (!plan) return;
    const d = await call({ action: "apply", from, to, hash: plan.hash });
    if (d) { setMsg({ tone: "ok", text: `Restored ${d.restored} bookings. They are on Bookings → All bookings, waiting for a guide to be recorded.` }); setPlan(null); }
  };
  const months = plan ? Object.entries(plan.restore.byMonth).sort(([a], [b]) => a.localeCompare(b)) : [];
  const reasons = plan ? Object.entries(plan.exceptions.reduce<Record<string, number>>((m, e) => ({ ...m, [e.reason]: (m[e.reason] ?? 0) + 1 }), {})) : [];

  return (
    <div className="op-layout">
      <OperatorNav active="restore-bookings" />
      <div className="op-main">
        <section className="panel">
          <div className="panel-head"><h2>Restore archived bookings · กู้คืนบุ๊คกิ้งที่ถูก archive</h2>
            <span className="hint">“Archive stale” hid past bookings that never had a guide. Those confirmed in Bókun come back as tours waiting for a guide — nothing else is created.</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
            <label>From<br /><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPlan(null); }} /></label>
            <label>To<br /><input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPlan(null); }} /></label>
            <button className="btn js-restore-preview" disabled={busy} onClick={preview}>{busy && !plan ? "Reading Bókun…" : "Preview"}</button>
          </div>
          {msg && <div className={`banner ${msg.tone}`} role="status" style={{ marginTop: 10 }}>{msg.text}</div>}
          {plan && (
            <div className="js-restore-plan" style={{ marginTop: 12 }}>
              <p><b>{plan.restore.count}</b> bookings · <b>{plan.restore.pax}</b> guests · <b>{plan.restore.departures}</b> departures would come back.</p>
              <div className="tablewrap">
                <table className="adv-table">
                  <thead><tr><th>Month</th><th className="r">Departures</th><th className="r">Bookings</th><th className="r">Guests</th></tr></thead>
                  <tbody>{months.map(([m, v]) => <tr key={m}><td>{m}</td><td className="r">{v.departures}</td><td className="r">{v.bookings}</td><td className="r">{v.pax}</td></tr>)}</tbody>
                </table>
              </div>
              {reasons.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary>{plan.exceptions.length} archived bookings stay hidden</summary>
                  <ul>{reasons.map(([r, n]) => <li key={r}>{r}: {n}</li>)}</ul>
                  <div className="tablewrap"><table className="adv-table"><tbody>
                    {plan.exceptions.map((e) => <tr key={e.id}><td className="mono" style={{ fontSize: 12 }}>{e.ref}</td><td>{e.date}</td><td>{e.reason}</td></tr>)}
                  </tbody></table></div>
                </details>
              )}
              <button className="btn primary js-restore-apply" style={{ marginTop: 10 }} disabled={busy || plan.restore.count === 0} onClick={apply}>
                Restore {plan.restore.count} bookings
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
