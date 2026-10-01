"use client";
import { useCallback, useEffect, useState } from "react";
import { explain } from "./AdvanceOperations";
import { thb } from "@/lib/jobsheet";
import type { RefundReview } from "@/lib/advances/refund-review";

// The accountant's view of advance refunds (owner policy 2026-10-01: approve only). Each card
// carries the evidence lib/advances/refund-review assembles — the refund, the return it pays
// back, the advance(s) that return cleared, bank references, slips, who did what, PEAK state —
// so approving never needs the operational job sheet. The server still decides
// (app/api/advances/refunds/[id]/approve): the recorder cannot approve their own.
type Row = Omit<RefundReview, "paidAt" | "recordedAt" | "approvedAt" | "history"> & {
  paidAt: string | null; recordedAt: string; approvedAt: string | null;
  history: { action: string; by: string | null; role: string | null; at: string }[];
};
const when = (s: string | null) => (s ? new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }) : "—");
const STATUS: Record<string, string> = { RECORDED: "Waiting for approval", APPROVED: "Approved — waiting to be paid", PAID: "Paid", VOIDED: "Voided" };

export default function RefundReviewPanel({ userId }: { userId: string | null }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/advances/refunds");
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(explain(r.status, d)); setRows([]); return; }
    setRows(d.refunds ?? []); setFrozen(d.frozen === true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const approve = async (f: Row) => {
    if (!confirm(`Approve ${f.refundNo}: ${thb(f.amount)} back to ${f.guide.guideId}?`)) return;
    setBusy(true); setMsg("");
    const r = await fetch(`/api/advances/refunds/${f.id}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? `${f.refundNo} approved ✓` : explain(r.status, d));
    await load(); setBusy(false);
  };

  if (!rows) return <div className="muted">…</div>;
  return (
    <div className="js-refund-review" style={{ display: "grid", gap: 10 }}>
      <h3 style={{ margin: "6px 0 0" }}>Advance refunds to review <small className="muted" style={{ fontWeight: 500 }}>เงินคืนเกินที่ต้องคืน — ตรวจและอนุมัติ</small></h3>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>An operator records a refund of money a guide sent back beyond what they owed; you check the evidence and approve it; an operator then pays it. Approving moves no money and changes no balance.</p>
      {frozen && <div className="banner js-advance-frozen" role="status">Advance writes are currently frozen — approval is unavailable until the advance workflow is switched on.</div>}
      {msg && <div className="banner js-refund-review-msg" role="status">{msg}</div>}
      {!rows.length && <div className="muted">No refunds.</div>}
      {rows.map((f) => {
        const mine = !!userId && userId === f.recordedById;
        return (
          <div key={f.id} className="panel js-refund-review-card" data-refund={f.refundNo} data-status={f.status} style={{ padding: 12, display: "grid", gap: 6, fontSize: 13 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <b className="mono">{f.refundNo}</b> <b>{thb(f.amount)}</b>
              <span className="badge js-review-status">{STATUS[f.status] ?? f.status}</span>
              <span className="muted">to {f.guide.guideId}{f.guide.name ? ` · ${f.guide.name}` : ""}</span>
            </div>
            <div className="js-review-reason">Reason: {f.reason}</div>
            <div className="js-review-job">Job: {f.job ? `${f.job.ref ?? "no job number"} · ${f.job.date}` : "—"}</div>
            <div className="js-review-return">
              Return <span className="mono">{f.receipt.receiptNo}</span> ({f.receipt.status === "VERIFIED" ? "confirmed in the bank" : f.receipt.status.toLowerCase()}, {f.receipt.receivedDate}) · Amount {thb(f.receipt.amount)} · Allocated {thb(f.receipt.allocated)} · Refunded {thb(f.receipt.refunded)} · Unallocated {thb(f.receipt.unallocated)}
              {f.receipt.bankRef ? <> · bank ref <span className="mono">{f.receipt.bankRef}</span></> : null}
              {f.receipt.slipUrl ? <> · <a className="js-review-return-slip" href={f.receipt.slipUrl} target="_blank" rel="noopener noreferrer">📎 Return slip</a></> : null}
              {f.receipt.peak ? <> · PEAK {f.receipt.peak.status.toLowerCase()}{f.receipt.peak.documentNo ? ` ${f.receipt.peak.documentNo}` : ""}</> : null}
            </div>
            {f.advances.map((a) => (
              <div key={a.advanceNo} className="js-review-advance">
                Advance <span className="mono">{a.advanceNo}</span> · Issued {thb(a.issued)} · Used {thb(a.used)} · Returned {thb(a.returned)}{a.deducted ? ` · Deducted ${thb(a.deducted)}` : ""} · Outstanding {thb(a.outstanding)} · {a.status ?? "needs review"}
                {a.allocatedFromThisReturn ? ` · ${thb(a.allocatedFromThisReturn)} of it from this return` : ""}
                {a.slipUrl ? <> · <a href={a.slipUrl} target="_blank" rel="noopener noreferrer">📎 Advance slip</a></> : null}
                {a.peak ? <> · PEAK {a.peak.status.toLowerCase()}{a.peak.documentNo ? ` ${a.peak.documentNo}` : ""}</> : null}
              </div>
            ))}
            {(f.bankRef || f.slipUrl) && (
              <div className="js-review-payment">Paid {when(f.paidAt)}{f.paidBy ? ` by ${f.paidBy}` : ""}{f.bankRef ? <> · bank ref <span className="mono">{f.bankRef}</span></> : null}{f.slipUrl ? <> · <a className="js-review-refund-slip" href={f.slipUrl} target="_blank" rel="noopener noreferrer">📎 Refund slip</a></> : null}</div>
            )}
            {f.voidReason && <div>Voided: {f.voidReason}</div>}
            <ol className="js-review-history muted" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
              {f.history.map((h, i) => <li key={i}>{h.action} by {h.by ?? "—"}{h.role ? ` (${h.role.toLowerCase()})` : ""} · {when(h.at)}</li>)}
            </ol>
            {f.status === "RECORDED" && (mine
              ? <div className="js-refund-own muted">You recorded this refund — another person must approve it.</div>
              : <div><button className="btn sm primary js-review-approve" disabled={busy || frozen} onClick={() => void approve(f)}>Approve refund</button></div>)}
          </div>
        );
      })}
    </div>
  );
}
