"use client";

import { useEffect, useRef, useState } from "react";
import { MIN_SLIP_REASON, slipGate, type SlipCheck, type SlipResult } from "@/lib/advances/slip-match";

// The slip check while an advance is being recorded (lib/advances/slip-match).
//
// It asks the server what the slip shows as soon as there is a slip and a guide, and again
// when the amount, date or reference change. What the person answers here (confirmed,
// reason, ADMIN override) goes with the record — and the server runs the check again on
// the same file: this panel informs, it never decides.

/** Payments → Advances, with that advance's ledger open. */
export const existingAdvanceHref = (id: string) => `/payments?view=advances&advance=${encodeURIComponent(id)}`;

export type SlipDecisionFields = { slipCheckConfirmed?: "1"; slipCheckOverride?: "1"; slipCheckReason?: string };
type Duplicate = { reasons: string[]; duplicateOf: { id: string; advanceNo: string } } | null;

const RESULT: Record<SlipResult, { th: string; en: string; tone: string; border: string }> = {
  MATCH: { th: "ตรงกัน", en: "Matches", tone: "var(--green, #2e7d4f)", border: "var(--green-line, #CBE5D6)" },
  PARTIAL: { th: "ตรงบางส่วน", en: "Partly matches", tone: "#8a6100", border: "#e0b964" },
  MISMATCH: { th: "ไม่ตรง", en: "Does not match", tone: "var(--danger, #b3402f)", border: "var(--danger, #b3402f)" },
  UNKNOWN: { th: "อ่านไม่ได้ ต้องตรวจด้วยตา", en: "Could not be read — check by eye", tone: "var(--ink-soft)", border: "var(--line-strong)" },
};

