"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { Note } from "@/components/PeakPaymentDialog";
import { ADJUSTMENT_LABEL, ADJUSTMENT_TYPES, reconciliationLine, toSatang, type AdjustmentType } from "@/lib/payments-v2/rules";

// Record one bank transfer to a guide: which jobs it pays, the date the money actually
// left, the amount, any adjustment that makes those agree, and the slip. The jobs become
// paid only because this payment exists — see lib/payments-v2.

export type PayableJob = { date: string; slotIdx: number; ref?: string | null; tour?: string; amount: number; payBlock?: string | null; accountingMonth?: string | null };
export type RecordedPaymentResult = { id: string; paymentNo: string; paymentDate: string; amountTransferred: number; accountingPeriod: string; jobs: { jobNo: string; date: string; slotIdx: number; payable: number }[] };

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
  const [periodReason, setPeriodReason] = useState("");
  const [step, setStep] = useState<"compose" | "review">("compose");
  const [done, setDone] = useState<RecordedPaymentResult | null>(null);
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

  const months = [...new Set(chosen.map((j) => (j.accountingMonth ?? j.date).slice(0, 7)))].sort();
  const crossMonth = months.length > 1;

  async function submit() {
    setBusy(true); setReasons([]);
    const payload = {
      guideId, jobs: chosen.map((j) => ({ jobNo: (j.ref ?? "").trim(), date: j.date, slotIdx: j.slotIdx })),
      paymentDate, amountTransferred: Number(amount),
      adjustments: adjustments.filter((a) => a.description.trim() && a.amount.trim()).map((a) => ({ type: a.type, amount: Number(a.amount), description: a.description.trim() })),
      bankRef: bankRef.trim() || null, note: note.trim() || null,
      noSlipReason: file ? null : noSlipReason.trim() || null,
      mismatchReason: recon.balanced ? null : mismatchReason.trim() || null,
      periodOverrideReason: crossMonth ? periodReason.trim() || null : null,
    };
    const fd = new FormData();
    fd.append("payload", JSON.stringify(payload));
    if (file) fd.append("file", file);
    const r = await fetch("/api/guide-payments", { method: "POST", body: fd });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && d.ok) { setDone(d.payment as RecordedPaymentResult); return; }
    setStep("compose");
    setReasons(Array.isArray(d.reasons) && d.reasons.length ? d.reasons : [`Not recorded (${r.status})`]);
  }

  const ready = chosen.length > 0 && amount.trim() !== "" && paymentDate !== "";

  // Recorded: what exists now, from the server's own reply — never assumed.
  if (done) return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) onDone(`${done.paymentNo} recorded`); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recpay-done-h" style={{ width: "min(560px, 100%)" }}>
        <h3 id="recpay-done-h">Payment recorded</h3>
        <div className="mctx">{guideId} · {guide}</div>
        <div className="mbody" style={{ display: "grid", gap: 12 }}>
          <div className="pay-recon ok" role="status" style={{ display: "grid", gap: 4 }}>
            <b className="num" style={{ fontSize: 18 }}>{done.paymentNo}</b>
            <span>Transfer date {done.paymentDate} · amount transferred <b className="num">{thb(done.amountTransferred)}</b></span>
            <span>{done.jobs.length} job{done.jobs.length === 1 ? "" : "s"} paid · accounting month {done.accountingPeriod} · status RECORDED</span>
          </div>
          <div>
            <span className="paydoc-label">Job Nos. paid</span>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {done.jobs.map((j) => <li key={`${j.date}|${j.slotIdx}`}><span className="mono">{j.jobNo}</span> · {thb(j.payable)}</li>)}
            </ul>
          </div>
        </div>
        <div className="mfoot">
          <button className="btn primary" onClick={() => onDone(`${done.paymentNo} recorded · ${thb(done.amountTransferred)} · ${done.jobs.length} job${done.jobs.length === 1 ? "" : "s"} paid`)}>Done</button>
        </div>
      </div>
    </div>
  );

  // Review: the whole payment before it is committed.
  if (step === "review") return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recpay-review-h" style={{ width: "min(680px, 100%)" }}>
        <h3 id="recpay-review-h">Review payment</h3>
        <div className="mctx">{guideId} · {guide} · accounting month {months.join(" + ") || "—"}</div>
        <div className="mbody" style={{ display: "grid", gap: 12 }}>
          <div className="grid-scroll">
            <table className="acct-table pay-review" aria-label="Jobs in this payment">
              <thead><tr><th>Job No.</th><th>Tour date</th><th className="r">Payable</th><th className="r">Amount paid</th></tr></thead>
              <tbody>
                {chosen.map((j) => (
                  <tr key={key(j)}><td className="num">{j.ref ?? "—"}</td><td>{dShort(j.date)}</td><td className="r num">{thb(j.amount)}</td><td className="r num">{thb(j.amount)}</td></tr>
                ))}
                {adjustments.filter((a) => a.description.trim() && a.amount.trim()).map((a, i) => (
                  <tr key={`adj${i}`}><td>{ADJUSTMENT_LABEL[a.type]}</td><td>{a.description}</td><td className="r">—</td><td className="r num">{thb(Number(a.amount) || 0)}</td></tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={2}>Total jobs</td><td className="r num">{thb(recon.jobTotal)}</td><td className="r num">{thb(recon.jobTotal)}</td></tr>
                <tr><td colSpan={2}>Total adjustments</td><td className="r">—</td><td className="r num">{thb(recon.adjustmentTotal)}</td></tr>
                <tr><td colSpan={2}><b>Amount transferred</b></td><td className="r">—</td><td className="r num"><b>{thb(recon.amountTransferred)}</b></td></tr>
              </tfoot>
            </table>
          </div>
          <div className={`pay-recon${recon.balanced ? " ok" : ""}`} role="status">
            <span className="paydoc-label">Reconciliation</span>
            <b className="num">{reconciliationLine(recon)}</b>
            {!recon.balanced && <span>Difference {thb(recon.difference)}</span>}
          </div>
          <div className="pay-review-facts">
            <div><span className="paydoc-label">Transfer date</span><b>{paymentDate}</b></div>
            <div><span className="paydoc-label">Bank reference</span><b>{bankRef.trim() || "—"}</b></div>
            <div><span className="paydoc-label">Evidence</span><b>{file ? `Slip: ${file.name}` : noSlipReason.trim() ? `No slip — ${noSlipReason.trim()}` : "No slip, no reason given"}</b></div>
            <div><span className="paydoc-label">Accounting month</span><b>{months.join(" + ") || "—"}</b></div>
          </div>
          {crossMonth && (
            <label><span className="paydoc-label">These jobs book into {months.join(" and ")} — why are they in one transfer?</span>
              <input value={periodReason} onChange={(e) => setPeriodReason(e.target.value)} placeholder="Reason recorded on the payment" disabled={busy} />
            </label>
          )}
          {!recon.balanced && (
            <label><span className="paydoc-label">Why the transfer differs</span>
              <input value={mismatchReason} onChange={(e) => setMismatchReason(e.target.value)} placeholder="Add an adjustment, or say why" disabled={busy} />
            </label>
          )}
          {reasons.length > 0 && <Note tone="danger"><b>Cannot record this payment.</b>{reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={() => setStep("compose")} disabled={busy}>Back</button>
          <button className="btn primary" onClick={submit} disabled={busy}>{busy ? "Recording…" : `Record payment · ${thb(recon.amountTransferred)}`}</button>
        </div>
      </div>
    </div>
  );

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
          {crossMonth && <Note tone="warn">These jobs book into {months.join(" and ")}. One transfer may cover them, but the reason is recorded on the payment — you are asked for it in the review.</Note>}
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
          <button className="btn primary" onClick={() => { setReasons([]); setStep("review"); }} disabled={!ready || busy}>Review · {thb(recon.amountTransferred)} · {chosen.length} job{chosen.length === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}
