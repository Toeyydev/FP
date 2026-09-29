"use client";
import { useMemo, useState } from "react";
import { thb } from "@/lib/jobsheet";

// Recording a PEAK document the accountant already created.
//
// The preview below is the SERVER's answer, not this component's opinion: it posts
// the same request with preview:true and shows what came back. Nothing here decides
// whether a link is allowed — the same checks run again when Record is pressed.

export type LinkTarget =
  | { kind: "ADVANCE"; advanceId: string; guideId: string; label: string; amount: number; jobNo: string | null; outstanding: number }
  | { kind: "RETURN"; receiptId: string; guideId: string; label: string; amount: number; unallocated: number; bankRef: string | null; status: string; advances: { id: string; advanceNo: string; outstanding: number }[] };

type Preview = { documentNo: string; amount: number; verified: boolean; warnings: string[]; describes: string };

const newRequestKey = () => `link-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function RecordExistingPeakDialog({ target, bankAccount, onClose, onDone }: {
  target: LinkTarget; bankAccount?: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"ADVANCE" | "RETURN" | "EXPENSE">(target.kind);
  const [documentType, setDocumentType] = useState<"DAILY_JOURNAL" | "EXPENSE">("DAILY_JOURNAL");
  const [documentNo, setDocumentNo] = useState("");
  const [note, setNote] = useState("");
  const [jobNo, setJobNo] = useState(target.kind === "ADVANCE" ? target.jobNo ?? "" : "");
  const [amount, setAmount] = useState("");
  const [advanceId, setAdvanceId] = useState(target.kind === "RETURN" ? target.advances[0]?.id ?? "" : "");
  const [bankRef, setBankRef] = useState(target.kind === "RETURN" ? target.bankRef ?? "" : "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [requestKey] = useState(newRequestKey);

  const payload = useMemo(() => {
    const base = { kind: mode, documentNo: documentNo.trim(), documentType, note: note.trim(), requestKey };
    if (mode === "ADVANCE") return { ...base, advanceId: (target as { advanceId: string }).advanceId };
    if (mode === "EXPENSE") return { ...base, advanceId: (target as { advanceId: string }).advanceId, jobNo: jobNo.trim(), amount: Number(amount) };
    const t = target as Extract<LinkTarget, { kind: "RETURN" }>;
    return {
      ...base, receiptId: t.receiptId, bankRef: bankRef.trim(), bankAccount,
      allocations: advanceId ? [{ advanceId, amount: t.unallocated }] : [],
    };
  }, [mode, documentNo, documentType, note, requestKey, target, jobNo, amount, bankRef, advanceId, bankAccount]);

  const send = async (dryRun: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/advances/peak-link", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, preview: dryRun, acknowledgeWarnings: !dryRun && !!preview }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail || body.reasons?.join("\n") || body.error || `HTTP ${r.status}`);
      if (dryRun) setPreview(body as Preview);
      else onDone(`${body.documentNo} recorded — FolkOPS will not send this to PEAK again`);
    } catch (e) { setErr(String((e as Error).message)); setPreview(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="scrim show" role="dialog" aria-modal="true" aria-label="Record an existing PEAK document">
      <div className="sheet" style={{ maxWidth: 560, display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0 }}>Record an existing PEAK document</h3>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          For money your accountant has already entered in PEAK. FolkOPS records that document number and stops
          sending this movement — it never creates a document here.
        </p>
        <div className="fld"><label>Movement</label>
          <div style={{ fontSize: 13 }}><b>{target.label}</b> · {thb(target.amount)} · {target.guideId}</div>
        </div>

        {target.kind === "ADVANCE" && (
          <div className="fld"><label>What is already in PEAK</label>
            <select value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null); }}>
              <option value="ADVANCE">The transfer to the guide</option>
              <option value="EXPENSE">Ticket costs already charged against this advance</option>
            </select>
          </div>
        )}

        {mode === "EXPENSE" && (
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <div className="fld"><label>Job No.</label><input value={jobNo} onChange={(e) => { setJobNo(e.target.value); setPreview(null); }} placeholder="FOLK-BKK-…" /></div>
            <div className="fld"><label>Ticket amount in that document</label><input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} /></div>
          </div>
        )}

        {mode === "RETURN" && (
          <>
            <div className="fld"><label>Bank statement reference</label>
              <input value={bankRef} onChange={(e) => { setBankRef(e.target.value); setPreview(null); }} placeholder="the line on the company statement" />
            </div>
            <div className="fld"><label>Put it against</label>
              <select value={advanceId} onChange={(e) => { setAdvanceId(e.target.value); setPreview(null); }}>
                <option value="">— choose the advance this repays —</option>
                {(target as Extract<LinkTarget, { kind: "RETURN" }>).advances.map((a) => (
                  <option key={a.id} value={a.id}>{a.advanceNo} · {thb(a.outstanding)} outstanding</option>
                ))}
              </select>
            </div>
          </>
        )}

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "160px 1fr" }}>
          <div className="fld"><label>Document type</label>
            <select value={documentType} onChange={(e) => { setDocumentType(e.target.value as typeof documentType); setPreview(null); }}>
              <option value="DAILY_JOURNAL">Daily journal</option>
              <option value="EXPENSE">Expense document</option>
            </select>
          </div>
          <div className="fld"><label>PEAK document number</label>
            <input value={documentNo} onChange={(e) => { setDocumentNo(e.target.value.toUpperCase()); setPreview(null); }} placeholder="as PEAK shows it" />
          </div>
        </div>

        <div className="fld"><label>Why this is the right document</label>
          <textarea rows={2} value={note} onChange={(e) => { setNote(e.target.value); setPreview(null); }} placeholder="what you checked in PEAK, and how you know it is this movement" />
        </div>

        {err && <div className="banner danger" role="alert" style={{ whiteSpace: "pre-line" }}>{err}</div>}

        {preview && (
          <div className="panel" style={{ display: "grid", gap: 6, fontSize: 12.5 }} role="status">
            <div><b>{preview.documentNo}</b> will be recorded for {thb(preview.amount)}</div>
            <div className="muted">{preview.describes}</div>
            <div>{preview.verified
              ? <span className="badge ok">PEAK checked: accounts and amount match</span>
              : <span className="badge warn">not fully checked</span>}</div>
            {preview.warnings.map((w) => <div key={w} style={{ color: "var(--danger, #b3402f)" }}>⚠ {w}</div>)}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          {!preview
            ? <button className="btn primary" disabled={busy || !documentNo.trim() || note.trim().length < 5} onClick={() => void send(true)}>Check in PEAK…</button>
            : <button className="btn primary" disabled={busy} onClick={() => void send(false)}>Record {preview.documentNo}</button>}
        </div>
      </div>
    </div>
  );
}
