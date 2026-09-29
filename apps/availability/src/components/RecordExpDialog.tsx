"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { Note } from "@/components/PeakPaymentDialog";
import { normalizeExpRef } from "@/lib/record-exp";

// "Record EXP…" — jobs already paid whose PEAK document was made by hand in PEAK: type
// that document's number once for every job it covers. Only the ref is written: paid
// date, slip and status stay, nobody is notified, and PEAK is not called.

export type ExpJob = { date: string; slotIdx: number; ref?: string | null; amount: number; paidAt?: string | null; tour?: string };

const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const bkkDate = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10) : "");
const dShort = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");

export default function RecordExpDialog({ guideId, guide, jobs, preselect, onClose, onDone }: {
  guideId: string;
  guide: string;
  jobs: ExpJob[];
  preselect: string[];
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(preselect));
  const [ref, setRef] = useState("EXP-");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // One transfer is usually one document: offer "everything paid on <date>" in one tap.
  const paidDates = [...new Set(jobs.map((j) => bkkDate(j.paidAt)).filter(Boolean))].sort();
  const chosen = jobs.filter((j) => picked.has(key(j)));
  const total = chosen.reduce((s, j) => s + (j.amount || 0), 0);
  const normalized = normalizeExpRef(ref);
  const ready = !!normalized && chosen.length > 0;

  async function submit(confirmShared = false) {
    if (!ready || !normalized) return;
    setBusy(true); setReasons([]);
    const r = await fetch("/api/pay", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ guideId, jobs: chosen.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), peakRef: normalized, ...(confirmShared ? { confirmShared: true } : {}) }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && d.ok) { onDone(`${normalized} recorded on ${d.count} job${d.count === 1 ? "" : "s"}`); return; }
    if (d.error === "ref-used-elsewhere" && !confirmShared) {
      if (confirm(`${normalized} is already recorded for ${(d.guides ?? []).join(", ")}.\n\nRecord it for ${guideId} as well? Only if it really is the same PEAK document (for example, the same person under two guide codes).`)) return submit(true);
      return;
    }
    setReasons(Array.isArray(d.reasons) && d.reasons.length ? d.reasons : [`Not recorded (${r.status})`]);
  }

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recexp-h" style={{ width: "min(560px, 100%)" }}>
        <h3 id="recexp-h">Record a PEAK document number</h3>
        <div className="mctx">{guideId} · {guide} · paid jobs with no PEAK document in FolkOPS</div>
        <div className="mbody" style={{ display: "grid", gap: 12 }}>
          <Note tone="warn">For a document already made by hand in PEAK. Tick every job it covers. Nothing is sent to PEAK and the payment itself does not change.</Note>
          {paidDates.length > 1 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }}>
              <span style={{ color: "var(--ink-soft)" }}>Tick all paid on</span>
              {paidDates.map((d) => <button key={d} type="button" className="btn sm ghost" disabled={busy} onClick={() => setPicked(new Set(jobs.filter((j) => bkkDate(j.paidAt) === d).map(key)))}>{dShort(d)}</button>)}
            </div>
          )}
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
            <legend className="paydoc-label">Jobs</legend>
            {jobs.map((j) => (
              <label key={key(j)} className="paydoc-job">
                <input type="checkbox" checked={picked.has(key(j))} onChange={() => setPicked((s) => { const n = new Set(s); n.has(key(j)) ? n.delete(key(j)) : n.add(key(j)); return n; })} />
                <span style={{ minWidth: 70 }}>{dShort(j.date)}</span>
                <span style={{ flex: 1, minWidth: 0 }}><span className="paydoc-ref">{j.ref ?? "no job number"}</span><span style={{ display: "block", fontSize: 11.5, color: "var(--ink-soft)" }}>paid {dShort(bkkDate(j.paidAt))}</span></span>
                <b className="num">{thb(j.amount)}</b>
              </label>
            ))}
          </fieldset>
          <label>
            <span className="paydoc-label">PEAK document number</span>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="EXP-…" autoFocus disabled={busy} />
          </label>
          {ref.trim() && ref.trim().toUpperCase() !== "EXP-" && !normalized && <Note tone="warn">That does not look like a PEAK document number — EXP- followed by the number shown in PEAK.</Note>}
          {reasons.length > 0 && <Note tone="danger"><b>Not recorded.</b>{reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
        </div>
        <div className="mfoot">
          {!busy && !ready && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>{!chosen.length ? "Tick the jobs" : "Enter the EXP number"} to continue</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={() => submit()} disabled={!ready || busy}>{busy ? "Recording…" : `Record ${normalized ?? "EXP"} · ${chosen.length} job${chosen.length === 1 ? "" : "s"} · ${thb(total)}`}</button>
        </div>
      </div>
    </div>
  );
}
