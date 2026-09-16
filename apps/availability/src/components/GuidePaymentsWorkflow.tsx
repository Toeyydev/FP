"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import RecordGuidePaymentDialog, { type PayableJob } from "@/components/RecordGuidePaymentDialog";

// Guide payments: the jobs waiting for a transfer, the transfer itself, and what was
// recorded. Eligibility shown here comes from the canonical facts (/api/guide-payments/
// candidates → lib/payments-v2); the record itself is validated again by the service.

type Candidate = {
  guideId: string; guide: string; jobNo: string | null; date: string; slotIdx: number; time: string; tour: string;
  accountingDate: string; accountingMonth: string;
  feeGross: number; wht: number; reimbursement: number; reviewReward: number; payable: number;
  adjustments: { type: string; amount: number }[]; amountDue: number;
  readiness: string; paymentStatus: string; paidBy: string | null; eligible: boolean; blockedReason: string | null;
};
type PaymentRow = {
  id: string; paymentNo: string; status: string; source: string; guideId: string; guide: string;
  paymentDate: string; accountingPeriod: string; amountTransferred: number; jobTotal: number; adjustmentTotal: number;
  createdAt: string; reversedAt: string | null; reversalReason: string | null; slipUrl: string | null; noSlipReason: string | null;
  jobs: { jobNo: string; payable: number }[];
};
type Detail = {
  id: string; paymentNo: string; status: string; source: string; guide: string; guideId: string; paymentDate: string; accountingPeriod: string;
  reconciliation: { jobTotal: number; adjustmentTotal: number; expectedTransfer: number; amountTransferred: number; difference: number; balanced: boolean };
  bankRef: string | null; slipUrl: string | null; noSlipReason: string | null; mismatchReason: string | null; periodOverrideReason: string | null;
  note: string | null; createdAt: string; createdBy: string | null; reversedAt: string | null; reversedBy: string | null; reversalReason: string | null;
  jobs: { jobNo: string; date: string; slotIdx: number; payable: number; feeGross: number; wht: number; reimbursement: number; reviewReward: number; peakDocumentNo: string | null; active: boolean }[];
  adjustments: { type: string; amount: number; description: string; jobNo: string | null }[];
};

const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const dShort = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
const STATUS_LABEL: Record<string, string> = { unpaid: "Unpaid", paid: "Paid", "legacy-paid": "Paid · no payment record", "payroll-paid": "Paid by payroll" };

