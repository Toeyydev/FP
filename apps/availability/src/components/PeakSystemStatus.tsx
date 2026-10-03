"use client";

import { useCallback, useEffect, useState } from "react";
import type { PeakSafety, ServiceReport } from "@/lib/peak-switches";

// The PEAK switches as BOTH services hold them (lib/peak-switches), for the people who
// have to act on them. FP and payment-worker each report their own; this shows the two
// side by side, the combined state, what is waiting, and — when they disagree or are
// unsafe — exactly which variables to set. It never changes a variable itself.

type Status = PeakSafety & { counts: { readyToPost: number; failed: number; needsReview: number; sending: number; inPeak: number; inPeakLinked: number; closed: number } };

const STATE: Record<PeakSafety["state"], { th: string; en: string; tone: "ok" | "warn" | "danger" | "muted" }> = {
  AUTO: { th: "ส่ง PEAK อัตโนมัติ (ทั้งสอง service ตรงกัน)", en: "Automatic posting — both services agree", tone: "ok" },
  LINKS: { th: "โหมดผูกเอกสาร PEAK เดิม (ไม่ส่งอัตโนมัติ)", en: "Linking existing PEAK documents — nothing is posted", tone: "warn" },
  OFF: { th: "ปิดการส่ง PEAK", en: "PEAK posting is off", tone: "muted" },
  UNSAFE: { th: "ไม่ปลอดภัย — หยุดส่ง/ผูก และหยุดบันทึกรายการบัญชีใหม่", en: "UNSAFE — posting, linking and new accounting entries are stopped", tone: "danger" },
  MISMATCH: { th: "FP กับ payment-worker ตั้งค่าไม่ตรงกัน", en: "FP and payment-worker disagree", tone: "danger" },
  UNKNOWN: { th: "ยังไม่ทราบสถานะของ payment-worker", en: "payment-worker's state is not known", tone: "warn" },
};
const TONE = { ok: "var(--green, #2e7d4f)", warn: "#8a6100", danger: "var(--danger, #b3402f)", muted: "var(--ink-soft)" };

const when = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  const local = d.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${local} (${mins <= 0 ? "just now" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`})`;
};
const onOff = (b: boolean | undefined) => (b ? <b>1 · on</b> : <span>0 · off</span>);

export default function PeakSystemStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/peak/switches", { cache: "no-store" });
      if (!r.ok) throw new Error(`Could not load the PEAK status (HTTP ${r.status})`);
      setS(await r.json() as Status); setErr(null);
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const st = s ? STATE[s.state] : null;
  const row = (name: string, r: (ServiceReport & { stale?: boolean }) | null) => (
    <tr key={name} data-service={name}>
      <td><b>{name}</b>{r?.stale && <span style={{ color: TONE.danger }}> · not reporting</span>}</td>
      <td>{r ? onOff(r.autoSync) : "—"}</td>
      <td>{r ? onOff(r.existingLinks) : "—"}</td>
      <td className="mono" style={{ fontSize: 11.5 }}>{r?.version ? r.version.slice(0, 7) : "—"}</td>
      <td>{when(r?.startedAt)}</td>
      <td>{name === "payment-worker" ? when(r?.lastSuccessAt) : when(r?.lastSeenAt)}{r?.lastError && <span style={{ display: "block", color: TONE.danger, fontSize: 11.5 }}>{r.lastError}</span>}</td>
    </tr>
  );

  return (
    <div className="js-peak-status" data-state={s?.state ?? ""} style={{ display: "grid", gap: 8, border: `1px solid ${st ? TONE[st.tone] : "var(--line)"}`, borderRadius: 10, padding: "10px 12px", background: "var(--card, #fff)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>PEAK status · สถานะการเชื่อม PEAK</h3>
        {st && <b className="js-peak-state" style={{ color: TONE[st.tone] }}>{st.en} · {st.th}</b>}
        <span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>Checked {s ? when(s.checkedAt) : "—"}</span>
        <button className="btn sm js-peak-refresh" onClick={() => void load()} disabled={busy}>{busy ? "Checking…" : "Refresh"}</button>
      </div>
      {err && <div className="banner danger" role="alert">{err}</div>}
      {s && s.issues.map((i) => (
        <div key={i.code} className={`banner ${i.code.startsWith("UNSAFE") || i.code === "MISMATCH" ? "danger" : "warn"} js-peak-issue`} data-code={i.code} role="alert" style={{ margin: 0 }}>
          <b>{i.th}</b> — {i.en}<div style={{ fontSize: 12 }}>How to fix · วิธีแก้: {i.fix}</div>
        </div>
      ))}
      {s && (
        <>
          <div className="tablewrap">
            <table className="adv-table">
              <thead><tr><th>Service</th><th>PEAK_ADVANCE_AUTO_SYNC</th><th>ADVANCE_EXISTING_PEAK_LINKS_ENABLED</th><th>Version</th><th>Deployed (started)</th><th>Last successful run · ทำงานสำเร็จล่าสุด</th></tr></thead>
              <tbody>{row("FP", s.fp)}{row("payment-worker", s.worker)}</tbody>
            </table>
          </div>
          <div className="js-peak-counts" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
            <span data-k="ready"><b>{s.counts.readyToPost}</b> Ready to post · รอส่ง</span>
            <span data-k="failed" style={{ color: s.counts.failed ? TONE.danger : undefined }}><b>{s.counts.failed}</b> Failed · ส่งไม่ได้</span>
            <span data-k="review" style={{ color: s.counts.needsReview ? TONE.danger : undefined }}><b>{s.counts.needsReview}</b> Needs review · ต้องตรวจ</span>
            <span data-k="linked"><b>{s.counts.inPeakLinked}</b> In PEAK (linked) · ผูกเอกสารเดิม</span>
            <span data-k="posted" className="muted"><b>{s.counts.inPeak}</b> In PEAK (all) · อยู่ใน PEAK ทั้งหมด</span>
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Switches are set per service on Railway; this page only reads them. · ค่าเหล่านี้ตั้งแยกแต่ละ service บน Railway หน้านี้อ่านอย่างเดียว
          </div>
        </>
      )}
    </div>
  );
}
