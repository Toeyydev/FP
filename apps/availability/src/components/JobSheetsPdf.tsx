"use client";

import { useEffect, useState } from "react";
import OperatorNav from "@/components/OperatorNav";

// Every approved job sheet, filed in Drive as a PDF. New approvals do this by themselves;
// this saves the ones approved before that, a few at a time.

type Key = { guideId: string; date: string; slotIdx: number; ref?: string | null };
type Result = Key & { ok: boolean; link?: string | null; error?: string };

const dShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function JobSheetsPdf() {
  const [plan, setPlan] = useState<{ sheets: Key[]; batch: number; destination: string } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const call = async (body: object) => {
    const r = await fetch("/api/admin/job-sheets-pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.reasons ?? []).join(" ") || `That did not work (HTTP ${r.status}).`);
    return d;
  };
  const preview = async () => {
    setMsg(null);
    try { const d = await call({ action: "preview" }); setPlan({ sheets: d.sheets, batch: d.batch, destination: d.destination }); } catch (e) { setMsg({ tone: "danger", text: (e as Error).message }); }
  };
  useEffect(() => { void preview(); }, []);

  const run = async (sheets: Key[]) => {
    if (!plan) return;
    setBusy(true); setMsg(null); setResults([]);
    const done: Result[] = [];
    try {
      for (let i = 0; i < sheets.length; i += plan.batch) {
        const part = sheets.slice(i, i + plan.batch).map(({ guideId, date, slotIdx }) => ({ guideId, date, slotIdx }));
        const d = await call({ action: "save", sheets: part });
        done.push(...(d.results as Result[]));
        setResults([...done]);
      }
      const bad = done.filter((r) => !r.ok).length;
      setMsg({ tone: bad ? "danger" : "ok", text: bad ? `Saved ${done.length - bad} PDF${done.length - bad === 1 ? "" : "s"}; ${bad} did not save — see below, and run those again.` : `Saved ${done.length} PDF${done.length === 1 ? "" : "s"} to Drive.` });
    } catch (e) {
      setMsg({ tone: "danger", text: `Stopped after ${done.length}: ${(e as Error).message}` });
    } finally { setBusy(false); }
  };
  const failed = results.filter((r) => !r.ok);

  return (
    <div className="op-layout">
      <OperatorNav active="job-sheets-pdf" />
      <div className="op-main">
        <section className="panel" style={{ padding: 16 }}>
          <div className="panel-head" style={{ padding: 0, marginBottom: 10 }}><h2>Job sheet PDFs · บันทึกใบงานเป็น PDF</h2>
            <span className="hint">An approved job sheet is now saved to Drive as a PDF when it is approved. This saves the ones approved before that.</span>
          </div>
          {msg && <div className={`banner ${msg.tone}`} role="status" style={{ marginBottom: 10 }}>{msg.text}</div>}
          {plan && (
            <>
              <p><b>{plan.sheets.length}</b> approved job sheet{plan.sheets.length === 1 ? "" : "s"}. Each is saved to the Folkpaths Shared Drive, <i>Folkpaths Job Sheets / month</i>, as a PDF; a PDF already there with the same name is replaced. Google Doc copies are left as they are.</p>
              {plan.destination !== "shared-drive" && <div className="banner danger" role="status">The Folkpaths Shared Drive is not set up ({plan.destination}). Nothing can be saved until FOLKPATHS_SHARED_DRIVE_ID is configured.</div>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                <button className="btn ghost" disabled={busy || plan.sheets.length === 0 || plan.destination !== "shared-drive"} onClick={() => run(plan.sheets.slice(0, 1))}>Test 1</button>
                <button className="btn primary" disabled={busy || plan.sheets.length === 0 || plan.destination !== "shared-drive"} onClick={() => run(plan.sheets)}>{busy ? `Saving… ${results.length}/${plan.sheets.length}` : `Save ${plan.sheets.length} PDFs`}</button>
                {failed.length > 0 && !busy && <button className="btn ghost" onClick={() => run(failed)}>Retry {failed.length}</button>}
              </div>
            </>
          )}
          {results.length > 0 && (
            <div className="tablewrap" style={{ marginTop: 10 }}><table className="adv-table">
              <thead><tr><th>Tour date</th><th>Guide</th><th>Job No.</th><th>PDF</th></tr></thead>
              <tbody>{results.map((r) => <tr key={`${r.guideId}|${r.date}|${r.slotIdx}`}><td>{dShort(r.date)}</td><td>{r.guideId}</td><td className="mono">{r.ref ?? "—"}</td>
                <td>{r.ok && r.link ? <a href={r.link} target="_blank" rel="noreferrer">Open</a> : <span style={{ color: "var(--danger, #b91c1c)" }}>{r.error ?? "not saved"}</span>}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>
      </div>
    </div>
  );
}
