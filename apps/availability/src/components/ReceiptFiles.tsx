"use client";
import { useState } from "react";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import { NO_RECEIPT_REASONS_TH } from "@/lib/expense-attachments/no-receipt-row";

// The files behind one Tour Expense row: every receipt or ticket photo, each a link,
// with "+ Add" for several at once. Each file shows Uploading… / Failed · Retry while it
// goes. The server decides who may add or remove (lib/expense-attachments/service).

export type AttachmentView = { id: string; rowId: string; name: string; mime: string; size: number; link: string | null; uploadedAt: string; uploadedByRole: string | null; mine: boolean; removable: boolean };
type Row = { rowId?: string; description?: string; receiptUrl?: string | null; receiptName?: string | null; noReceipt?: { reason?: string } | null };
type Pending = { key: string; name: string; state: "uploading" | "failed"; hint?: string; file: File };
export type ReceiptChange = { sheet?: unknown; attachments?: Record<string, AttachmentView[]> };

const jfetch = (url: string, init?: RequestInit) => fetch(url, { cache: "no-store", ...init });

export default function ReceiptFiles({ sheetKey, row, index, files, canAdd, locked, compact, beforeUpload, onChanged }: {
  sheetKey: { guideId: string; date: string; slotIdx: number };
  row: Row; index: number; files: AttachmentView[]; canAdd: boolean; compact?: boolean;
  /** The sheet is approved: the "no receipt" reason is fixed (the certificate printed it). */
  locked?: boolean;
  beforeUpload?: () => Promise<boolean>;
  onChanged: (d: ReceiptChange) => void;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [note, setNote] = useState("");
  // A receipt attached before files had their own table — shown as it always was.
  const legacy = row.receiptUrl && !files.some((f) => f.link === row.receiptUrl) ? row.receiptUrl : null;

  async function send(p: Pending) {
    setPending((xs) => xs.map((x) => (x.key === p.key ? { ...x, state: "uploading", hint: undefined } : x)));
    let blob: Blob = p.file;
    // Photos go as JPEG, always: the server files each one as a PDF page.
    try { blob = await shrinkImage(p.file, 1600, 0.82, true); } catch { /* the original file then */ }
    const fd = new FormData();
    fd.append("guideId", sheetKey.guideId); fd.append("date", sheetKey.date); fd.append("slotIdx", String(sheetKey.slotIdx));
    if (row.rowId) fd.append("rowId", row.rowId); else fd.append("expenseIndex", String(index));
    fd.append("file", blob, shrunkName(p.file.name, blob));
    const r = await jfetch("/api/jobsheet/attachments", { method: "POST", body: fd }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) {
      setPending((xs) => xs.map((x) => (x.key === p.key ? { ...x, state: "failed", hint: d.hint || "Upload failed — check the connection and retry." } : x)));
      return;
    }
    setPending((xs) => xs.filter((x) => x.key !== p.key));
    onChanged(d);
  }

  async function add(chosen: File[]) {
    if (!chosen.length) return;
    if (beforeUpload && !(await beforeUpload())) return;
    const ps = chosen.map((file) => ({ key: `${Date.now()}-${Math.random()}`, name: file.name, state: "uploading" as const, file }));
    setPending((xs) => [...xs, ...ps]);
    for (const p of ps) await send(p); // one at a time: the row gets its id on the first
  }

  // "No receipt" + why (lib/expense-attachments/no-receipt): printed on the certificate in
  // lieu of a receipt that Approve issues for the row.
  const [asking, setAsking] = useState(false);
  const why = (row.noReceipt?.reason ?? "").trim();
  async function setWhy(reason: string | null) {
    if (beforeUpload && !(await beforeUpload())) return;
    const r = await jfetch("/api/jobsheet/no-receipt", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ guideId: sheetKey.guideId, date: sheetKey.date, slotIdx: sheetKey.slotIdx, ...(row.rowId ? { rowId: row.rowId } : { expenseIndex: index }), reason }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { setNote(d.hint || "Couldn't save the reason."); return; }
    setNote(""); setAsking(false);
    onChanged(d);
  }
  function pick(v: string) {
    if (!v) return;
    if (v === "__other") {
      const t = window.prompt("Why is there no receipt?");
      if (t == null || !t.trim()) return;
      void setWhy(t.trim());
    } else void setWhy(v);
  }

  async function remove(f: AttachmentView) {
    const reason = window.prompt(`Remove "${f.name}" from this expense? The file stays in Drive. Why?`);
    if (reason == null) return;
    const r = await jfetch("/api/jobsheet/attachments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: f.id, reason }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r || !r.ok) { setNote(d.hint || "Couldn't remove the file."); return; }
    setNote("");
    onChanged(d);
  }

  const link = { fontSize: 11.5, fontWeight: 700, color: "var(--green,#2f7d4f)", maxWidth: compact ? 140 : 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, display: "inline-block", verticalAlign: "middle" };
  return (
    <span className="js-receipts" style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, justifyContent: compact ? "flex-start" : "center" }}>
      {legacy && <a className="js-receipt-file" href={legacy} target="_blank" rel="noopener noreferrer" title={row.receiptName || "Receipt"} style={link}>{row.receiptName || "Receipt"}</a>}
      {files.map((f) => (
        <span key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <a className="js-receipt-file" href={f.link ?? "#"} target="_blank" rel="noopener noreferrer" title={f.name} style={link}>{f.name}</a>
          {f.removable && <button type="button" className="btn sm danger js-receipt-remove" title="Remove this file" onClick={() => remove(f)} style={{ padding: "0 6px" }}>×</button>}
        </span>
      ))}
      {pending.map((p) => (
        <span key={p.key} className={`js-receipt-${p.state}`} style={{ fontSize: 11.5, color: p.state === "failed" ? "var(--danger,#c0392b)" : "var(--ink-soft)" }} title={p.hint}>
          {p.state === "uploading" ? `Uploading ${p.name.slice(0, 18)}…` : <>Failed · <button type="button" className="btn sm" onClick={() => send(p)}>Retry</button> <button type="button" className="btn sm ghost" onClick={() => setPending((xs) => xs.filter((x) => x.key !== p.key))}>×</button></>}
        </span>
      ))}
      {pending.some((p) => p.state === "failed") && <span style={{ fontSize: 11, color: "var(--danger,#c0392b)", flexBasis: "100%" }}>{pending.find((p) => p.state === "failed")?.hint}</span>}
      {!files.length && !legacy && !pending.length && why && (
        <span className="js-no-receipt" style={{ fontSize: 11.5, color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 3 }} title={why}>
          <span style={{ maxWidth: compact ? 200 : 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>No receipt · {why}</span>
          {canAdd && !locked && <button type="button" className="btn sm ghost js-no-receipt-clear" title="Remove the reason" onClick={() => void setWhy(null)} style={{ padding: "0 6px" }}>×</button>}
        </span>
      )}
      {!files.length && !legacy && !pending.length && !why && canAdd && !locked && (asking ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <select className="search js-no-receipt-pick" style={{ flex: "none", width: compact ? 200 : 150, fontSize: 12 }} defaultValue="" autoFocus onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>Why no receipt?</option>
            {NO_RECEIPT_REASONS_TH.map((r) => <option key={r} value={r}>{r}</option>)}
            <option value="__other">Other…</option>
          </select>
          <button type="button" className="btn sm ghost" onClick={() => setAsking(false)} style={{ padding: "0 6px" }}>×</button>
        </span>
      ) : <button type="button" className="btn sm ghost js-no-receipt-add" title="No receipt for this row — say why; it goes on the certificate in lieu of a receipt" onClick={() => setAsking(true)}>No receipt</button>)}
      {canAdd ? (
        <label className="btn sm js-receipt-add" style={{ cursor: "pointer", margin: 0 }} title="Attach receipts (JPEG, PNG, WebP or PDF, max 10 MB each)">
          {files.length || legacy ? "+ Add" : "Attach"}
          <input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" hidden onChange={(ev) => { const l = [...(ev.target.files ?? [])]; ev.currentTarget.value = ""; void add(l); }} />
        </label>
      ) : (!files.length && !legacy && !why && <span style={{ color: "var(--ink-soft)" }}>—</span>)}
      {note && <span style={{ fontSize: 11, color: "var(--danger,#c0392b)", flexBasis: "100%" }}>{note}</span>}
    </span>
  );
}
