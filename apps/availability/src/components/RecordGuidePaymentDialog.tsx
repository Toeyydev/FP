"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { Note } from "@/components/PeakPaymentDialog";
import { ADJUSTMENT_LABEL, ADJUSTMENT_TYPES, reconciliationLine, toSatang, type AdjustmentType } from "@/lib/payments-v2/rules";

// Record one bank transfer to a guide: which jobs it pays, the date the money actually
// left, the amount, any adjustment that makes those agree, and the slip. The jobs become
// paid only because this payment exists — see lib/payments-v2.

export type PayableJob = { date: string; slotIdx: number; ref?: string | null; tour?: string; amount: number; payBlock?: string | null };

const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const dShort = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
type Adjustment = { type: AdjustmentType; amount: string; description: string };

export default function RecordGuidePaymentDialog({ guideId, guide, jobs, preselect, today, onClose, onDone }: {
  guideId: string;
  guide: string;
  jobs: PayableJob[];
  preselect: string[];
  today: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const payable = jobs.filter((j) => !j.payBlock);
  const [picked, setPicked] = useState<Set<string>>(new Set(preselect.length ? preselect : payable.map(key)));
  const [paymentDate, setPaymentDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [bankRef, setBankRef] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [noSlipReason, setNoSlipReason] = useState("");
  const [mismatchReason, setMismatchReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const chosen = jobs.filter((j) => picked.has(key(j)));
  const recon = useMemo(() => {
    const jobTotal = chosen.reduce((s, j) => s + toSatang(j.amount), 0);
    const adjustmentTotal = adjustments.reduce((s, a) => s + (Number.isFinite(Number(a.amount)) ? toSatang(Number(a.amount)) : 0), 0);
    const expected = jobTotal + adjustmentTotal;
    const transferred = Number.isFinite(Number(amount)) && amount.trim() !== "" ? toSatang(Number(amount)) : 0;
    return {
      jobTotal: jobTotal / 100, adjustmentTotal: adjustmentTotal / 100, expectedTransfer: expected / 100,
      amountTransferred: transferred / 100, difference: (transferred - expected) / 100, balanced: transferred === expected && amount.trim() !== "",
    };
  }, [chosen, adjustments, amount]);

  // The amount follows the jobs until someone types their own.
  useEffect(() => { if (!amountTouched) setAmount(recon.expectedTransfer ? recon.expectedTransfer.toFixed(2) : ""); }, [recon.expectedTransfer, amountTouched]);

  const setAdj = (i: number, patch: Partial<Adjustment>) => setAdjustments((a) => a.map((x, n) => (n === i ? { ...x, ...patch } : x)));

  async function submit() {
    setBusy(true); setReasons([]);
    const payload = {
      guideId, jobs: chosen.map((j) => ({ jobNo: (j.ref ?? "").trim(), date: j.date, slotIdx: j.slotIdx })),
      paymentDate, amountTransferred: Number(amount),
      adjustments: adjustments.filter((a) => a.description.trim() && a.amount.trim()).map((a) => ({ type: a.type, amount: Number(a.amount), description: a.description.trim() })),
      bankRef: bankRef.trim() || null, note: note.trim() || null,
      noSlipReason: file ? null : noSlipReason.trim() || null,
      mismatchReason: recon.balanced ? null : mismatchReason.trim() || null,
    };
    const fd = new FormData();
    fd.append("payload", JSON.stringify(payload));
    if (file) fd.append("file", file);
    const r = await fetch("/api/guide-payments", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && d.ok) { onDone(`${d.payment.paymentNo} recorded · ${thb(d.payment.amountTransferred)} · ${d.payment.jobs.length} job${d.payment.jobs.length === 1 ? "" : "s"} paid`); return; }
    setReasons(Array.isArray(d.reasons) && d.reasons.length ? d.reasons : [`Not recorded (${r.status})`]);
  }

  const ready = chosen.length > 0 && amount.trim() !== "" && paymentDate !== "";
  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recpay-h" style={{ width: "min(680px, 100%)" }}>
        <h3 id="recpay-h">Record payment</h3>
        <div className="mctx">{guideId} · {guide} · one bank transfer</div>
        <div className="mbody" style={{ display: "grid", gap: 14 }}>
          <Note tone="warn">A job becomes paid because this payment exists. Give the date the money actually left the bank — not today, if the transfer was earlier.</Note>

          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
            <legend className="paydoc-label">Jobs this transfer pays</legend>
            {jobs.map((j) => (
              <label key={key(j)} className="paydoc-job" style={j.payBlock ? { opacity: 0.6 } : undefined}>
                <input type="checkbox" checked={picked.has(key(j))} disabled={!!j.payBlock}
                  onChange={() => setPicked((s) => { const n = new Set(s); n.has(key(j)) ? n.delete(key(j)) : n.add(key(j)); return n; })} />
                <span style={{ minWidth: 64 }}>{dShort(j.date)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="paydoc-ref">{j.ref ?? "no Job No."}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-soft)" }}>{j.payBlock ?? j.tour ?? ""}</span>
                </span>
                <b className="num">{thb(j.amount)}</b>
              </label>
            ))}
          </fieldset>

          <div style={{ display: "grid", gap: 6 }}>
            <div className="paydoc-label">Adjustments</div>
            {adjustments.map((a, i) => (
              <div key={i} className="pay-adj-row">
                <select value={a.type} onChange={(e) => setAdj(i, { type: e.target.value as AdjustmentType })} disabled={busy} aria-label="Adjustment type">
                  {ADJUSTMENT_TYPES.map((t) => <option key={t} value={t}>{ADJUSTMENT_LABEL[t]}</option>)}
                </select>
                <input value={a.description} onChange={(e) => setAdj(i, { description: e.target.value })} placeholder="What it settles" disabled={busy} aria-label="Adjustment description" />
                <input value={a.amount} onChange={(e) => setAdj(i, { amount: e.target.value })} inputMode="decimal" placeholder="−70.00" className="num" disabled={busy} aria-label="Adjustment amount" />
                <button type="button" className="btn sm ghost" onClick={() => setAdjustments((x) => x.filter((_, n) => n !== i))} disabled={busy}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn sm" disabled={busy} onClick={() => setAdjustments((a) => [...a, { type: "ADVANCE_SETTLEMENT", amount: "", description: "" }])}>+ Add adjustment</button>
              <span className="pay-doc-note" style={{ marginLeft: 8 }}>An advance the guide still holds lowers the transfer, never a job&rsquo;s expense.</span>
            </div>
          </div>

          <div className={`pay-recon${recon.balanced ? " ok" : ""}`} role="status">
            <span className="paydoc-label">Reconciliation</span>
            <b className="num">{reconciliationLine(recon)}</b>
          </div>
          {!recon.balanced && amount.trim() !== "" && (
            <label><span className="paydoc-label">Why the transfer differs</span>
              <input value={mismatchReason} onChange={(e) => setMismatchReason(e.target.value)} placeholder="Add an adjustment, or say why" disabled={busy} />
            </label>
          )}

          <div className="pay-form-grid">
            <label><span className="paydoc-label">Payment date · when the bank sent it</span>
              <input type="date" value={paymentDate} max={today} onChange={(e) => setPaymentDate(e.target.value)} disabled={busy} />
            </label>
            <label><span className="paydoc-label">Amount transferred</span>
              <input value={amount} inputMode="decimal" className="num" onChange={(e) => { setAmountTouched(true); setAmount(e.target.value); }} disabled={busy} />
            </label>
            <label><span className="paydoc-label">Bank reference · optional</span>
              <input value={bankRef} onChange={(e) => setBankRef(e.target.value)} placeholder="Transaction id from the slip" disabled={busy} />
            </label>
            <label><span className="paydoc-label">Bank slip</span>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
            </label>
          </div>
          {!file && (
            <label><span className="paydoc-label">No slip? Say why</span>
              <input value={noSlipReason} onChange={(e) => setNoSlipReason(e.target.value)} placeholder="e.g. cash paid in person, slip to follow" disabled={busy} />
            </label>
          )}
          <label><span className="paydoc-label">Note · optional</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
          </label>

          {reasons.length > 0 && <Note tone="danger"><b>Not recorded.</b>{reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
        </div>
        <div className="mfoot">
          {!busy && !ready && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>{!chosen.length ? "Tick the jobs this transfer paid" : "Enter the amount and date"}</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!ready || busy}>{busy ? "Recording…" : `Record ${thb(recon.amountTransferred)} · ${chosen.length} job${chosen.length === 1 ? "" : "s"}`}</button>
        </div>
      </div>
    </div>
  );
}
