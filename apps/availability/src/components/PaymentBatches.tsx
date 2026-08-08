"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import OperatorNav from "@/components/OperatorNav";

type BatchRow = { id: string; batchNo: string; status: string; paymentDate: string | null; totalAmount: number; note: string | null; createdAt: string; paidAt: string | null; items: number };
type Item = { id: string; guideId: string; guide: string; date: string; slotIdx: number; tourId: string; tour: string; ref: string | null; guideFee: number; reimbursement: number; totalPayable: number; paymentStatus: string };
type BatchDetail = Omit<BatchRow, "items"> & { items: Item[] };
type Candidate = { date: string; slotIdx: number; time: string; tour: string; ref: string | null; guideFee: number; reimbursement: number; totalPayable: number };
type CandGuide = { guideId: string; guide: string; total: number; jobs: Candidate[] };

// Batch lifecycle → the brief's status colours, on the existing CSS tokens.
const STATUS: Record<string, { bg: string; fg: string }> = {
  PAID: { bg: "var(--ok-bg,#eef7f0)", fg: "var(--green,#2f7d4f)" },
  READY: { bg: "#fdf3e7", fg: "var(--assign,#9c6a14)" },
  PROCESSING: { bg: "#fdf3e7", fg: "var(--assign,#9c6a14)" },
  FAILED: { bg: "var(--danger-bg,#fbece9)", fg: "var(--danger,#c2604a)" },
  DRAFT: { bg: "var(--grey-bg,#f0efe9)", fg: "var(--ink-soft,#6f665b)" },
  CANCELLED: { bg: "var(--grey-bg,#f0efe9)", fg: "var(--ink-soft,#6f665b)" },
};
function Pill({ status }: { status: string }) {
  const s = STATUS[status] ?? STATUS.DRAFT;
  return <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 700, color: s.fg, background: s.bg, borderRadius: 999, padding: "2px 9px", letterSpacing: "0.02em" }}>{status}</span>;
}
const dShort = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const ck = (guideId: string, date: string, slotIdx: number) => `${guideId}|${date}|${slotIdx}`;

