"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPENSE_CATEGORIES, thb } from "@/lib/jobsheet";
import { leftOutWarning } from "@/lib/peak-payment-document";

// "Pay N jobs together · one ref", stage 1: create ONE PEAK expense document.
//
// Creating the expense document is not the same thing as paying it. This dialog only
// creates the unpaid document and shows its EXP number; the operator reviews it in
// PEAK and records the actual payment later (RecordPaymentDialog). So there is no
// payment date, no Paid By account and no slip here — nothing is being paid.
//
// The operator sees the exact document PEAK will receive, line by line, before it is
// created; the preview only reads.
//
// `alreadyPaid`: the same two steps for jobs whose money moved before any PEAK document
// existed ("Put paid jobs in PEAK"). The payment recorded next is that transfer — its
// date and its saved slip — and the jobs stay paid as they were.

export type PayTogetherJob = { date: string; slotIdx: number; tour: string; ref?: string | null; amount: number };

/** A created document, as the Payments page and RecordPaymentDialog know it. */
export type CreatedDocument = {
  paymentRef: string;
  documentNo: string;
  documentLink: string | null;
  gross: number;
  wht: number;
  total: number;
  lineCount: number;
  jobs: { date: string; slotIdx: number; ref: string; payout: number }[];
  /** Jobs paid before the document existed: the payment to record is the transfer made on paidDate. */
  alreadyPaid?: boolean;
  paidDate?: string | null;
  hasSavedSlip?: boolean;
};

type Line = { description: string; jobRef: string; kind: string; category: string | null; accountCode: string; price: number; wht: number; net?: number };

/** The line's expense type in words: Guide fee, Review reward, or the reimbursed category. */
const lineType = (l: Line) => l.kind === "GUIDE_FEE" ? "Guide fee" : l.kind === "REVIEW_REWARD" ? "Review reward" : `Reimbursement${l.category ? ` · ${EXPENSE_CATEGORIES.find((c) => c.code === l.category)?.label ?? l.category}` : ""}`;
// A billed row with no expense category (lib/peak-payment-document MissingCategoryRow).
type MissingCategory = { jobRef: string; date: string; slotIdx: number; rowNo: number; description: string; amount: number };
type Preview = { ok: true; lines: Line[]; gross: number; wht: number; total: number; hasSlip?: boolean } | { ok: false; reasons: string[]; missingCategories?: MissingCategory[] };
type Outcome =
  | ({ kind: "created"; recordError: string | null; existing: boolean } & CreatedDocument)
  | { kind: "uncertain"; paymentRef: string; reasons: string[] }
  | { kind: "failed"; reasons: string[] };

