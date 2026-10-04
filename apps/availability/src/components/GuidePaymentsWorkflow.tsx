"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import RecordGuidePaymentDialog, { type PayableJob } from "@/components/RecordGuidePaymentDialog";
import ColumnFilter, { applyColumnFilters, columnValues, type ColumnFilters } from "@/components/ColumnFilter";

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
  kind?: string; supplements?: { typeLabel: string; netAmount: number }[];
};
type SupplementLine = { supplementalId: string; typeLabel: string; accountingCategory: string; grossAmount: number; wht: number; netAmount: number; active: boolean; reason: string; jobs: string[]; originalPaymentNo: string | null };
type Detail = {
  id: string; paymentNo: string; status: string; source: string; guide: string; guideId: string; paymentDate: string; accountingPeriod: string;
  kind?: string;
  reconciliation: { jobTotal: number; supplementTotal?: number; adjustmentTotal: number; expectedTransfer: number; amountTransferred: number; difference: number; balanced: boolean };
  bankRef: string | null; slipUrl: string | null; noSlipReason: string | null; mismatchReason: string | null; periodOverrideReason: string | null;
  note: string | null; createdAt: string; createdBy: string | null; reversedAt: string | null; reversedBy: string | null; reversalReason: string | null;
  jobs: { jobNo: string; date: string; slotIdx: number; payable: number; feeGross: number; wht: number; reimbursement: number; reviewReward: number; peakDocumentNo: string | null; active: boolean }[];
  adjustments: { type: string; amount: number; description: string; jobNo: string | null }[];
  transfers?: { seq: number; amount: number; date: string; bankRef: string | null; slipUrl: string | null }[];
  supplements?: SupplementLine[];
};

/** "Guide payment", or "Supplemental · Review incentive" — a supplemental transfer is never read as part of the job payment it followed. */
const paymentKindLabel = (p: { kind?: string; supplements?: { typeLabel: string }[] }) =>
  p.kind === "SUPPLEMENTAL" ? `Supplemental · ${[...new Set((p.supplements ?? []).map((x) => x.typeLabel))].join(", ") || "extra payment"}` : "Guide payment";

