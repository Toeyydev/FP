"use client";

// The guide's Company ADV card on their job sheet — read-only.
//
// Shows only what the server sends a guide (lib/advances/guide-card): the amount, "✓ Transferred",
// and "To return ฿X" while they still hold unspent money. The guide changes nothing on the
// advance. Two things they can do, both through the existing workflows:
//   - record their own return (POST /api/jobsheet/advance kind=return — a claim the office
//     checks against the bank; it never edits the advance), using the job-number return memo;
//   - upload slips / receipts for the job's expenses (the receipt list on this sheet).

import { useState } from "react";
import CopyMemo from "@/components/CopyMemo";
import { returnMemo } from "@/lib/bank-memo";
import { thb } from "@/lib/jobsheet";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";
import type { GuideAdvanceCard as Card } from "@/lib/advances/guide-card";

type Props = {
  card: Card;
  job: { guideId: string; date: string; slotIdx: number; ref: string | null | undefined };
  onChanged: (card: Card | null) => void;
  /** Scrolls to where the guide attaches slips / receipts; omitted when there is nowhere to. */
  onUpload?: () => void;
};

const L: React.CSSProperties = { border: "1px solid var(--line)", borderRadius: 8, padding: "8px 10px", fontSize: 14, width: "100%", minWidth: 0, background: "var(--card,#fff)", color: "inherit" };

export default function GuideAdvanceCard({ card, job, onChanged, onUpload }: Props) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [txRef, setTxRef] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function submit() {
    const amt = Number(amount.replace(/[,\s]/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) { setMsg("Enter a positive amount in baht."); return; }
    if (!txRef.trim()) { setMsg("ใส่เลขอ้างอิงรายการโอนจากธนาคาร · Enter the bank transfer reference."); return; }
    if (!file) { setMsg("แนบสลิปโอนเงินก่อนบันทึก · Attach the transfer slip."); return; }
    setBusy(true); setMsg("");
    const fd = new FormData();
    fd.append("kind", "return"); fd.append("guideId", job.guideId); fd.append("date", job.date); fd.append("slotIdx", String(job.slotIdx));
    fd.append("amount", String(amt)); fd.append("method", "bank"); fd.append("txRef", txRef.trim());
    let blob: Blob = file;
    try { blob = await shrinkImage(file); } catch { /* keep original */ }
    fd.append("file", blob, shrunkName(file.name, blob));
    let r: Response;
    try { r = await fetch("/api/jobsheet/advance", { method: "POST", body: fd }); }
    catch { r = new Response(JSON.stringify({ error: "offline" }), { status: 503 }); }
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsg(r.status === 503 ? (d.detail ?? "Recording is paused — try again shortly.")
        : d.error === "no-sheet" ? "Ask the operator to save the job sheet first."
        : d.error === "duplicate" ? "That amount was just recorded — refresh before recording it again."
        : d.hint || d.detail || d.reasons?.join(" · ") || "Couldn't record it — try again.");
      return;
    }
    onChanged(d.guideAdvance ?? null);
    setOpen(false); setAmount(""); setTxRef(""); setFile(null);
    setMsg("Return recorded — waiting to be checked against the bank ✓");
  }

  return (
    <div className="js-guide-adv" style={{ marginTop: 8, padding: "10px 12px", background: "var(--card,#fff)", border: "1px solid var(--line)", borderRadius: 10, fontSize: 13, display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <b>Company ADV <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>เงินทดรองจากบริษัท</small></b>
        <span className="js-guide-adv-status" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700, padding: "2px 9px", borderRadius: 999, border: "1px solid var(--green-line)", background: "var(--green-bg)", color: "var(--green)", whiteSpace: "nowrap" }}>✓ Transferred</span>
      </div>
      <div className="js-guide-adv-amount" style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{thb(card.amount)}</div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>🔒 Read-only · อ่านอย่างเดียว</div>

      {card.toReturn > 0 && (
        <div className="js-guide-adv-return" style={{ borderTop: "1px solid var(--line)", paddingTop: 8, display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontWeight: 700 }}>
            <span>To return <small style={{ fontWeight: 500, color: "var(--ink-soft)" }}>ต้องคืนบริษัท</small></span>
            <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--assign)" }}>{thb(card.toReturn)}</span>
          </div>
          {job.ref && <div style={{ fontSize: 12 }}><CopyMemo memo={returnMemo(job.ref)} label="Return reference" /></div>}
          {!open && (
            <button type="button" className="btn sm js-guide-adv-record-return" style={{ justifySelf: "start" }} disabled={card.frozen}
              onClick={() => { setOpen(true); setAmount(String(card.toReturn)); setMsg(""); }}>Record return</button>
          )}
          {open && (
            <div className="js-guide-return-form" style={{ display: "grid", gap: 8, padding: 10, border: "1px solid var(--line)", borderRadius: 8, background: "var(--grey-bg,#fafafa)" }}>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Amount you transferred back (฿)
                <input style={{ ...L, marginTop: 2 }} type="number" inputMode="decimal" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-soft)" }}>Bank transfer reference
                <input style={{ ...L, marginTop: 2 }} value={txRef} maxLength={120} onChange={(e) => setTxRef(e.target.value)} /></label>
              <label className="btn sm" style={{ cursor: "pointer", justifySelf: "start" }}>
                {file ? `📎 ${file.name.slice(0, 24)}` : "📎 Attach transfer slip"}
                <input type="file" accept="image/*,application/pdf" hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn sm primary js-guide-return-submit" disabled={busy} onClick={submit}>{busy ? "…" : "Record return"}</button>
                <button type="button" className="btn sm" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {onUpload && (
        <button type="button" className="btn sm js-guide-adv-upload" style={{ justifySelf: "start" }} onClick={onUpload}>Upload slip / receipt</button>
      )}
      {msg && <div role="status" style={{ fontSize: 12 }}>{msg}</div>}
    </div>
  );
}