const keyOf = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function PeakPaymentDialog({ guideId, guide, jobs, alreadyPaid, onClose, onDone, onRecordPayment }: {
  guideId: string;
  guide: string;
  jobs: PayTogetherJob[];
  /** Jobs already paid on this day, put into PEAK afterwards. */
  alreadyPaid?: { paidDate: string };
  onClose: () => void;   // nothing changed
  onDone: () => void;    // something may have changed — the caller reloads Payments
  /** Open the payment dialog for the document just created. */
  onRecordPayment: (doc: CreatedDocument) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(jobs.map(keyOf)));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const seq = useRef(0);

  const selected = jobs.filter((j) => picked.has(keyOf(j)));
  const selectedKeys = selected.map(keyOf).join(",");
  const selectedTotal = Math.round(selected.reduce((s, j) => s + j.amount, 0) * 100) / 100;

  // Re-preview whenever the selection changes. A slower, older answer must never
  // overwrite a newer one.
  useEffect(() => {
    if (!selected.length) { setPreview({ ok: false, reasons: ["Select at least one job"] }); return; }
    const mine = ++seq.current;
    setPreview(null);
    fetch("/api/pay/peak-document/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId, jobs: selected.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), ...(alreadyPaid ? { alreadyPaid: true } : {}) }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (mine !== seq.current) return;
        if (!r.ok) setPreview({ ok: false, reasons: [d.error === "forbidden" ? "Operator only" : `Could not build the preview (${r.status})`] });
        else setPreview(d.ok ? { ok: true, lines: d.lines, gross: d.gross, wht: d.wht, total: d.total, hasSlip: d.hasSlip } : { ok: false, reasons: d.reasons ?? ["Not payable"], missingCategories: Array.isArray(d.missingCategories) ? d.missingCategories : [] });
      })
      .catch(() => { if (mine === seq.current) setPreview({ ok: false, reasons: ["Could not reach the server"] }); });
    // selectedKeys stands in for `selected`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideId, selectedKeys, !!alreadyPaid]);

  const close = useCallback(() => {
    if (busy) return; // never abandon a document mid-flight
    if (outcome) onDone(); else onClose();
  }, [busy, outcome, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const mismatch = preview?.ok && Math.abs(preview.total - selectedTotal) > 0.005;
  const created = outcome?.kind === "created";
  const locked = busy || created || outcome?.kind === "uncertain";
  const canCreate = !locked && selected.length > 0 && !!preview?.ok && !mismatch;

  async function create() {
    if (!canCreate) return;
    setBusy(true); setOutcome(null);
    let r: Response | null = null;
    let d: Record<string, unknown> = {};
    try {
      r = await fetch("/api/pay/peak-document", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ guideId, jobs: selected.map((j) => ({ date: j.date, slotIdx: j.slotIdx })), ...(alreadyPaid ? { alreadyPaid: true } : {}) }),
      });
      d = await r.json().catch(() => ({}));
    } catch {
      // The request may have reached the server. Say so — pressing again is refused by
      // the lock anyway, but the operator should look first.
      setOutcome({ kind: "uncertain", paymentRef: "", reasons: ["The connection dropped before the server answered. Reload Payments and check whether these jobs show a PEAK document before trying again."] });
      setBusy(false);
      return;
    }
    setBusy(false);
    const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
    if (r.ok && d.ok && d.documentNo) {
      setOutcome({
        kind: "created", existing: !!d.existing,
        paymentRef: String(d.paymentRef), documentNo: String(d.documentNo), documentLink: (d.documentLink as string) ?? null,
        gross: Number(d.gross), wht: Number(d.wht), total: Number(d.total), lineCount: Number(d.lineCount),
        jobs: (d.jobs as CreatedDocument["jobs"]) ?? [], recordError: (d.recordError as string) ?? null,
        ...(d.alreadyPaid ? { alreadyPaid: true, paidDate: (d.paidDate as string) ?? alreadyPaid?.paidDate ?? null, hasSavedSlip: preview?.ok ? !!preview.hasSlip : undefined } : {}),
      });
    } else if (d.error === "peak-uncertain") {
      setOutcome({ kind: "uncertain", paymentRef: String(d.paymentRef ?? ""), reasons });
    } else {
      setOutcome({ kind: "failed", reasons: reasons.length ? reasons : [d.error === "forbidden" ? "Operator only" : `The document was not created (${r.status})`] });
    }
  }

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="paydoc-h" style={{ width: "min(720px, 100%)" }}>
        <h3 id="paydoc-h">{created ? "PEAK document created" : alreadyPaid ? `Put ${selected.length} paid job${selected.length === 1 ? "" : "s"} in one PEAK document` : `Create one PEAK document · ${selected.length} job${selected.length === 1 ? "" : "s"}`}</h3>
        <div className="mctx">{guideId} · {guide} · {alreadyPaid ? `paid ${dShort(alreadyPaid.paidDate)} · step 1 of 2: the document. That payment is recorded against it next.` : "step 1 of 2: the document. The payment is recorded against it afterwards."}</div>

        <div className="mbody" style={{ display: "grid", gap: 14 }}>
          {outcome?.kind === "created" ? (
            <CreatedState doc={outcome} onRecordPayment={() => onRecordPayment(outcome)} />
          ) : (
            <>
              {alreadyPaid && (
                <Note tone="warn">
                  <b>Check PEAK first.</b> These jobs were paid on {dShort(alreadyPaid.paidDate)} with no PEAK document in FolkOPS. If someone already made one for this transfer by hand in PEAK, close this and use <b>Record EXP…</b> instead — creating another makes two documents for one payment.
                </Note>
              )}
              <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
                <legend className="paydoc-label">Jobs in this document</legend>
                {jobs.map((j) => {
                  const k = keyOf(j);
                  return (
                    <label key={k} className="paydoc-job">
                      <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
                      <span style={{ minWidth: 96 }}>{dShort(j.date)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        {j.tour}
                        <span className="paydoc-ref">{j.ref ?? "no job sheet number"}</span>
                      </span>
                      <b className="num">{thb(j.amount)}</b>
                    </label>
                  );
                })}
              </fieldset>
              {!alreadyPaid && leftOutWarning(jobs.length - selected.length) && <Note tone="warn">{leftOutWarning(jobs.length - selected.length)}</Note>}

              <section aria-live="polite" style={{ display: "grid", gap: 8 }}>
                <div className="paydoc-label">What PEAK receives</div>
                {preview === null ? (
                  <div className="skel-row" />
                ) : !preview.ok ? (
                  <MissingCategoryNote guideId={guideId} reasons={preview.reasons} rows={preview.missingCategories ?? []} />
                ) : (
                  <>
                    <div className="grid-scroll">
                      {/* Gross, WHT and Net each in their own column, so the withholding is
                          checked against the amounts rather than read out of a description. */}
                      <table className="acct-table paydoc-table paydoc-wht">
                        <thead><tr><th>Job No.</th><th>Expense type</th><th className="r" style={{ width: 110 }}>Gross</th><th className="r" style={{ width: 90 }}>WHT</th><th className="r" style={{ width: 110 }}>Net</th></tr></thead>
                        <tbody>
                          {preview.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="num" data-label="Job No.">{l.jobRef}</td>
                              <td data-label="Expense type">{lineType(l)}<span className="paydoc-acct">{l.accountCode}</span></td>
                              <td className="r num" data-label="Gross">{thb(l.price)}</td>
                              <td className="r num" data-label="WHT">{l.wht > 0 ? thb(l.wht) : "–"}</td>
                              <td className="r num" data-label="Net">{thb(l.net ?? l.price - l.wht)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="paydoc-sum">
                      <Row label={`Gross expense · ${preview.lines.length} line${preview.lines.length === 1 ? "" : "s"}`} value={thb(preview.gross)} />
                      <Row label="WHT" value={preview.wht > 0 ? thb(preview.wht) : "–"} />
                      <Row label={alreadyPaid ? `Amount paid · ${dShort(alreadyPaid.paidDate)} — recorded against this document next` : "Net payable — recorded later, against this document"} value={thb(preview.total)} strong />
                    </div>
                    <div className="paydoc-credit" title="PEAK bills each document created, not each line">
                      Creates <b>1 PEAK document</b> with {preview.lines.length} line{preview.lines.length === 1 ? "" : "s"} for {selected.length} job{selected.length === 1 ? "" : "s"}, <b>unpaid</b> — 1 PEAK API credit.
                      {selected.length > 1 && <> Posted one at a time, the same jobs would take {selected.length} documents.</>}
                    </div>
                    <div className="paydoc-hint">
                      {alreadyPaid
                        ? <>Nothing changes on the jobs yet. After checking the document in PEAK, record the payment against it: it is dated {dShort(alreadyPaid.paidDate)}, {preview.hasSlip ? "attaches the slip saved then" : "has no saved slip to attach (you can add one)"}, and the guide is not told again.</>
                        : <>Nothing is paid and the guide is not told yet. After you have checked the document in PEAK and made the transfer, record the payment against it — the jobs are marked paid only then.</>}
                    </div>
                    {mismatch && <Note tone="danger">The document total {thb(preview.total)} does not match these jobs&rsquo; payout {thb(selectedTotal)}. Reload Payments before creating it.</Note>}
                  </>
                )}
              </section>
            </>
          )}

          {outcome?.kind === "uncertain" && (
            <Note tone="warn"><b>PEAK did not confirm this document.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>
          )}
          {outcome?.kind === "failed" && (
            <Note tone="danger"><b>No document was created.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>
          )}
        </div>

        <div className="mfoot">
          {busy && <span aria-live="polite" style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>Creating the PEAK document…</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>{outcome ? "Close" : "Cancel"}</button>
          {!created && outcome?.kind !== "uncertain" && (
            <button className="btn primary" onClick={create} disabled={!canCreate}>
              {busy ? "Creating…" : preview?.ok ? `Create PEAK document · ${preview.lines.length} lines` : "Create PEAK document"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The document exists in PEAK, unpaid. Shown until the dialog closes; the Payments
 *  page keeps showing it after. */
export function CreatedState({ doc, onRecordPayment, compact }: { doc: CreatedDocument & { recordError?: string | null; existing?: boolean }; onRecordPayment?: () => void; compact?: boolean }) {
  return (
    <div className="paydoc-created" style={{ display: "grid", gap: 8 }} aria-live="polite">
      {doc.existing && <Note tone="warn">These jobs were already in this document — no second document was created.</Note>}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b className="num" style={{ fontSize: compact ? 15 : 20, letterSpacing: "0.01em" }}>{doc.documentNo}</b>
        <span className="badge invited" style={{ whiteSpace: "nowrap" }}>{doc.alreadyPaid ? `Paid ${doc.paidDate ? dShort(doc.paidDate) : "earlier"} · payment not recorded in PEAK` : "Awaiting payment"}</span>
        <span style={{ fontSize: 12, color: "var(--ink-soft)", fontFamily: "monospace" }}>{doc.paymentRef}</span>
      </div>
      <div className="paydoc-sum">
        <Row label={`Gross expense · ${doc.jobs.length} job${doc.jobs.length === 1 ? "" : "s"} · ${doc.lineCount} line${doc.lineCount === 1 ? "" : "s"}`} value={thb(doc.gross)} />
        <Row label="WHT" value={doc.wht > 0 ? thb(doc.wht) : "–"} />
        <Row label={doc.alreadyPaid ? "Amount paid" : "Net payable"} value={thb(doc.total)} strong />
      </div>
      {doc.recordError && <Note tone="danger">{doc.recordError}. The jobs stay locked so nothing creates a second document — resolve it on the Payments page.</Note>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {doc.documentLink
          ? <a className="btn sm" href={doc.documentLink} target="_blank" rel="noopener noreferrer" title="Opens the link PEAK returned for this document">View PEAK document</a>
          : <span className="btn sm ghost" aria-disabled="true" title={`PEAK returned no link. In PEAK, search expenses for ${doc.documentNo} or reference ${doc.paymentRef}.`}>View PEAK document — search {doc.documentNo} in PEAK</span>}
        {onRecordPayment && <button className="btn sm primary" onClick={onRecordPayment}>{doc.alreadyPaid && doc.paidDate ? `Record the ${dShort(doc.paidDate)} payment` : "Record payment"}</button>}
      </div>
    </div>
  );
}

// Every refusal at once. Rows with no expense category get a table of their own — job,
// row, description, amount — because nine one-line sentences are hard to work through,
// and each one is a separate trip to a job sheet. Categories are never filled in here.
function MissingCategoryNote({ guideId, reasons, rows }: { guideId: string; reasons: string[]; rows: MissingCategory[] }) {
  const others = rows.length ? reasons.filter((x) => !x.includes("has no expense category")) : reasons;
  return (
    <Note tone="danger">
      <b>These jobs cannot go into one document yet:</b>
      {others.length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{others.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      {rows.length > 0 && (
        <div style={{ marginTop: 8, color: "var(--ink)" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {rows.length} billed row{rows.length === 1 ? " has" : "s have"} no expense category — set {rows.length === 1 ? "it" : "each one"} on the job sheet
          </div>
          <div className="grid-scroll">
            <table className="acct-table paydoc-table" aria-label="Rows with no expense category">
              <thead><tr><th>Job No.</th><th style={{ width: 44 }}>Row</th><th>Description</th><th className="r" style={{ width: 96 }}>Amount</th><th>Missing</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.date}|${r.slotIdx}|${r.rowNo}`}>
                    <td className="num"><a href={`/job-sheet?guideId=${encodeURIComponent(guideId)}&date=${r.date}&slotIdx=${r.slotIdx}`} target="_blank" rel="noopener noreferrer">{r.jobRef}</a></td>
                    <td className="num">{r.rowNo}</td>
                    <td>{r.description}</td>
                    <td className="r num">{thb(r.amount)}</td>
                    <td>Expense category</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Note>
  );
}

export function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: strong ? "var(--ink)" : "var(--ink-soft)", fontWeight: strong ? 700 : 400 }}>{label}</span>
      <b className="num" style={{ fontWeight: strong ? 800 : 600 }}>{value}</b>
    </div>
  );
}

export function Note({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const c = tone === "danger"
    ? { bg: "var(--danger-bg)", line: "var(--danger-line)", ink: "var(--danger)" }
    : tone === "ok" ? { bg: "var(--ok-bg,#eef7f0)", line: "var(--ok-line,#cfe6d6)", ink: "var(--green,#2f7d4f)" }
    : { bg: "#fff8c4", line: "#ecd9bf", ink: "var(--ink)" };
  return <div style={{ background: c.bg, border: `1px solid ${c.line}`, color: c.ink, borderRadius: 9, padding: "8px 10px", fontSize: 12.5 }}>{children}</div>;
}