export default function SlipCheckPanel({ file, guideId, amount, advanceDate, bankRef, isAdmin, onChange, onOpenExisting }: {
  file: File | null; guideId: string; amount: string; advanceDate: string; bankRef: string; isAdmin: boolean;
  /** ready: may the record be sent; fields: what to add to the form. */
  onChange: (ready: boolean, fields: SlipDecisionFields) => void;
  onOpenExisting?: (advanceId: string) => void;
}) {
  const [check, setCheck] = useState<SlipCheck | null>(null);
  const [duplicate, setDuplicate] = useState<Duplicate>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    setCheck(null); setDuplicate(null); setErr(null); setConfirmed(false); setOverride(false);
    if (!file || !guideId.trim()) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const body = new FormData();
        body.set("file", file); body.set("guideId", guideId.trim()); body.set("amount", amount); body.set("advanceDate", advanceDate); body.set("bankRef", bankRef);
        const r = await fetch("/api/advances/slip-check", { method: "POST", body });
        const j = await r.json().catch(() => ({}));
        if (n !== seq.current) return;
        if (!r.ok) { setErr((j as { reasons?: string[] }).reasons?.join("\n") || `Slip check failed (HTTP ${r.status})`); return; }
        setCheck((j as { check: SlipCheck }).check);
        setDuplicate((j as { duplicate: Duplicate }).duplicate);
      } catch { if (n === seq.current) setErr("Slip check failed — check the network and try again"); }
      finally { if (n === seq.current) setLoading(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [file, guideId, amount, advanceDate, bankRef]);

  useEffect(() => {
    if (!check) { onChange(false, {}); return; }
    const refused = slipGate(check.result, { confirmed, override, reason }, isAdmin ? "ADMIN" : "OPERATOR");
    const fields: SlipDecisionFields = {
      ...(confirmed ? { slipCheckConfirmed: "1" as const } : {}),
      ...(override ? { slipCheckOverride: "1" as const } : {}),
      ...(reason.trim() ? { slipCheckReason: reason.trim() } : {}),
    };
    onChange(!refused && !duplicate, fields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check, duplicate, confirmed, override, reason, isAdmin]);

  if (!file || !guideId.trim()) return <div className="muted js-slip-check" style={{ fontSize: 12 }}>Slip check runs once a guide and a slip are chosen · ตรวจ slip เมื่อเลือกไกด์และแนบ slip แล้ว</div>;

  const r = check ? RESULT[check.result] : null;
  const needsReason = check?.result === "PARTIAL" || (check?.result === "MISMATCH" && isAdmin);
  return (
    <div className="js-slip-check" data-result={check?.result ?? ""} style={{ display: "grid", gap: 6, border: `1px solid ${r?.border ?? "var(--line)"}`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5 }}>
      {duplicate && (
        <div className="banner danger js-slip-duplicate" role="alert" style={{ whiteSpace: "pre-line", margin: 0 }}>
          {duplicate.reasons.slice(0, 2).join("\n")}
          <div>{onOpenExisting
            ? <button type="button" className="btn sm js-open-existing" style={{ marginTop: 6 }} onClick={() => onOpenExisting(duplicate.duplicateOf.id)}>Open {duplicate.duplicateOf.advanceNo} · เปิดรายการเดิม</button>
            : <a className="btn sm js-open-existing" style={{ marginTop: 6, display: "inline-block" }} href={existingAdvanceHref(duplicate.duplicateOf.id)} target="_blank" rel="noreferrer">Open {duplicate.duplicateOf.advanceNo} · เปิดรายการเดิม</a>}</div>
        </div>
      )}
      {loading && <div className="muted">Checking the slip… · กำลังตรวจ slip…</div>}
      {err && <div style={{ color: "var(--danger, #b3402f)", whiteSpace: "pre-line" }}>{err}</div>}
      {check && r && (
        <>
          <div><b style={{ color: r.tone }}>Slip check: {r.en} · {r.th}</b></div>
          {check.slip && (
            <div className="muted js-slip-readout" style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8 }}>
              <span>Transaction ID</span><span>{check.slip.transactionId ?? "—"}</span>
              <span>Date · วันที่</span><span>{check.slip.date ?? "—"}</span>
              <span>Amount · ยอด</span><span>{check.slip.amount != null ? `฿${check.slip.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}</span>
              <span>To · ผู้รับ</span><span>{check.slip.recipientNames.join(" / ") || "—"}</span>
              <span>Account · บัญชี</span><span>{check.slip.accountMask ?? "—"}</span>
            </div>
          )}
          {check.result !== "MATCH" && <ul style={{ margin: 0, paddingLeft: 18 }}>{check.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
          {(check.result === "PARTIAL" || check.result === "UNKNOWN") && (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 500 }}>
              <input type="checkbox" className="js-slip-confirm" style={{ width: "auto", flex: "none", margin: "2px 0 0" }} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I checked the slip myself: it is this transfer, to this guide · ฉันตรวจ slip ด้วยตนเองแล้วว่าเป็นการโอนนี้ให้ไกด์คนนี้</span>
            </label>
          )}
          {check.result === "MISMATCH" && isAdmin && (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontWeight: 500 }}>
              <input type="checkbox" className="js-slip-override" style={{ width: "auto", flex: "none", margin: "2px 0 0" }} checked={override} onChange={(e) => setOverride(e.target.checked)} />
              <span>Override as ADMIN — record it anyway · ADMIN ยืนยันบันทึกแม้ไม่ตรง</span>
            </label>
          )}
          {check.result === "MISMATCH" && !isAdmin && <div style={{ color: "var(--danger, #b3402f)" }}>Correct the guide or the details, or ask an ADMIN to review. · แก้ข้อมูลให้ถูก หรือให้ ADMIN ตรวจ</div>}
          {(check.result === "PARTIAL" || check.result === "UNKNOWN" || (check.result === "MISMATCH" && isAdmin)) && (
            <label>Reason{needsReason ? ` (at least ${MIN_SLIP_REASON} characters)` : " (optional)"} · เหตุผล
              <input className="js-slip-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. bank cut the surname short; account checked with the guide" />
            </label>
          )}
        </>
      )}
    </div>
  );
}