export default function PaymentBatches({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<BatchRow[] | null>(null);
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // create panel
  const [creating, setCreating] = useState(false);
  const thisMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const [period, setPeriod] = useState(thisMonth);
  const [cand, setCand] = useState<CandGuide[] | null>(null);
  const [candBusy, setCandBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const r = await fetch("/api/payment-batches", { cache: "no-store" });
    if (r.ok) setRows((await r.json()).rows ?? []); else setMsg("Could not load batches.");
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openDetail(id: string) {
    setBusy(true); setMsg("");
    const r = await fetch(`/api/payment-batches?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    setBusy(false);
    if (r.ok) setDetail((await r.json()).batch); else setMsg("Could not open the batch.");
  }

  async function loadCandidates() {
    setCandBusy(true); setSel(new Set());
    const r = await fetch(`/api/payment-batches/candidates?period=${period}`, { cache: "no-store" });
    setCandBusy(false);
    if (r.ok) setCand((await r.json()).rows ?? []); else setMsg("Could not load payouts.");
  }

  const flatCand: { guideId: string; date: string; slotIdx: number; totalPayable: number }[] =
    (cand ?? []).flatMap((g) => g.jobs.map((j) => ({ guideId: g.guideId, date: j.date, slotIdx: j.slotIdx, totalPayable: j.totalPayable })));
  const selTotal = flatCand.filter((c) => sel.has(ck(c.guideId, c.date, c.slotIdx))).reduce((s, c) => s + c.totalPayable, 0);
  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleGuide = (g: CandGuide) => setSel((s) => {
    const n = new Set(s); const keys = g.jobs.map((j) => ck(g.guideId, j.date, j.slotIdx));
    const allOn = keys.every((k) => n.has(k)); keys.forEach((k) => (allOn ? n.delete(k) : n.add(k))); return n;
  });

  async function createBatch() {
    const items = flatCand.filter((c) => sel.has(ck(c.guideId, c.date, c.slotIdx))).map((c) => ({ guideId: c.guideId, date: c.date, slotIdx: c.slotIdx }));
    if (!items.length) return;
    setBusy(true); setMsg("");
    const r = await fetch("/api/payment-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.error === "no-eligible-items" ? "None of those are eligible (already paid or batched)." : "Couldn't create the batch."); return; }
    setCreating(false); setCand(null); setSel(new Set());
    setMsg(`Batch ${d.batchNo} created · ${d.added} item(s)${d.skipped?.length ? ` · ${d.skipped.length} skipped (already batched)` : ""}.`);
    await load();
  }

  async function patch(id: string, body: Record<string, unknown>, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true); setMsg("");
    const r = await fetch("/api/payment-batches", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...body }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.hint || (d.error === "paid-locked" ? "A paid batch is locked." : "Update failed.")); return; }
    await openDetail(id); await load();
  }

  async function del(id: string, batchNo: string) {
    if (!confirm(`Delete batch ${batchNo}? Its items are released to be batched again. (A paid batch can't be deleted.)`)) return;
    setBusy(true); setMsg("");
    const r = await fetch("/api/payment-batches", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(d.hint || "Delete failed."); return; }
    setDetail(null); setMsg(`Batch ${batchNo} deleted.`); await load();
  }

  return (
    <div className="op-layout">
      <OperatorNav active="payment-batches" />
      <div className="op-main">
        <div className="subtabs"><span className="subtab active">Payment batches</span></div>

        {msg && <div className="panel" style={{ padding: "8px 14px", fontSize: 13, color: "var(--ink-soft)" }}>{msg}</div>}

        {/* ---------- DETAIL ---------- */}
        {detail ? (
          <section className="panel">
            <div className="panel-head" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn sm ghost" onClick={() => setDetail(null)}>← All batches</button>
              <h2 style={{ margin: 0, fontFamily: "monospace" }}>{detail.batchNo}</h2>
              <Pill status={detail.status} />
              <span style={{ marginLeft: "auto", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{thb(detail.totalAmount)}</span>
            </div>
            <div style={{ padding: "0 14px 12px", display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "var(--ink-soft)" }}>
              <span>Payment date: <b style={{ color: "var(--ink)" }}>{detail.paymentDate || "—"}</b></span>
              <span>Items: <b style={{ color: "var(--ink)" }}>{detail.items.length}</b></span>
              {detail.paidAt && <span>Paid: <b style={{ color: "var(--ink)" }}>{new Date(detail.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</b></span>}
            </div>

            {canEdit && detail.status !== "CANCELLED" && (
              <div style={{ padding: "0 14px 12px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {detail.status !== "PAID" && <input type="date" value={detail.paymentDate ?? ""} onChange={(e) => patch(detail.id, { paymentDate: e.target.value || null })} className="peak-ref-in" title="Set the transfer date" />}
                {detail.status === "DRAFT" && <button className="btn sm" disabled={busy} onClick={() => patch(detail.id, { status: "READY" })}>Mark ready</button>}
                {(detail.status === "READY" || detail.status === "FAILED") && <button className="btn sm" disabled={busy} onClick={() => patch(detail.id, { status: "PROCESSING" })}>Start processing</button>}
                {detail.status !== "PAID" && <button className="btn sm primary" disabled={busy} onClick={() => patch(detail.id, { status: "PAID" }, `Mark ${detail.batchNo} PAID? This records ${thb(detail.totalAmount)} as transferred.`)}>Mark paid</button>}
                {detail.status === "PROCESSING" && <button className="btn sm danger" disabled={busy} onClick={() => patch(detail.id, { status: "FAILED" })}>Mark failed</button>}
                {detail.status === "PAID" && <button className="btn sm ghost" disabled={busy} onClick={() => patch(detail.id, { status: "READY" }, "Un-mark this batch as paid?")}>Undo paid</button>}
                {detail.status !== "PAID" && <button className="btn sm danger" disabled={busy} style={{ marginLeft: "auto" }} onClick={() => del(detail.id, detail.batchNo)}>Delete batch</button>}
              </div>
            )}

            <div className="grid-scroll" style={{ padding: "0 8px 12px" }}>
              <table className="acct-table pay-table">
                <thead><tr><th>Guide</th><th>Date</th><th>Tour</th><th>Job No.</th><th style={{ textAlign: "right" }}>Guide fee</th><th style={{ textAlign: "right" }}>Reimburse</th><th style={{ textAlign: "right" }}>Payable</th><th>Status</th>{canEdit && detail.status !== "PAID" && detail.status !== "CANCELLED" && <th />}</tr></thead>
                <tbody>
                  {detail.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.guide}</td>
                      <td>{dShort(it.date)}</td>
                      <td>{it.tour}</td>
                      <td style={{ fontFamily: "monospace", fontSize: 12 }}>{it.ref || "—"}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{thb(it.guideFee)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{thb(it.reimbursement)}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(it.totalPayable)}</td>
                      <td><Pill status={it.paymentStatus} /></td>
                      {canEdit && detail.status !== "PAID" && detail.status !== "CANCELLED" && <td><button className="btn sm danger" title="Remove from this batch (frees it to be batched again)" disabled={busy} onClick={() => patch(detail.id, { removeItemId: it.id }, "Remove this payout from the batch?")}>×</button></td>}
                    </tr>
                  ))}
                  <tr className="js-total"><td colSpan={6} style={{ textAlign: "right" }}>Total payable</td><td style={{ textAlign: "right" }}><b>{thb(detail.totalAmount)}</b></td><td colSpan={canEdit && detail.status !== "PAID" && detail.status !== "CANCELLED" ? 2 : 1} /></tr>
                </tbody>
              </table>
            </div>
          </section>
        ) : creating ? (
          /* ---------- CREATE ---------- */
          <section className="panel">
            <div className="panel-head" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn sm ghost" onClick={() => { setCreating(false); setCand(null); }}>← Cancel</button>
              <h2 style={{ margin: 0 }}>New payment batch</h2>
            </div>
            <div style={{ padding: "0 14px 12px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ fontSize: 13, color: "var(--ink-soft)" }}>Month</label>
              <input type="month" value={period} max={thisMonth} onChange={(e) => setPeriod(e.target.value)} className="peak-ref-in" />
              <button className="btn sm" disabled={candBusy} onClick={loadCandidates}>{candBusy ? "…" : "Load unpaid payouts"}</button>
              {cand && <span style={{ marginLeft: "auto", fontSize: 13 }}>{sel.size} selected · <b>{thb(selTotal)}</b></span>}
            </div>
            {cand && (cand.length === 0 ? (
              <div className="op-empty" style={{ padding: 20 }}>No unpaid, un-batched payouts in {period}.</div>
            ) : (
              <div className="grid-scroll" style={{ padding: "0 8px 12px" }}>
                {cand.map((g) => {
                  const keys = g.jobs.map((j) => ck(g.guideId, j.date, j.slotIdx));
                  const allOn = keys.every((k) => sel.has(k));
                  return (
                    <div key={g.guideId} style={{ marginBottom: 10, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--grey-bg,#f0efe9)", padding: "6px 10px" }}>
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700, cursor: "pointer" }}>
                          <input type="checkbox" checked={allOn} onChange={() => toggleGuide(g)} /> {g.guide}
                        </label>
                        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(g.total)}</span>
                      </div>
                      <table className="acct-table" style={{ margin: 0 }}>
                        <tbody>
                          {g.jobs.map((j) => { const k = ck(g.guideId, j.date, j.slotIdx); return (
                            <tr key={k} style={{ cursor: "pointer" }} onClick={() => toggle(k)}>
                              <td style={{ width: 30 }}><input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} onClick={(e) => e.stopPropagation()} /></td>
                              <td>{dShort(j.date)} · {j.time}</td>
                              <td>{j.tour}</td>
                              <td style={{ fontFamily: "monospace", fontSize: 12 }}>{j.ref || "—"}</td>
                              <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(j.totalPayable)}</td>
                            </tr>
                          ); })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            ))}
            <div style={{ padding: "0 14px 14px", display: "flex" }}>
              <button className="btn primary" style={{ marginLeft: "auto" }} disabled={busy || sel.size === 0} onClick={createBatch}>{busy ? "…" : `Create batch (${sel.size} · ${thb(selTotal)})`}</button>
            </div>
          </section>
        ) : (
          /* ---------- LIST ---------- */
          <section className="panel">
            <div className="panel-head"><h2>Payment batches</h2>{canEdit && <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => { setCreating(true); setCand(null); setSel(new Set()); }}>+ New batch</button>}</div>
            {rows == null ? <div style={{ padding: 14 }}>{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel-row" />)}</div>
              : rows.length === 0 ? <div className="op-empty" style={{ padding: 20 }}>No payment batches yet. Create one to group guide payouts into a single transfer run.</div>
              : (
                <div className="grid-scroll" style={{ padding: "0 8px 12px" }}>
                  <table className="acct-table pay-table">
                    <thead><tr><th>Batch No.</th><th>Payment date</th><th style={{ textAlign: "right" }}>Items</th><th style={{ textAlign: "right" }}>Total</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {rows.map((b) => (
                        <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => openDetail(b.id)}>
                          <td style={{ fontFamily: "monospace" }}>{b.batchNo}</td>
                          <td>{b.paymentDate || "—"}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{b.items}</td>
                          <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{thb(b.totalAmount)}</td>
                          <td><Pill status={b.status} /></td>
                          <td><button className="btn sm" onClick={(e) => { e.stopPropagation(); openDetail(b.id); }}>View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>
        )}
      </div>
    </div>
  );
}
