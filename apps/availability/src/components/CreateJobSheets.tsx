"use client";

import { useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";
import type { MissingSheet } from "@/lib/jobsheet-backfill";

// Upcoming jobs assigned before job sheets were made at assignment (2026-10-15). Preview the
// list — it changes nothing — then create exactly those sheets, each numbered FOLK-BKK.

const dShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function CreateJobSheets() {
  const [plan, setPlan] = useState<{ jobs: MissingSheet[]; hash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);
  const [made, setMade] = useState<{ guideId: string; date: string; slotIdx: number; ref: string | null }[]>([]);

  const call = async (body: object) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/job-sheets-backfill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ tone: "danger", text: (d.reasons ?? []).join(" ") || `That did not work (HTTP ${r.status}).` }); return null; }
      return d;
    } finally { setBusy(false); }
  };
  const preview = async () => { const d = await call({ action: "preview" }); if (d) setPlan({ jobs: d.jobs, hash: d.hash }); };
  useEffect(() => { void preview(); }, []);
  const apply = async () => {
    if (!plan) return;
    const d = await call({ action: "apply", hash: plan.hash });
    if (d) {
      const n = (d.created as { ref: string | null }[]).filter((c) => c.ref).length;
      setMade(d.created);
      setMsg({ tone: "ok", text: `Created ${n} job sheet${n === 1 ? "" : "s"}. Each is numbered and waiting to be filled in — nothing is approved.` });
      setPlan(null);
    }
  };

  return (
    <div className="op-layout">
      <OperatorNav active="create-job-sheets" />
      <div className="op-main">
        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-head" style={{ padding: 0, marginBottom: 10 }}><h2>Create job sheets · สร้างใบงานย้อนหลัง</h2>
            <span className="hint">Job sheets are now made when the guide gets the job. These upcoming jobs were assigned before that, and have none yet.</span>
          </div>
          {msg && <div className={`banner ${msg.tone}`} role="status" style={{ marginBottom: 10 }}>{msg.text}</div>}
          {plan && (
            <div className="js-backfill-plan">
              <p><b>{plan.jobs.length}</b> upcoming job{plan.jobs.length === 1 ? "" : "s"} without a job sheet. Each gets the guests, the tour&rsquo;s standard lines, the standard fee and a FOLK-BKK number.</p>
              {plan.jobs.length > 0 && (
                <div className="tablewrap"><table className="adv-table">
                  <thead><tr><th>Tour date</th><th>Tour</th><th>Guide</th></tr></thead>
                  <tbody>{plan.jobs.map((j) => <tr key={`${j.guideId}|${j.date}|${j.slotIdx}`}><td>{dShort(j.date)} · {j.time}</td><td>{j.tour}</td><td>{j.guideId} {j.guide}</td></tr>)}</tbody>
                </table></div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn primary js-backfill-apply" disabled={busy || plan.jobs.length === 0} onClick={apply}>{busy ? "Creating…" : `Create ${plan.jobs.length} job sheet${plan.jobs.length === 1 ? "" : "s"}`}</button>
                <button className="btn ghost" disabled={busy} onClick={preview}>Refresh</button>
              </div>
            </div>
          )}
          {made.length > 0 && (
            <div className="tablewrap js-backfill-made" style={{ marginTop: 10 }}><table className="adv-table">
              <thead><tr><th>Tour date</th><th>Guide</th><th>Job No.</th><th /></tr></thead>
              <tbody>{made.map((m) => <tr key={`${m.guideId}|${m.date}|${m.slotIdx}`}><td>{dShort(m.date)}</td><td>{m.guideId}</td><td className="mono">{m.ref ?? "—"}</td>
                <td><a className="btn sm" href={`/job-sheet?guideId=${encodeURIComponent(m.guideId)}&date=${m.date}&slotIdx=${m.slotIdx}`}>Open</a></td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      </div>
    </div>
  );
}