export default function GuidePaymentsWorkflow({ canEdit }: { canEdit: boolean }) {
  const [period, setPeriod] = useState(thisMonth());
  const [rows, setRows] = useState<Candidate[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [today, setToday] = useState(thisMonth() + "-01");
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [payFor, setPayFor] = useState<{ guideId: string; guide: string; jobs: PayableJob[]; preselect: string[] } | null>(null);
  const [openPayment, setOpenPayment] = useState<Detail | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    const [c, h] = await Promise.all([
      fetch(`/api/guide-payments/candidates?period=${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { rows: [] })),
      fetch(`/api/guide-payments?period=${p}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : { payments: [] })),
    ]);
    setRows(c.rows ?? []);
    setToday(c.today ?? thisMonth());
    setPayments(h.payments ?? []);
    setPicked(new Set());
    setLoading(false);
  }, []);
  useEffect(() => { load(period); }, [period, load]);

  // A payment is one transfer to one guide: the first tick fixes the guide.
  const pickedRows = rows.filter((r) => picked.has(`${r.guideId}|${key(r)}`));
  const payingGuide = pickedRows[0]?.guideId ?? null;
  const toggle = (r: Candidate) => setPicked((s) => {
    const n = new Set(s); const k = `${r.guideId}|${key(r)}`;
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });

  const selectedTotal = pickedRows.reduce((s, r) => s + r.amountDue, 0);
  const openRecord = () => {
    if (!payingGuide) return;
    const guideRows = rows.filter((r) => r.guideId === payingGuide);
    setPayFor({
      guideId: payingGuide,
      guide: guideRows[0]?.guide ?? payingGuide,
      jobs: guideRows.map((r) => ({ date: r.date, slotIdx: r.slotIdx, ref: r.jobNo, tour: r.tour, amount: r.amountDue, payBlock: r.blockedReason, accountingMonth: r.accountingMonth })),
      preselect: pickedRows.map((r) => key(r)),
    });
  };

  async function openDetail(id: string) {
    const r = await fetch(`/api/guide-payments/${id}`, { cache: "no-store" });
    if (r.ok) setOpenPayment(await r.json());
  }

  async function reverse(p: PaymentRow) {
    const reason = prompt(`Reverse ${p.paymentNo} (${thb(p.amountTransferred)}, ${p.jobs.length} job${p.jobs.length === 1 ? "" : "s"})?\n\nThe payment stays on record, marked reversed, and its jobs become unpaid again.\n\nReversal reason:`, "");
    if (reason === null) return;
    setBusy(true);
    const r = await fetch(`/api/guide-payments/${p.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok || !d.ok) { setMsg(d.detail || `Couldn't reverse ${p.paymentNo} (${r.status}).`); return; }
    const held = (d.stillPaid ?? []) as { jobNo: string; paymentNo: string }[];
    const unpaid = (d.unpaidJobs ?? []).length;
    setMsg(
      `Payment ${d.paymentNo} reversed. ${unpaid} job${unpaid === 1 ? "" : "s"} unpaid again.` +
      (held.length ? ` ${held.length} job${held.length === 1 ? "" : "s"} remain${held.length === 1 ? "s" : ""} paid because ${held.length === 1 ? "it belongs" : "they belong"} to another active payment: ${held.map((h) => `${h.jobNo} (${h.paymentNo})`).join(", ")}.` : "")
    );
    setOpenPayment(null);
    load(period);
  }

  const eligible = rows.filter((r) => r.eligible).length;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="panel">
        <div className="op-toolbar" style={{ gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Accounting month</label>
          <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{loading ? "Loading…" : `${eligible} job${eligible === 1 ? "" : "s"} waiting for a transfer`}</span>
          {pickedRows.length > 0 && (
            <span style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
              <b style={{ fontVariantNumeric: "tabular-nums" }}>{pickedRows.length} selected · {thb(selectedTotal)}</b>
              <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
              {canEdit && <button className="btn sm primary" onClick={openRecord}>Record payment…</button>}
            </span>
          )}
        </div>
        {msg && <div className="pay-doc-bar" role="status" style={{ margin: "0 14px 10px" }}><span>{msg}</span><button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setMsg("")}>Dismiss</button></div>}
        <div className="grid-scroll">
          <table className="acct-table pay-cand">
            <thead>
              <tr>
                <th style={{ width: 30 }} /><th>Job No.</th><th>Tour date</th><th>Guide</th><th>Tour</th>
                <th className="r">Payable</th><th className="r">Adjustments</th><th className="r">Amount due</th><th>Accounting month</th><th>Readiness</th><th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && <tr><td colSpan={11} className="op-empty">No jobs in {period} yet.</td></tr>}
              {rows.map((r) => {
                const k = `${r.guideId}|${key(r)}`;
                const otherGuide = !!payingGuide && r.guideId !== payingGuide;
                return (
                  <tr key={k} className={r.eligible ? "" : "pay-cand-blocked"}>
                    <td style={{ textAlign: "center" }}>
                      {canEdit && r.eligible
                        ? <input type="checkbox" checked={picked.has(k)} disabled={otherGuide} onChange={() => toggle(r)}
                            title={otherGuide ? `One transfer pays one guide — clear the selection to pay ${r.guide}` : `Include ${r.jobNo ?? "this job"} in a payment`} />
                        : null}
                    </td>
                    <td className="num">{r.jobNo ?? "—"}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{dShort(r.date)} · {r.time}</td>
                    <td><span className="gid">{r.guideId}</span> {r.guide}</td>
                    <td>{r.tour}</td>
                    <td className="r num">{thb(r.payable)}</td>
                    <td className="r num">{r.adjustments.length ? thb(r.adjustments.reduce((s, a) => s + a.amount, 0)) : "—"}</td>
                    <td className="r num"><b>{thb(r.amountDue)}</b></td>
                    <td className="num">{r.accountingMonth}</td>
                    <td><span className={`chip-readiness ${r.readiness}`}>{r.readiness === "approved" ? "Approved" : r.readiness === "not-approved" ? "Not approved" : "No job sheet"}</span></td>
                    <td>
                      {r.eligible
                        ? <span className="chip-pay unpaid">Unpaid</span>
                        : <span className="chip-pay blocked" title={r.blockedReason ?? ""}>{r.paidBy ?? STATUS_LABEL[r.paymentStatus] ?? r.blockedReason}</span>}
                      {!r.eligible && r.blockedReason && !r.paidBy && <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)" }}>{r.blockedReason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Recorded payments · {period}</h2><span className="hint">{payments.length} payment{payments.length === 1 ? "" : "s"}</span></div>
        <div className="grid-scroll">
          <table className="acct-table">
            <thead><tr><th>Payment</th><th>Guide</th><th>Transfer date</th><th className="r">Amount transferred</th><th className="r">Jobs</th><th>Status</th><th>Recorded</th><th /></tr></thead>
            <tbody>
              {payments.length === 0 && <tr><td colSpan={8} className="op-empty">No guide payments recorded for {period}.</td></tr>}
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.paymentNo}</td>
                  <td><span className="gid">{p.guideId}</span> {p.guide}</td>
                  <td>{p.paymentDate}</td>
                  <td className="r num"><b>{thb(p.amountTransferred)}</b></td>
                  <td className="r num">{p.jobs.length}</td>
                  <td><span className={`chip-pay ${p.status === "REVERSED" ? "reversed" : "recorded"}`}>{p.status === "REVERSED" ? "Reversed" : "Recorded"}</span></td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--ink-soft)", fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
                  <td style={{ textAlign: "right" }}><button className="btn sm" onClick={() => openDetail(p.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {openPayment && (
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) setOpenPayment(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pmt-h" style={{ width: "min(720px, 100%)" }}>
            <h3 id="pmt-h">{openPayment.paymentNo}</h3>
            <div className="mctx">{openPayment.guideId} · {openPayment.guide} · transfer date {openPayment.paymentDate} · accounting month {openPayment.accountingPeriod}</div>
            <div className="mbody" style={{ display: "grid", gap: 12 }}>
              {openPayment.status === "REVERSED" && (
                <div className="pay-drift" role="alert">
                  <b>Reversed{openPayment.reversedAt ? ` on ${new Date(openPayment.reversedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}{openPayment.reversedBy ? ` by ${openPayment.reversedBy}` : ""}</b>
                  <span>Reversal reason: {openPayment.reversalReason}</span>
                </div>
              )}
              <div className="grid-scroll">
                <table className="acct-table pay-review" aria-label="What this payment paid">
                  <thead><tr><th>Job No.</th><th>Tour date</th><th className="r">Guide fee</th><th className="r">WHT</th><th className="r">Reimbursement</th><th className="r">Review</th><th className="r">Amount paid</th><th>PEAK</th></tr></thead>
                  <tbody>
                    {openPayment.jobs.map((j) => (
                      <tr key={j.jobNo + j.date}>
                        <td className="num">{j.jobNo}</td><td>{dShort(j.date)}</td>
                        <td className="r num">{thb(j.feeGross)}</td><td className="r num">{thb(j.wht)}</td>
                        <td className="r num">{thb(j.reimbursement)}</td><td className="r num">{thb(j.reviewReward)}</td>
                        <td className="r num"><b>{thb(j.payable)}</b></td>
                        <td className="num">{j.peakDocumentNo ?? "—"}</td>
                      </tr>
                    ))}
                    {openPayment.adjustments.map((a, i) => (
                      <tr key={`a${i}`}><td>{a.type.replace(/_/g, " ").toLowerCase()}</td><td colSpan={5}>{a.description}</td><td className="r num">{thb(a.amount)}</td><td /></tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={6}>Jobs {thb(openPayment.reconciliation.jobTotal)} · adjustments {thb(openPayment.reconciliation.adjustmentTotal)}</td><td className="r num"><b>{thb(openPayment.reconciliation.amountTransferred)}</b></td><td /></tr>
                  </tfoot>
                </table>
              </div>
              <div className={`pay-recon${openPayment.reconciliation.balanced ? " ok" : ""}`} role="status">
                <span className="paydoc-label">Reconciliation</span>
                <b className="num">{thb(openPayment.reconciliation.jobTotal)} {openPayment.reconciliation.adjustmentTotal < 0 ? "−" : "+"} {thb(Math.abs(openPayment.reconciliation.adjustmentTotal))} = {thb(openPayment.reconciliation.expectedTransfer)}{openPayment.reconciliation.balanced ? " ✓" : ` · transferred ${thb(openPayment.reconciliation.amountTransferred)}`}</b>
              </div>
              <div className="pay-review-facts">
                <div><span className="paydoc-label">Evidence</span><b>{openPayment.slipUrl ? <a href={openPayment.slipUrl} target="_blank" rel="noopener noreferrer">Bank slip</a> : openPayment.noSlipReason ? `No slip — ${openPayment.noSlipReason}` : "No slip"}</b></div>
                <div><span className="paydoc-label">Bank reference</span><b>{openPayment.bankRef ?? "—"}</b></div>
                <div><span className="paydoc-label">Recorded</span><b>{new Date(openPayment.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}{openPayment.createdBy ? ` · ${openPayment.createdBy}` : ""}</b></div>
                <div><span className="paydoc-label">Source</span><b>{openPayment.source.replace(/_/g, " ").toLowerCase()}</b></div>
                {openPayment.mismatchReason && <div><span className="paydoc-label">Difference reason</span><b>{openPayment.mismatchReason}</b></div>}
                {openPayment.periodOverrideReason && <div><span className="paydoc-label">Cross-month reason</span><b>{openPayment.periodOverrideReason}</b></div>}
                {openPayment.note && <div><span className="paydoc-label">Note</span><b>{openPayment.note}</b></div>}
              </div>
            </div>
            <div className="mfoot">
              {canEdit && openPayment.status === "RECORDED" && (
                <button className="btn ghost danger" disabled={busy} style={{ marginRight: "auto" }}
                  onClick={() => reverse(payments.find((p) => p.id === openPayment.id)!)}>Reverse payment…</button>
              )}
              <button className="btn" onClick={() => setOpenPayment(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {payFor && (
        <RecordGuidePaymentDialog
          guideId={payFor.guideId}
          guide={payFor.guide}
          jobs={payFor.jobs}
          preselect={payFor.preselect}
          today={today}
          onClose={() => setPayFor(null)}
          onDone={(m) => { setPayFor(null); setMsg(m); load(period); }}
        />
      )}
    </div>
  );
}
