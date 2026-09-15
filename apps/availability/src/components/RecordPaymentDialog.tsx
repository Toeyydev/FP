"use client";

import { useCallback, useEffect, useState } from "react";
import { thb } from "@/lib/jobsheet";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import { Note, Row, type CreatedDocument } from "@/components/PeakPaymentDialog";

// "Pay N jobs together · one ref", stage 2: record the payment against the EXISTING
// PEAK document.
//
// Only now does anyone enter a payment date, the account the money left from and the
// slip — because only now has a payment happened. The amount is the document's own
// net total and cannot be typed. Nothing here can create a second document: the server
// pays the EXP shown, after reading it back from PEAK, and marks the jobs paid only
// once PEAK confirms the payment.
//
// For jobs paid before the document existed (doc.alreadyPaid) the payment is the transfer
// already made: its date is fixed, the slip saved then is used unless another is chosen,
// and the jobs keep their paid date — nobody is told again.

type Method = { id: string; name: string; bankName?: string; accountNumber?: string };
type Outcome =
  | { kind: "paid"; documentNo: string; amount: number; paymentDate: string; attachment: { ok: boolean; reason: string | null }; recordError: string | null; notified: boolean }
  | { kind: "uncertain"; reasons: string[] }
  | { kind: "refused"; reasons: string[] };

const bkkToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const dShort = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export default function RecordPaymentDialog({ guideId, guide, doc, onClose, onDone }: {
  guideId: string;
  guide: string;
  doc: CreatedDocument;
  onClose: () => void;
  onDone: () => void;
}) {
  const latestTour = [...doc.jobs.map((j) => j.date)].sort().pop() ?? "";
  const already = !!doc.alreadyPaid;
  const [paymentDate, setPaymentDate] = useState(already ? doc.paidDate ?? "" : bkkToday());
  const [methods, setMethods] = useState<Method[] | null>(null);
  const [methodsError, setMethodsError] = useState("");
  const [methodId, setMethodId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    fetch("/api/peak/payment-methods", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok && Array.isArray(d.methods)) setMethods(d.methods);
        else { setMethods([]); setMethodsError(d.error || `Could not load PEAK payment methods (${r.status})`); }
      })
      .catch(() => { setMethods([]); setMethodsError("Could not reach the server to load PEAK payment methods"); });
  }, []);

  const close = useCallback(() => {
    if (busy) return; // never abandon a payment mid-flight
    if (outcome) onDone(); else onClose();
  }, [busy, outcome, onClose, onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate) && paymentDate >= latestTour && paymentDate <= bkkToday();
  const paid = outcome?.kind === "paid";
  const locked = busy || paid || outcome?.kind === "uncertain";
  const canRecord = !locked && dateOk && !!methodId && (!!file || already);

  async function record() {
    if (!canRecord || (!file && !already)) return;
    setBusy(true); setOutcome(null);
    const method = methods?.find((m) => m.id === methodId);
    const fd = new FormData();
    fd.append("paymentRef", doc.paymentRef);
    fd.append("documentNo", doc.documentNo);
    fd.append("paymentDate", paymentDate);
    fd.append("paymentMethodId", methodId);
    if (method) fd.append("paymentMethodName", method.name);
    if (file) {
      const blob = await shrinkImage(file);
      fd.append("file", blob, shrunkName(file.name, blob));
    }
    let r: Response | null = null;
    let d: Record<string, unknown> = {};
    try {
      r = await fetch("/api/pay/peak-document/pay", { method: "POST", body: fd });
      d = await r.json().catch(() => ({}));
    } catch {
      // The request may have reached the server. Pressing again could record the payment twice.
      setOutcome({ kind: "uncertain", reasons: [`The connection dropped before the server answered. Reload Payments and look at ${doc.documentNo} in PEAK before trying again.`] });
      setBusy(false);
      return;
    }
    setBusy(false);
    const reasons = Array.isArray(d.reasons) ? (d.reasons as string[]) : [];
    if (r.ok && d.ok) {
      setOutcome({
        kind: "paid", documentNo: String(d.documentNo), amount: Number(d.amount), paymentDate: String(d.paymentDate),
        attachment: (d.attachment as { ok: boolean; reason: string | null }) ?? { ok: false, reason: null },
        recordError: (d.recordError as string) ?? null, notified: !!d.notified,
      });
    } else if (d.error === "peak-uncertain") {
      setOutcome({ kind: "uncertain", reasons });
    } else {
      setOutcome({ kind: "refused", reasons: reasons.length ? reasons : [d.error === "forbidden" ? "Operator only" : `The payment was not recorded (${r.status})`] });
    }
  }

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="recpay-h" style={{ width: "min(620px, 100%)" }}>
        <h3 id="recpay-h">{already ? `Record the ${doc.paidDate ? dShort(doc.paidDate) : ""} payment on ${doc.documentNo} · ${thb(doc.total)}` : `Pay ${doc.documentNo} · ${thb(doc.total)}`}</h3>
        <div className="mctx">{guideId} · {guide} · step 2 of 2: {already ? "record the transfer already made" : "record the transfer"} against the existing PEAK document <span style={{ fontFamily: "monospace" }}>{doc.paymentRef}</span></div>

        <div className="mbody" style={{ display: "grid", gap: 14 }}>
          <div className="paydoc-sum">
            {doc.jobs.map((j) => <Row key={`${j.date}|${j.slotIdx}`} label={`${dShort(j.date)} · ${j.ref}`} value={thb(j.payout)} />)}
            <Row label={`Gross expense · ${doc.lineCount} line${doc.lineCount === 1 ? "" : "s"}`} value={thb(doc.gross)} />
            <Row label="WHT" value={doc.wht > 0 ? thb(doc.wht) : "–"} />
            <Row label={already ? `Amount paid · ${doc.paidDate ? dShort(doc.paidDate) : "an earlier day"}` : "Net payable — the transfer must be exactly this"} value={thb(doc.total)} strong />
          </div>
          {doc.documentLink && <a className="btn sm" style={{ justifySelf: "start" }} href={doc.documentLink} target="_blank" rel="noopener noreferrer">View PEAK document</a>}

          <fieldset disabled={locked} className="paydoc-fields">
            <label>
              <span className="paydoc-label">Payment date</span>
              <input type="date" value={paymentDate} min={latestTour || undefined} max={bkkToday()} onChange={(e) => setPaymentDate(e.target.value)} disabled={already} title={already ? "The day the transfer was made, as recorded when these jobs were paid" : undefined} />
            </label>
            <label>
              <span className="paydoc-label">Paid by (PEAK account)</span>
              <select value={methodId} onChange={(e) => setMethodId(e.target.value)} disabled={!methods?.length}>
                <option value="">{methods === null ? "Loading…" : methods.length ? "Choose the account the money left from" : "No payment methods"}</option>
                {(methods ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.accountNumber ? ` · ${m.accountNumber}` : ""}</option>)}
              </select>
            </label>
            <label>
              <span className="paydoc-label">{already ? (doc.hasSavedSlip === false ? "Payment slip (none was saved — optional)" : "Payment slip (optional — the one saved then is used)") : "Payment slip"}</span>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
          </fieldset>
          {methodsError && <Note tone="danger">{methodsError}</Note>}
          {already && <Note tone="warn">These jobs stay paid as recorded on {doc.paidDate ? dShort(doc.paidDate) : "the day they were paid"} and take {doc.documentNo}. The payment is recorded in PEAK only — no money moves, and the guide is not told again.</Note>}
          {!dateOk && <Note tone="warn">{already ? "These jobs have no single paid date on or after their last tour — correct the payment before recording it." : `The payment date must be on or after the last tour (${latestTour}) and not in the future.`}</Note>}

          {outcome?.kind === "paid" && (
            <div style={{ display: "grid", gap: 6 }} aria-live="polite">
              <Note tone="ok">Payment recorded against <b>{outcome.documentNo}</b> — {thb(outcome.amount)} on {outcome.paymentDate}. {already ? `${doc.jobs.length} job${doc.jobs.length === 1 ? "" : "s"} now carry ${outcome.documentNo} and stay paid as they were; the guide was not told again.` : `${doc.jobs.length} job${doc.jobs.length === 1 ? "" : "s"} marked paid${outcome.notified ? "; the guide has been told" : ""}.`}</Note>
              {!outcome.attachment.ok && <Note tone="warn">The slip did not attach to {outcome.documentNo}{outcome.attachment.reason ? ` (${outcome.attachment.reason})` : ""}.{already && doc.hasSavedSlip === false ? " Attach it in PEAK by hand." : " It is saved in Drive — attach it in PEAK by hand."}</Note>}
              {outcome.recordError && <Note tone="danger">{outcome.recordError}. The jobs stay locked and unpaid so nothing is paid twice — resolve it on the Payments page.</Note>}
            </div>
          )}
          {outcome?.kind === "uncertain" && <Note tone="warn"><b>PEAK did not confirm this payment.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
          {outcome?.kind === "refused" && <Note tone="danger"><b>No payment was recorded.</b>{outcome.reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
        </div>

        <div className="mfoot">
          {busy && <span aria-live="polite" style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>Recording the payment in PEAK…</span>}
          {!busy && !outcome && (!methodId || (!file && !already)) && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>{!methodId ? "Choose Paid by" : "Attach the slip"} to continue</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>{outcome ? "Close" : "Cancel"}</button>
          {!paid && outcome?.kind !== "uncertain" && (
            <button className="btn primary" onClick={record} disabled={!canRecord}>{busy ? "Recording…" : already ? `Record in PEAK · ${thb(doc.total)}` : `Record payment · ${thb(doc.total)}`}</button>
          )}
        </div>
      </div>
    </div>
  );
}