const key = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const dShort = (d: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
const thisMonth = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
const STATUS_LABEL: Record<string, string> = { unpaid: "Unpaid", paid: "Paid", "legacy-paid": "Paid · no payment record", "payroll-paid": "Paid by payroll" };
const READINESS_LABEL: Record<string, string> = { approved: "Approved", "not-approved": "Not approved" };

// What each ☰ filter compares — the text the column shows.
const CANDIDATE_COLS: Record<string, (r: Candidate) => string> = {
  jobNo: (r) => r.jobNo ?? "—",
  date: (r) => dShort(r.date),
  guide: (r) => `${r.guideId} ${r.guide}`,
  tour: (r) => r.tour,
  month: (r) => r.accountingMonth,
  readiness: (r) => READINESS_LABEL[r.readiness] ?? "No job sheet",
  payment: (r) => (r.eligible ? "Unpaid" : r.paidBy ? "Paid" : STATUS_LABEL[r.paymentStatus] ?? "Blocked"),
};
const PAYMENT_COLS: Record<string, (p: PaymentRow) => string> = {
  payment: (p) => paymentKindLabel(p),
  guide: (p) => `${p.guideId} ${p.guide}`,
  date: (p) => p.paymentDate,
  status: (p) => (p.status === "REVERSED" ? "Reversed" : "Recorded"),
};

export default function GuidePaymentsWorkflow({ canEdit, isAdmin = false }: { canEdit: boolean; isAdmin?: boolean }) {
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
  const [candF, setCandF] = useState<ColumnFilters>({});
  const [payF, setPayF] = useState<ColumnFilters>({});
  // Correcting a payment recorded as one transfer that was really several (ADMIN only).
  const [fix, setFix] = useState<{ recorded: string; amount: string; date: string; bankRef: string; file: File | null; reason: string; error: string } | null>(null);

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

  async function addMissingTransfer(d: Detail) {
    if (!fix) return;
    setBusy(true);
    const form = new FormData();
    form.set("payload", JSON.stringify({
      recordedAmount: Number(fix.recorded), reason: fix.reason,
      added: [{ amount: Number(fix.amount), date: fix.date, bankRef: fix.bankRef.trim() || null }],
    }));
    if (fix.file) form.set("file_0", fix.file);
    const r = await fetch(`/api/guide-payments/${d.id}/transfers`, { method: "POST", body: form });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok || !j.ok) { setFix({ ...fix, error: (j.reasons ?? []).join("\n") || `Couldn't add the transfer (${r.status}).` }); return; }
    setFix(null);
    setMsg(
      `${j.paymentNo} is now ${j.transfers.length} transfers: ${j.transfers.map((x: { amount: number; date: string }) => `${thb(x.amount)} on ${x.date}`).join(" + ")}.` +
      (j.peak?.error ? ` PEAK: ${j.peak.error}.` : j.peak?.attached ? ` Slip attached to ${j.peak.documentNo} in PEAK.` : "") +
      (j.notified ? " The guide was told the rest has arrived." : "")
    );
    await openDetail(d.id);
    load(period);
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
    const reopened = (d.advancesReopened ?? []) as { advanceNo: string; amount: number }[];
    setMsg(
      `Payment ${d.paymentNo} reversed. ${unpaid} job${unpaid === 1 ? "" : "s"} unpaid again.` +
      (held.length ? ` ${held.length} job${held.length === 1 ? "" : "s"} remain${held.length === 1 ? "s" : ""} paid because ${held.length === 1 ? "it belongs" : "they belong"} to another active payment: ${held.map((h) => `${h.jobNo} (${h.paymentNo})`).join(", ")}.` : "") +
      (reopened.length ? ` Advance balance given back: ${reopened.map((a) => `${a.advanceNo} +${thb(a.amount)}`).join(", ")}.` : "")
    );
    setOpenPayment(null);
    load(period);
  }

  const eligible = rows.filter((r) => r.eligible).length;
  const shownRows = applyColumnFilters(rows, candF, CANDIDATE_COLS);
  const shownPayments = applyColumnFilters(payments, payF, PAYMENT_COLS);
  const candFiltering = Object.values(candF).some(Boolean);
  const payFiltering = Object.values(payF).some(Boolean);
  const candHead = (k: string, label: string) => <ColumnFilter label={label} values={columnValues(rows, CANDIDATE_COLS[k])} selected={candF[k] ?? null} onChange={(v) => setCandF((f) => ({ ...f, [k]: v }))} />;
  const payHead = (k: string, label: string) => <ColumnFilter label={label} values={columnValues(payments, PAYMENT_COLS[k])} selected={payF[k] ?? null} onChange={(v) => setPayF((f) => ({ ...f, [k]: v }))} />;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="panel">
        <div className="op-toolbar" style={{ gap: 10 }}>
          <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-soft)" }}>Accounting month</label>
          <input className="search" style={{ flex: "none", width: 160 }} type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>{loading ? "Loading…" : `${eligible} job${eligible === 1 ? "" : "s"} waiting for a transfer`}{candFiltering ? ` · showing ${shownRows.length} of ${rows.length}` : ""}</span>
          {candFiltering && <button className="btn sm ghost js-clear-cand-filters" onClick={() => setCandF({})}>✕ Clear filters</button>}
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
                <th style={{ width: 30 }} /><th>{candHead("jobNo", "Job No.")}</th><th>{candHead("date", "Tour date")}</th><th>{candHead("guide", "Guide")}</th><th>{candHead("tour", "Tour")}</th>
                <th className="r">Payable</th><th className="r">Adjustments</th><th className="r">Amount due</th><th>{candHead("month", "Accounting month")}</th><th>{candHead("readiness", "Readiness")}</th><th>{candHead("payment", "Payment")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && <tr><td colSpan={11} className="op-empty">No jobs in {period} yet.</td></tr>}
              {rows.length > 0 && shownRows.length === 0 && <tr><td colSpan={11} className="op-empty">No job matches the filters.</td></tr>}
              {shownRows.map((r) => {
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
        <div className="panel-head"><h2>Recorded payments · {period}</h2><span className="hint">{payFiltering ? `${shownPayments.length} of ${payments.length}` : payments.length} payment{payments.length === 1 ? "" : "s"}</span>
          {payFiltering && <button className="btn sm ghost js-clear-pay-filters" style={{ marginLeft: "auto" }} onClick={() => setPayF({})}>✕ Clear filters</button>}</div>
        <div className="grid-scroll">
          <table className="acct-table">
            <thead><tr><th>{payHead("payment", "Payment")}</th><th>{payHead("guide", "Guide")}</th><th>{payHead("date", "Transfer date")}</th><th className="r">Amount transferred</th><th className="r">Jobs</th><th>{payHead("status", "Status")}</th><th>Recorded</th><th /></tr></thead>
            <tbody>
              {payments.length === 0 && <tr><td colSpan={8} className="op-empty">No guide payments recorded for {period}.</td></tr>}
              {payments.length > 0 && shownPayments.length === 0 && <tr><td colSpan={8} className="op-empty">No payment matches the filters.</td></tr>}
              {shownPayments.map((p) => (
                <tr key={p.id}>
                  <td className="num">{p.paymentNo}<small style={{ display: "block", fontSize: 11, color: p.kind === "SUPPLEMENTAL" ? "var(--primary)" : "var(--ink-soft)", fontWeight: p.kind === "SUPPLEMENTAL" ? 600 : 400 }}>{paymentKindLabel(p)}</small></td>
                  <td><span className="gid">{p.guideId}</span> {p.guide}</td>
                  <td>{p.paymentDate}</td>
                  <td className="r num"><b>{thb(p.amountTransferred)}</b></td>
                  <td className="r num">{p.kind === "SUPPLEMENTAL" ? "—" : p.jobs.length}</td>
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
        <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) { setFix(null); setOpenPayment(null); } }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pmt-h" style={{ width: "min(720px, 100%)" }}>
            <h3 id="pmt-h">{openPayment.paymentNo}</h3>
            <div className="mctx">{paymentKindLabel(openPayment)} · {openPayment.guideId} · {openPayment.guide} · transfer date {openPayment.paymentDate} · accounting month {openPayment.accountingPeriod}</div>
            <div className="mbody" style={{ display: "grid", gap: 12 }}>
              {openPayment.status === "REVERSED" && (
                <div className="pay-drift" role="alert">
                  <b>Reversed{openPayment.reversedAt ? ` on ${new Date(openPayment.reversedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}{openPayment.reversedBy ? ` by ${openPayment.reversedBy}` : ""}</b>
                  <span>Reversal reason: {openPayment.reversalReason}</span>
                </div>
              )}
              {(openPayment.transfers ?? []).length > 0 && (
                <div className="js-payment-transfers">
                  <span className="paydoc-label">Paid in {openPayment.transfers!.length} transfers · โอนหลายครั้ง</span>
                  <table className="acct-table" aria-label="The bank transfers of this payment">
                    <thead><tr><th>#</th><th>Date</th><th>Bank reference</th><th>Slip</th><th className="r">Amount</th></tr></thead>
                    <tbody>{openPayment.transfers!.map((x) => (
                      <tr key={x.seq}><td>{x.seq}</td><td>{x.date}</td><td className="num">{x.bankRef ?? "—"}</td>
                        <td>{x.slipUrl ? <a href={x.slipUrl} target="_blank" rel="noopener noreferrer">Slip</a> : "—"}</td><td className="r num">{thb(x.amount)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {openPayment.kind === "SUPPLEMENTAL" ? (
              <div className="grid-scroll">
                <table className="acct-table pay-review" aria-label="What this supplemental payment paid">
                  <thead><tr><th>Type</th><th>Reason</th><th>Related</th><th className="r">Gross</th><th className="r">WHT</th><th className="r">Amount paid</th></tr></thead>
                  <tbody>
                    {(openPayment.supplements ?? []).map((x) => (
                      <tr key={x.supplementalId}>
                        <td>{x.typeLabel}<small style={{ display: "block", color: "var(--ink-soft)" }}>{x.accountingCategory}</small></td>
                        <td>{x.reason}</td>
                        <td className="num" style={{ fontSize: 12 }}>{[...x.jobs, ...(x.originalPaymentNo ? [`omitted from ${x.originalPaymentNo}`] : [])].join(" · ") || "guide-level"}</td>
                        <td className="r num">{thb(x.grossAmount)}</td><td className="r num">{thb(x.wht)}</td><td className="r num"><b>{thb(x.netAmount)}</b></td>
                      </tr>
                    ))}
                    {openPayment.adjustments.map((a, i) => (
                      <tr key={`a${i}`}><td>{a.type.replace(/_/g, " ").toLowerCase()}</td><td colSpan={4}>{a.description}</td><td className="r num">{thb(a.amount)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={5}>Separate from any earlier payment to this guide — no earlier transfer was changed.</td><td className="r num"><b>{thb(openPayment.reconciliation.amountTransferred)}</b></td></tr>
                  </tfoot>
                </table>
              </div>
              ) : (
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
              )}
              <div className={`pay-recon${openPayment.reconciliation.balanced ? " ok" : ""}`} role="status">
                <span className="paydoc-label">Reconciliation</span>
                <b className="num">{thb(openPayment.reconciliation.jobTotal + (openPayment.reconciliation.supplementTotal ?? 0))} {openPayment.reconciliation.adjustmentTotal < 0 ? "−" : "+"} {thb(Math.abs(openPayment.reconciliation.adjustmentTotal))} = {thb(openPayment.reconciliation.expectedTransfer)}{openPayment.reconciliation.balanced ? " ✓" : ` · transferred ${thb(openPayment.reconciliation.amountTransferred)}`}</b>
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
              {fix && (
                <div className="js-missing-transfer" style={{ display: "grid", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 12 }} aria-label="Add the missing transfer">
                  <b>Add the missing transfer · เพิ่มยอดโอนที่ขาด</b>
                  <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                    For a payment recorded as {thb(openPayment.reconciliation.amountTransferred)} in one transfer when the bank sent less, and the rest went later.
                    Jobs, WHT, the payment date and the PEAK document stay exactly as they are — only the transfers and their slips are recorded.
                  </span>
                  <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">The recorded slip ({openPayment.bankRef ?? "no reference"}) really shows ฿</span>
                    <input name="recorded" inputMode="decimal" value={fix.recorded} onChange={(e) => setFix({ ...fix, recorded: e.target.value, error: "" })} placeholder="฿ ยอดในสลิปเดิม" /></label>
                  <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                    <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">Missing transfer ฿</span>
                      <input name="amount" inputMode="decimal" value={fix.amount} onChange={(e) => setFix({ ...fix, amount: e.target.value, error: "" })} placeholder="฿ ยอดโอน" /></label>
                    <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">Date sent</span>
                      <input name="date" type="date" value={fix.date} onChange={(e) => setFix({ ...fix, date: e.target.value, error: "" })} /></label>
                    <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">Bank reference</span>
                      <input name="bankRef" value={fix.bankRef} onChange={(e) => setFix({ ...fix, bankRef: e.target.value, error: "" })} /></label>
                  </div>
                  <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">Its bank slip</span>
                    <input name="slip" type="file" accept="image/*,application/pdf" onChange={(e) => setFix({ ...fix, file: e.target.files?.[0] ?? null, error: "" })} /></label>
                  <label style={{ display: "grid", gap: 4 }}><span className="paydoc-label">What happened</span>
                    <textarea name="reason" rows={2} style={{ font: "inherit" }} value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value, error: "" })} placeholder="e.g. first transfer was ฿100, not ฿1,000; the rest sent later" /></label>
                  {(() => {
                    const sum = (Number(fix.recorded) || 0) + (Number(fix.amount) || 0);
                    const ok = Math.round(sum * 100) === Math.round(openPayment.reconciliation.amountTransferred * 100);
                    return <div className={`pay-recon${ok ? " ok" : ""}`} role="status"><b className="num">{thb(Number(fix.recorded) || 0)} + {thb(Number(fix.amount) || 0)} = {thb(sum)}{ok ? " ✓" : ` · must be ${thb(openPayment.reconciliation.amountTransferred)}`}</b></div>;
                  })()}
                  {fix.error && <div className="pay-drift" role="alert" style={{ whiteSpace: "pre-line" }}>{fix.error}</div>}
                </div>
              )}
            </div>
            <div className="mfoot">
              {isAdmin && openPayment.status === "RECORDED" && !(openPayment.transfers ?? []).length && (
                fix ? (
                  <>
                    <button className="btn ghost" disabled={busy} onClick={() => setFix(null)}>Cancel</button>
                    <button className="btn primary js-add-transfer-submit" disabled={busy || !fix.file} onClick={() => addMissingTransfer(openPayment)}>{busy ? "Saving…" : "Add transfer"}</button>
                  </>
                ) : (
                  <button className="btn ghost js-add-missing-transfer" disabled={busy}
                    onClick={() => { setFix({ recorded: "", amount: "", date: "", bankRef: "", file: null, reason: "", error: "" }); setTimeout(() => document.querySelector(".js-missing-transfer")?.scrollIntoView({ block: "start" }), 50); }}>Add the missing transfer…</button>
                )
              )}
              {canEdit && openPayment.status === "RECORDED" && !fix && (
                <button className="btn ghost danger" disabled={busy} style={{ marginRight: "auto" }}
                  onClick={() => reverse(payments.find((p) => p.id === openPayment.id)!)}>Reverse payment…</button>
              )}
              <button className="btn" onClick={() => { setFix(null); setOpenPayment(null); }}>Close</button>
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
