"use client";

import { useCallback, useEffect, useState } from "react";
import { computeTotals, thb, type GuideFee } from "@/lib/jobsheet";
import { Note } from "@/components/PeakPaymentDialog";
import { handoverFees, HANDOVER_REASONS, HANDOVER_REASON_LABEL, HANDOVER_TIME, type HandoverReason } from "@/lib/tour-handover";
import { NAME_PREFIXES } from "@/lib/peak-guide-contact";
import { shrinkImage, shrunkName } from "@/lib/shrink-image";

export type HandoverPeakContact =
  | { status: "linked" | "created" | "already"; contactId: string; code: string | null; name: string | null }
  | { status: "refused" | "failed" | "uncertain" | "not-connected"; reasons: string[] };

// "Hand over (guide sick)…" — record that another guide finished this tour.
//
// The replacement is usually a one-off ("ขาจร") guide who was never in FolkOPS, so that
// is the default: the operator types who they are and what paying them needs. They get
// a guide number, no login, and are never offered work. The fee moves to them in full;
// the original guide keeps their guests and the expenses they paid. Nobody is notified.

type GuideOption = { guideId: string; name: string; external?: boolean };

export default function HandoverDialog({ guideId, guideName, date, slotIdx, tourName, fee, onClose, onDone }: {
  guideId: string;
  guideName: string;
  date: string;
  slotIdx: number;
  tourName: string;
  fee: GuideFee | null;
  onClose: () => void;
  onDone: (r: { toGuideId: string; toRef: string | null; peakContact: HandoverPeakContact | null }) => void;
}) {
  const [mode, setMode] = useState<"external" | "existing">("external");
  const [guides, setGuides] = useState<GuideOption[] | null>(null);
  const [toGuideId, setToGuideId] = useState("");
  const [ext, setExt] = useState({ fullName: "", phone: "", taxId: "", address: "", licenseNo: "", bankName: "", bankAccountNo: "", bankAccountName: "" });
  const [prefix, setPrefix] = useState<number>(2);
  const [card, setCard] = useState<File | null>(null);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [toPeak, setToPeak] = useState(true);
  useEffect(() => {
    if (!card || !card.type.startsWith("image/")) { setCardUrl(null); return; }
    const url = URL.createObjectURL(card);
    setCardUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [card]);
  const [time, setTime] = useState("");
  const [reason, setReason] = useState<HandoverReason>("SICK");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);

  useEffect(() => {
    if (mode !== "existing" || guides) return;
    fetch("/api/guides", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setGuides(((d.rows ?? []) as GuideOption[]).filter((g) => !g.external && g.guideId !== guideId).sort((a, b) => a.guideId.localeCompare(b.guideId))))
      .catch(() => setGuides([]));
  }, [mode, guides, guideId]);

  const close = useCallback(() => { if (!busy) onClose(); }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const fees = handoverFees(fee);
  const fromNet = computeTotals([], fees.from).netGuideFee;
  const toT = computeTotals([], fees.to);
  const toGross = (Number(fees.to.price) || 0) * (Number(fees.to.time) || 0);
  const taxDigits = ext.taxId.replace(/\D/g, "");
  // Into PEAK needs the 13 digits: they are how FolkOPS finds the supplier if it exists.
  const peakBlocked = mode === "external" && toPeak && taxDigits.length !== 13;
  const ready = HANDOVER_TIME.test(time) && (mode === "existing" ? !!toGuideId : ext.fullName.trim().length >= 2) && !peakBlocked;

  async function submit() {
    if (!ready) return;
    setBusy(true); setReasons([]);
    const body = {
      date, slotIdx, fromGuideId: guideId, time, reason, note: note.trim() || undefined,
      ...(mode === "existing"
        ? { toGuideId }
        : { external: { ...Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, v.trim() || undefined])), prefix, createPeakContact: toPeak } }),
    };
    const fd = new FormData();
    fd.append("data", JSON.stringify(body));
    if (mode === "external" && card) {
      const blob = await shrinkImage(card);
      fd.append("licenseCard", blob, shrunkName(card.name, blob));
    }
    let r: Response;
    let d: Record<string, unknown> = {};
    try {
      r = await fetch("/api/tour-handover", { method: "POST", body: fd });
      d = await r.json().catch(() => ({}));
    } catch {
      setBusy(false);
      setReasons(["The connection dropped. Reload the job sheet to see whether the handover was recorded before trying again."]);
      return;
    }
    setBusy(false);
    if (r.ok && d.ok) { onDone({ toGuideId: String(d.toGuideId), toRef: (d.toRef as string) ?? null, peakContact: (d.peakContact as HandoverPeakContact) ?? null }); return; }
    setReasons(Array.isArray(d.reasons) && d.reasons.length ? (d.reasons as string[]) : [`The handover was not recorded (${r.status})`]);
  }

  const field = (k: keyof typeof ext, label: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      <span className="paydoc-label">{label}</span>
      <input value={ext[k]} onChange={(e) => setExt((x) => ({ ...x, [k]: e.target.value }))} {...extra} />
    </label>
  );

  return (
    <div className="scrim show" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="handover-h" style={{ width: "min(620px, 100%)" }}>
        <h3 id="handover-h">Hand over this tour</h3>
        <div className="mctx">{guideId} · {guideName} · {tourName} · {date}</div>

        <div className="mbody" style={{ display: "grid", gap: 14 }}>
          <fieldset disabled={busy} className="paydoc-fields" style={{ gridTemplateColumns: "1fr" }}>
            <legend className="paydoc-label">Who finished the tour</legend>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "flex-start", textAlign: "left", cursor: "pointer" }}>
              <input type="radio" name="handover-mode" checked={mode === "external"} onChange={() => setMode("external")} style={{ width: "auto", flex: "none", margin: "3px 0 0" }} />
              <span>A one-off guide, not in FolkOPS <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>(ไกด์ขาจร — no login, never offered work)</span></span>
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", justifyContent: "flex-start", textAlign: "left", cursor: "pointer" }}>
              <input type="radio" name="handover-mode" checked={mode === "existing"} onChange={() => setMode("existing")} style={{ width: "auto", flex: "none", margin: "3px 0 0" }} />
              <span>A guide already in FolkOPS</span>
            </label>
          </fieldset>

          {mode === "external" ? (
            <fieldset disabled={busy} className="paydoc-fields">
              <label>
                <span className="paydoc-label">Prefix</span>
                <select value={prefix} onChange={(e) => setPrefix(Number(e.target.value))}>
                  {NAME_PREFIXES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              {field("fullName", "Full name * (no prefix)", { autoComplete: "off", placeholder: "As on their ID card" })}
              {field("phone", "Phone", { inputMode: "tel", autoComplete: "off" })}
              {field("taxId", "Tax ID (13 digits)", { inputMode: "numeric", autoComplete: "off" })}
              {field("licenseNo", "Guide licence no.", { autoComplete: "off" })}
              <label style={{ gridColumn: "1 / -1" }}>
                <span className="paydoc-label">Address (as on ID card — for the withholding certificate)</span>
                <textarea rows={2} value={ext.address} onChange={(e) => setExt((x) => ({ ...x, address: e.target.value }))} style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
              {field("bankName", "Bank", { autoComplete: "off" })}
              {field("bankAccountNo", "Account no.", { inputMode: "numeric", autoComplete: "off" })}
              {field("bankAccountName", "Account name", { autoComplete: "off" })}
              <label style={{ gridColumn: "1 / -1" }}>
                <span className="paydoc-label">Guide licence card (หน้าบัตรไกด์)</span>
                <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setCard(e.target.files?.[0] ?? null)} />
              </label>
              {cardUrl && <img src={cardUrl} alt="Guide licence card" style={{ gridColumn: "1 / -1", maxHeight: 180, maxWidth: "100%", objectFit: "contain", borderRadius: 8, border: "1px solid var(--line)" }} />}
              {card && !cardUrl && <span style={{ gridColumn: "1 / -1", fontSize: 12.5, color: "var(--ink-soft)" }}>📎 {card.name}</span>}
              <label style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                <input type="checkbox" checked={toPeak} onChange={(e) => setToPeak(e.target.checked)} style={{ width: "auto", flex: "none", margin: "3px 0 0" }} />
                <span>Add them to PEAK as a supplier now <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>— links the existing PEAK contact with this tax ID, or creates one (บุคคลธรรมดา)</span></span>
              </label>
            </fieldset>
          ) : (
            <label>
              <span className="paydoc-label">Guide *</span>
              <select value={toGuideId} onChange={(e) => setToGuideId(e.target.value)} disabled={busy || !guides}>
                <option value="">{guides === null ? "Loading…" : "Choose the guide who took over"}</option>
                {(guides ?? []).map((g) => <option key={g.guideId} value={g.guideId}>{g.guideId} · {g.name}</option>)}
              </select>
            </label>
          )}
          {mode === "external" && taxDigits.length > 0 && taxDigits.length !== 13 && <Note tone="warn">A Thai tax ID has 13 digits — this one has {taxDigits.length}.</Note>}
          {mode === "external" && !taxDigits && <Note tone="warn">Without a tax ID the withholding certificate cannot be issued{toPeak ? ", and they cannot be added to PEAK" : ""}.</Note>}

          <fieldset disabled={busy} className="paydoc-fields">
            <label>
              <span className="paydoc-label">Handed over at *</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            <label>
              <span className="paydoc-label">Reason</span>
              <select value={reason} onChange={(e) => setReason(e.target.value as HandoverReason)}>
                {HANDOVER_REASONS.map((r) => <option key={r} value={r}>{HANDOVER_REASON_LABEL[r]}</option>)}
              </select>
            </label>
            <label style={{ gridColumn: "1 / -1" }}>
              <span className="paydoc-label">Internal note (operators only)</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened — not shown to any guide" style={{ width: "100%", boxSizing: "border-box" }} />
            </label>
          </fieldset>

          <div className="paydoc-sum">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{guideId} {guideName} — guide fee</span><b className="num">{thb(fromNet)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{mode === "existing" ? (toGuideId || "Replacement") : (ext.fullName.trim() || "Replacement")} — guide fee{toT.wht > 0 ? ` (${thb(toGross)} − ${thb(toT.wht)} WHT)` : ""}</span><b className="num">{thb(toT.netGuideFee)}</b></div>
          </div>
          <Note tone="warn">
            {guideId} keeps the guests, no-shows and the end-of-tour report, and is still reimbursed the expenses they paid. The replacement gets their own job sheet for their fee and their own expenses. Nobody is notified.
          </Note>
          {reasons.length > 0 && <Note tone="danger"><b>Not recorded.</b>{reasons.map((x, i) => <div key={i} style={{ marginTop: 4 }}>{x}</div>)}</Note>}
        </div>

        <div className="mfoot">
          {!busy && !ready && <span style={{ marginRight: "auto", fontSize: 12.5, color: "var(--ink-soft)" }}>{!HANDOVER_TIME.test(time) ? "Enter the handover time" : mode === "existing" ? "Choose the guide" : ext.fullName.trim().length < 2 ? "Enter the guide's full name" : "Enter the 13-digit tax ID (or untick PEAK)"} to continue</span>}
          <button className="btn ghost" onClick={close} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={!ready || busy}>{busy ? "Recording…" : "Record handover"}</button>
        </div>
      </div>
    </div>
  );
}
