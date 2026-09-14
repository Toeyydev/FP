"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import { leftOutWarning } from "@/lib/peak-payment-document";

// "Pay N jobs together · one ref" → one PEAK document.
//
// The operator picks the jobs, the payment date, the account the money left from and
// the slip — and sees the exact document PEAK will receive, line by line, before
// anything is sent. Nothing is written until "Post to PEAK & mark paid"; the preview
// only reads.

export type PayTogetherJob = { date: string; slotIdx: number; tour: string; ref?: string | null; amount: number };

type Method = { id: string; name: string; bankName?: string; accountNumber?: string };
type Line = { description: string; jobRef: string; kind: string; category: string | null; accountCode: string; price: number; wht: number };
// A billed row with no expense category (lib/peak-payment-document MissingCategoryRow).
type MissingCategory = { jobRef: string; date: string; slotIdx: number; rowNo: number; description: string; amount: number };
type Preview = { ok: true; lines: Line[]; gross: number; wht: number; total: number } | { ok: false; reasons: string[]; missingCategories?: MissingCategory[] };
type Outcome =
  | { kind: "posted"; paymentRef: string; documentNo: string; documentLink: string | null; total: number; attachment: { ok: boolean; reason: string | null }; recordError: string | null }
  | { kind: "uncertain"; paymentRef: string; reasons: string[] }
  | { kind: "failed"; reasons: string[] };

const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const keyOf = (j: { date: string; slotIdx: number }) => `${j.date}|${j.slotIdx}`;
const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function PeakPaymentDialog({ guideId, guide, jobs, onClose, onDone }: {
  guideId: string;
  guide: string;
  jobs: PayTogetherJob[];
  onClose: () => void;   // nothing changed
  onDone: () => void;    // something may have changed — the caller reloads Payments
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(jobs.map(keyOf)));
  const [paymentDate, setPaymentDate] = useState(bkkToday());
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [methodsError, setMethodsError] = useState("");
  const [methodId, setMethodId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const seq = useRef(0);

  const selected = jobs.filter((j) => picked.has(keyOf(j)));
  const selectedKeys = selected.map(keyOf).join(",");
  const selectedTotal = Math.round(selected.reduce((s, j) => s + j.amount, 0) * 100) / 100;

  useEffect(() => {
    fetch("/api/peak/payment-methods", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok && Array.isArray(d.methods)) setMethods(d.methods);
        else { setMethods([]); setMethodsError(d.error || `Could not load PEAK payment methods (${r.status})`); }
      })
      .catch(() => { setMethods([]); setMethodsError("Could not reach the server to load PEAK payment methods"); });
  }, []);

  // Re-preview whenever the selection or the date changes. A slower, older answer must
  // never overwrite a newer one.
  useEffect(() => {
    if (!selected.length) { setPreview({ ok: false, reasons: ["Select at least one job"] }); return; }
    const mine = ++seq.current;
    setPreview(null);
    fetch("/api/pay/peak-document/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId, paymentDate, jobs: selected.map((j) => ({ date: j.date, slotIdx: j.slotIdx })) }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (mine !== seq.current) return;
        if (!r.ok) setPreview({ ok: false, reasons: [d.error === "forbidden" ? "Operator only" : `Could not build the preview (${r.status})`] });
        else setPreview(d.ok ? { ok: true, lines: d.lines, gross: d.gross, wht: d.wht, total: d.total } : { ok: false, reasons: d.reasons ?? ["Not payable"], missingCategories: Array.isArray(d.missingCategories) ? d.missingCategories : [] });
      })
      .catch(() => { if (mine === seq.current) setPreview({ ok: false, reasons: ["Could not reach the server"] }); });
    // selectedKeys stands in for `selected`, which is a new array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideId, paymentDate, selectedKeys]);

  const close = useCallback(() => {
    if (busy) return; // never abandon a payment mid-flight
    if (outcome) onDone(); else onClose();
  }, [busy, outcome, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const mismatch = preview?.ok && Math.abs(preview.total - selectedTotal) > 0.005;
  const posted = outcome?.kind === "posted";
  const locked = busy || posted || outcome?.kind === "uncertain";
  const canPost = !locked && selected.length > 0 && !!preview?.ok && !mismatch && !!methodId && !!file;

  async function post() {
    if (!canPost || !file) return;
    setBusy(true); setOutcome(null);
    const method = methods?.find((m) => m.id === methodId);
    const fd = new FormData();
    fd.append("guideId", guideId);
    fd.append("jobs", JSON.stringify(selected.map((j) => ({ date: j.date, slotIdx: j.slotIdx }))));
    fd.append("paymentDate", paymentDate);
    fd.append("paymentMethodId", methodId);
    if (method) fd.append("paymentMethodName", method.name);
    const blob = await shrinkImage(file);
    fd.append("file", blob, shrunkName(file.name, blob));
    let r: Response | null = null;
    let d: Record<string, unknown> = {};
    try {
      r = await fetch("/api/pay/peak-document", { method: "POST", body: fd });
      d = await r.json().catch(() => ({}));
    } catch {
      // The request may have reached the server. Say so — pressing again could post twice.
      setOutcome({ kind: "uncertain", paymentRef: "", reasons: ["The connection dropped before the server answered. Reload Payments and check whether these jobs show a PEAK payment before trying again."] });
      setBusy(false);
      return;
    }
    setBusy(false);
    const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
    if (r.ok && d.ok) {
      setOutcome({
        kind: "posted", paymentRef: String(d.paymentRef), documentNo: String(d.documentNo), documentLink: (d.documentLink as string) ?? null,
        total: Number(d.total), attachment: (d.attachment as { ok: boolean; reason: string | null }) ?? { ok: false, reason: null },
        recordError: (d.recordError as string) ?? null,
      });
    } else if (d.error === "peak-uncertain") {
      setOutcome({ kind: "uncertain", paymentRef: String(d.paymentRef ?? ""), reasons });
    } else {
      setOutcome({ kind: "failed", reasons: reasons.length ? reasons : [d.error === "forbidden" ? "Operator only" : `The payment was not made (${r.status})`] });
    }
  }

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="paydoc-h" style={{ width: "min(720px, 100%)" }}>
        <h3 id="paydoc-h">Pay {selected.length} job{selected.length === 1 ? "" : "s"} together · one PEAK document</h3>
        <div className="mctx">{guideId} · {guide} · one transfer, one slip, one reference → <b>1 PEAK document</b></div>

        <div className="mbody" style={{ display: "grid", gap: 14 }}>
          <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}>
            <legend className="paydoc-label">Jobs in this transfer</legend>
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
          {leftOutWarning(jobs.length - selected.length) && <Note tone="warn">{leftOutWarning(jobs.length - selected.length)}</Note>}

          <fieldset disabled={locked} className="paydoc-fields">
            <label>
              <span className="paydoc-label">Payment date</span>
              <input type="date" value={paymentDate} max={bkkToday()} onChange={(e) => setPaymentDate(e.target.value)} />
            </label>
            <label>
              <span className="paydoc-label">Paid by (PEAK account)</span>
              <select value={methodId} onChange={(e) => setMethodId(e.target.value)} disabled={!methods?.length}>
                <option value="">{methods === null ? "Loading…" : methods.length ? "Choose the account the money left from" : "No payment methods"}</option>
                {(methods ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.accountNumber ? ` · ${m.accountNumber}` : ""}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="paydoc-label">Payment slip</span>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </fieldset>
          {methodsError && <Note tone="danger">{methodsError}</Note>}

          <section aria-live="polite" style={{ display: "grid", gap: 8 }}>
            <div className="paydoc-label">What PEAK receives</div>
            {preview === null ? (
              <div className="skel-row" />
            ) : !preview.ok ? (
              <MissingCategoryNote guideId={guideId} reasons={preview.reasons} rows={preview.missingCategories ?? []} />
            ) : (
              <>
                <div className="grid-scroll">
                  <table className="acct-table paydoc-table">
                    <thead><tr><th style={{ width: 28 }}>#</th><th>Line</th><th style={{ width: 90 }}>Account</th><th className="r" style={{ width: 110 }}>Amount</th><th className="r" style={{ width: 90 }}>WHT</th></tr></thead>
                    <tbody>
                      {preview.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="num">{i + 1}</td>
                          <td>{l.description}</td>
                          <td className="num">{l.accountCode}</td>
                          <td className="r num">{thb(l.price)}</td>
                          <td className="r num">{l.wht ? `−${thb(l.wht)}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="paydoc-sum">
                  <Row label={`${preview.lines.length} lines, before withholding`} value={thb(preview.gross)} />
                  {preview.wht > 0 && <Row label="Withholding tax on guide fees" value={`−${thb(preview.wht)}`} />}
                  <Row label="Paid to the guide — one payment, one reference" value={thb(preview.total)} strong />
                </div>
                <div className="paydoc-credit" title="PEAK bills each document created, not each line">
                  Creates <b>1 PEAK document</b> with {preview.lines.length} line{preview.lines.length === 1 ? "" : "s"} for {selected.length} job{selected.length === 1 ? "" : "s"} — 1 PEAK API credit.
                  {selected.length > 1 && <> Paid one at a time, the same jobs would take {selected.length} documents.</>}
                </div>
                {preview.wht > 0 && (
                  <div className="paydoc-hint">
                    Guide fees go to PEAK gross with their withholding tax, so PEAK keeps the tax record and the document total still equals the transfer.
                  </div>
                )}
                {mismatch && <Note tone="danger">The document total {thb(preview.total)} does not match these jobs&rsquo; payout {thb(selectedTotal)}. Reload Payments before paying.</Note>}
              </>
            )}
          </section>

          {outcome?.kind === "posted" && (
            <div style={{ display: "grid", gap: 6 }} aria-live="polite">
              <Note tone="ok">
                PEAK document <b>{outcome.documentNo}</b> created ({outcome.paymentRef}) — {thb(outcome.total)} paid, {selected.length} job{selected.length === 1 ? "" : "s"} marked paid.
                {outcome.documentLink && <> <a href={outcome.documentLink} target="_blank" rel="noopener noreferrer">Open in PEAK</a></>}
              </Note>
              {!outcome.attachment.ok && <Note tone="warn">The slip did not attach to {outcome.documentNo}{outcome.attachment.reason ? ` (${outcome.attachment.reason})` : ""}. It is saved in Drive — attach it in PEAK by hand.</Note>}
              {outcome.recordError && <Note tone="danger">{outcome.recordError}. The jobs stay locked so nothing posts twice — resolve it on the Payments page.</Note>}
            </div>
          )}
          {outcome?.kind === "uncertain" && (
            <Note tone="warn"><b>PEAK did not confirm this payment.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>
          )}
          {outcome?.kind === "failed" && (
            <Note tone="danger"><b>Nothing was paid.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>
          )}
        </div>

        <div className="mfoot">
          {busy && <span aria-live="polite" style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>Posting to PEAK…</span>}
          {!busy && !outcome && preview?.ok && (!methodId || !file) && (
            <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>{!methodId ? "Choose Paid by" : "Attach the slip"} to continue</span>
          )}
          <button className="btn ghost" onClick={close} disabled={busy}>{outcome ? "Close" : "Cancel"}</button>
          {!posted && outcome?.kind !== "uncertain" && (
            <button className="btn primary" onClick={post} disabled={!canPost}>
              {busy ? "Posting…" : preview?.ok ? `Post to PEAK & mark paid · ${thb(preview.total)}` : "Post to PEAK & mark paid"}
            </button>
          )}
        </div>
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
      <b>These jobs cannot be paid together yet:</b>
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

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ color: strong ? "var(--ink)" : "var(--ink-soft)", fontWeight: strong ? 700 : 400 }}>{label}</span>
      <b className="num" style={{ fontWeight: strong ? 800 : 600 }}>{value}</b>
    </div>
  );
}

function Note({ tone, children }: { tone: "ok" | "warn" | "danger"; children: React.ReactNode }) {
  const c = tone === "danger"
    ? { bg: "var(--danger-bg)", line: "var(--danger-line)", ink: "var(--danger)" }
    : tone === "ok" ? { bg: "var(--ok-bg,#eef7f0)", line: "var(--ok-line,#cfe6d6)", ink: "var(--green,#2f7d4f)" }
    : { bg: "#fff8c4", line: "#ecd9bf", ink: "var(--ink)" };
  return <div style={{ background: c.bg, border: `1px solid ${c.line}`, color: c.ink, borderRadius: 9, padding: "8px 10px", fontSize: 12.5 }}>{children}</div>;
}
