"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthHeader } from "@/components/AuthHeader";

// The historical evidence campaign: every job before the cutoff, and where each stands.
//
// Loading this page changes nothing. Every write is a button an admin presses on ONE job,
// and each one quotes back the fingerprint of the sheet it was shown, so a sheet that
// moved in the meantime is refused rather than decided blind.
//
// A payer the rules would suggest is shown pre-selected and labelled as a suggestion. It
// is not written to the job sheet until the admin presses "ยืนยัน Paid By".
//
// A NOT REQUIRED job is not a dead end. Its panel says what a certificate would need, and
// guide-paid rows under an older waiver (or, with a warning, a receipt) can be ticked for a
// certificate; saving the ticks is its own action, and moves the job to READY TO ISSUE when
// every payer and figure is confirmed.

type Status = "LINKED" | "NOT_REQUIRED" | "READY_TO_ISSUE" | "IN_PROGRESS" | "NEEDS_REVIEW";
type Payer = "GUIDE_PERSONAL" | "GUIDE_ADVANCE" | "COMPANY_DIRECT";
type Source = "GUIDE_REPORTED" | "ADMIN_RECORDED";

type Job = {
  id: string; ref: string | null; date: string; slotIdx: number; guideId: string; guideName: string;
  approved: boolean; guideReported: boolean; jobSheetUrl: string;
  status: Status; completed: boolean; confirmed: boolean; reopened: boolean; reviewed: boolean;
  firstReason: string | null; reasonCount: number;
  certifiable: { count: number; totalSatang: number };
  certificate: { id: string; certificateNo: string; status: string } | null;
  rowsNeedingPayer: number;
  optInCount: number; firstStep: string | null;
  snapshotHash: string; reviewVersion: number; reviewDecision: string | null; suggestedSource: Source;
};
type Bucket = { jobs: number; rows: number; totalSatang: number };
type List = {
  ok: true; cutoff: string; cutoffTh: string;
  labels: Record<Status, string>;
  notRequiredReasons: Record<string, string>;
  summary: { total: number; completed: number; reviewed: number; reopened: number; notRequiredConfirmed: number; notRequiredCandidates: number; byStatus: Record<Status, Bucket> };
  jobs: Job[];
};
type Row = {
  index: number; identity: string; description: string; expenseType: string; kind: string;
  price: number | null; pax: number | null; amountSatang: number;
  storedPayer: string; payer: string; basis: string; suggestion: Payer | null; needsPayerConfirmation: boolean;
  evidence: string; certificateId: string | null; inGuideReport: boolean | null; issues: string[];
  hasReceipt: boolean; optIn: "WAIVED" | "HAS_RECEIPT" | null;
  requested: { byName: string; at: string; receiptAcknowledged: boolean } | null;
};
type Detail = {
  id: string; ref: string | null; date: string; slotIdx: number; guideName: string; guideId: string;
  approved: boolean; jobSheetUrl: string; guideExpensesAt: string | null; guideExpensesNote: string | null; peakDocumentNo: string | null;
  guideReport: { description: string; price: number | null; pax: number | null; amountSatang: number; paidBy: string | null; inSheet: boolean }[] | null;
  draftPdfUrl: Record<Source, string>;
  classification: {
    status: Status; completed: boolean; confirmed: boolean; reopened: boolean; reasons: string[]; rows: Row[];
    certifiable: { count: number; totalSatang: number };
    activeCertificate: { id: string; certificateNo: string; status: string } | null;
    snapshotHash: string;
    review: { decision: string; current: boolean; reasonCode: string | null; note: string | null; decidedByName: string | null; decidedAt: string | null; version: number } | null;
    suggestedNotRequiredReason: string | null;
    certificatePath: string[]; optInCount: number;
    source: { guideReportedAt: string | null; guideReportMatches: boolean; guideReportedAvailable: boolean; guideReportedReason: string | null; suggested: Source };
  };
};

const ORDER: Status[] = ["NEEDS_REVIEW", "READY_TO_ISSUE", "IN_PROGRESS", "NOT_REQUIRED", "LINKED"];
const TONE: Record<Status, { bg: string; fg: string; line: string }> = {
  LINKED: { bg: "var(--green-bg)", fg: "var(--green)", line: "var(--green-line)" },
  NOT_REQUIRED: { bg: "var(--grey-bg)", fg: "#52525b", line: "var(--line-strong)" },
  READY_TO_ISSUE: { bg: "#EEF2FF", fg: "#3730A3", line: "#C7D2FE" },
  IN_PROGRESS: { bg: "var(--assign-bg)", fg: "var(--assign)", line: "var(--assign-line)" },
  NEEDS_REVIEW: { bg: "var(--danger-bg)", fg: "var(--danger)", line: "var(--danger-line)" },
};
const PAYER_TH: Record<string, string> = {
  GUIDE_PERSONAL: "ไกด์จ่ายเอง (Guide Personal)", GUIDE_ADVANCE: "เงินทดรอง (Guide Advance)",
  COMPANY_DIRECT: "บริษัทจ่ายตรง (Company Direct)", UNSPECIFIED: "ยังไม่ระบุ",
};
const BASIS_TH: Record<string, string> = {
  OPERATOR: "คนบันทึก", GUIDE: "ไกด์เลือกเอง", CATEGORY_DEFAULT: "ค่าเริ่มต้นตามประเภท",
  BUSINESS_RULE: "ตามกฎ (ยังไม่ยืนยัน)", UNCONFIRMED: "ข้อมูลเก่า ไม่มีคนยืนยัน", NONE: "ไม่มี",
};
const EVIDENCE_TH: Record<string, string> = {
  UNUSED: "ไม่ได้ใช้", PAYER_UNKNOWN: "ยังไม่รู้ผู้จ่าย", NOT_GUIDE_MONEY: "ไม่ใช่เงินไกด์", HAS_RECEIPT: "มีใบเสร็จ", WAIVED: "ADMIN ยกเว้น",
  CERTIFIED: "มีใบรับรอง", NEEDS_CERTIFICATE: "ต้องใช้ใบรับรอง", BROKEN: "หลักฐานใช้ไม่ได้",
};
const baht = (satang: number) => (satang / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }) : "—");

function Pill({ status, label }: { status: Status; label: string }) {
  const t = TONE[status];
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: t.bg, color: t.fg, border: `1px solid ${t.line}`, whiteSpace: "nowrap" }}>{label}</span>;
}

async function post(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; reasons: string[] }> {
  const r = await fetch(`/api/admin/historical-evidence/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = (await r.json().catch(() => ({}))) as { reasons?: string[] };
  return { ok: r.ok, reasons: d.reasons ?? (r.ok ? [] : [`HTTP ${r.status}`]) };
}

export default function HistoricalEvidenceQueue() {
  const [list, setList] = useState<List | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | Status | "OPEN">("OPEN");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [guide, setGuide] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [batchMsg, setBatchMsg] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/historical-evidence", { cache: "no-store" });
    if (!r.ok) { setError(r.status === 403 || r.status === 401 ? "เฉพาะ ADMIN เท่านั้น" : `โหลดไม่สำเร็จ (${r.status})`); return; }
    setList((await r.json()) as List);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const guides = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of list?.jobs ?? []) m.set(j.guideId, j.guideName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [list]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list?.jobs ?? []).filter((j) => {
      if (status === "OPEN" && j.completed) return false;
      if (status && status !== "OPEN" && j.status !== status) return false;
      if (from && j.date < from) return false;
      if (to && j.date > to) return false;
      if (guide && j.guideId !== guide) return false;
      if (needle && ![j.ref ?? "", j.guideName, j.guideId, j.date].some((v) => v.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [list, q, status, from, to, guide]);

  /** The queue "next" walks: the picked jobs if any are picked, otherwise what is shown. */
  const queue = useMemo(() => (picked.size ? shown.filter((j) => picked.has(j.id)) : shown), [shown, picked]);
  const nextAfter = useCallback((id: string | null) => {
    const open = queue.filter((j) => !j.completed);
    if (!open.length) return null;
    const at = id ? open.findIndex((j) => j.id === id) : -1;
    return open[(at + 1) % open.length]?.id ?? null;
  }, [queue]);

  const prepareSelected = async () => {
    const chosen = (list?.jobs ?? []).filter((j) => picked.has(j.id));
    const ready = chosen.filter((j) => j.status === "READY_TO_ISSUE" && j.reviewDecision === "REVIEWED" && j.reviewed);
    const skipped = chosen.filter((j) => !ready.includes(j));
    if (!ready.length) { setBatchMsg(["ไม่มีงานที่เลือกที่พร้อม: ต้องเป็น READY TO ISSUE และบันทึกว่าตรวจแล้วกับข้อมูลปัจจุบัน"]); return; }
    if (!window.confirm(`เตรียมร่างใบรับรอง ${ready.length} งาน?\n\nสร้างเป็นร่าง (รอรับรอง) เท่านั้น ยังไม่รับรอง ไม่จัดเก็บ และไม่ link — แต่ละใบต้องเปิดใน Job Sheet เพื่อรับรองทีละใบ`)) return;
    setBusy(true);
    const out: string[] = [];
    for (const j of ready) {
      const r = await post(j.id, { action: "prepare_certificate", snapshotHash: j.snapshotHash, source: j.suggestedSource });
      out.push(`${j.ref ?? j.id}: ${r.ok ? "สร้างร่างแล้ว" : r.reasons.join(" ")}`);
    }
    for (const j of skipped) out.push(`${j.ref ?? j.id}: ข้าม (${j.status}${j.reviewed ? "" : ", ยังไม่ได้บันทึกว่าตรวจแล้ว"})`);
    setBatchMsg(out);
    setBusy(false);
    await load();
  };

  if (error) return <div className="wrap"><AuthHeader backHref="/admin" /><section className="card" style={{ padding: 16 }}>{error}</section></div>;
  if (!list) return <div className="wrap"><AuthHeader backHref="/admin" /><section className="card" style={{ padding: 16 }}>กำลังโหลด…</section></div>;

  const s = list.summary;
  const pct = s.total ? Math.round((s.completed / s.total) * 100) : 0;
  return (
    <div className="wrap">
      <AuthHeader backHref="/admin" />
      <section className="card" style={{ padding: 16 }}>
        <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>หลักฐานค่าใช้จ่ายย้อนหลัง</h1>
        <div style={{ color: "var(--ink-soft)", fontSize: 13 }}>
          ทุกใบงานที่วันปฏิบัติงานก่อน {list.cutoffTh} ต้องจบที่ CERTIFICATE LINKED, NOT REQUIRED (ADMIN ยืนยันแล้ว) หรือ NEEDS REVIEW ที่มีเหตุผลตรวจสอบได้ — ห้ามออกใบรับรองให้รายการที่ไม่มีจริง
        </div>

        <div style={{ margin: "14px 0 6px", fontSize: 13 }}>
          เสร็จแล้ว <b>{s.completed}</b> จาก <b>{s.total}</b> งาน ({pct}%) · บันทึกการตรวจกับข้อมูลปัจจุบันแล้ว {s.reviewed} งาน{s.reopened ? ` · ถูกเปิดใหม่เพราะใบงานเปลี่ยน ${s.reopened} งาน` : ""}
        </div>
        <div aria-label="progress" style={{ height: 8, borderRadius: 999, background: "var(--grey-bg)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "var(--green)" }} />
        </div>

        <div className="grid-scroll" style={{ marginTop: 14 }}>
          <table className="acct-table" aria-label="สรุปตามสถานะ">
            <thead><tr><th>สถานะ</th><th className="r">งาน</th><th className="r">แถวที่เกี่ยวข้อง</th><th className="r">ยอดเงิน (บาท)</th></tr></thead>
            <tbody>
              {(["LINKED", "NOT_REQUIRED", "READY_TO_ISSUE", "IN_PROGRESS", "NEEDS_REVIEW"] as Status[]).map((k) => (
                <tr key={k} style={{ cursor: "pointer" }} onClick={() => setStatus(k)}>
                  <td><Pill status={k} label={list.labels[k]} />{k === "NOT_REQUIRED" && <span style={{ fontSize: 12, color: "var(--ink-soft)", marginLeft: 8 }}>ยืนยันแล้ว {s.notRequiredConfirmed} · รอ ADMIN ยืนยัน {s.notRequiredCandidates}</span>}</td>
                  <td className="r num">{s.byStatus[k].jobs}</td>
                  <td className="r num">{s.byStatus[k].rows}</td>
                  <td className="r num">{baht(s.byStatus[k].totalSatang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ padding: 16, marginTop: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 2, fontSize: 12 }}>ค้นหา (Job Sheet No., ไกด์)
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="FOLK-BKK-…" style={{ minWidth: 200 }} />
          </label>
          <label style={{ display: "grid", gap: 2, fontSize: 12 }}>สถานะ
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="OPEN">ยังไม่เสร็จทั้งหมด</option>
              <option value="">ทั้งหมด</option>
              {ORDER.map((k) => <option key={k} value={k}>{list.labels[k]}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 2, fontSize: 12 }}>ไกด์
            <select value={guide} onChange={(e) => setGuide(e.target.value)}>
              <option value="">ทุกคน</option>
              {guides.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 2, fontSize: 12 }}>ตั้งแต่วันที่<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label style={{ display: "grid", gap: 2, fontSize: 12 }}>ถึงวันที่<input type="date" value={to} onChange={(e) => setTo(e.target.value)} max={list.cutoff} /></label>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn primary" onClick={() => setOpenId(nextAfter(openId))} disabled={!queue.some((j) => !j.completed)}>ตรวจงานถัดไป →</button>
        </div>

        <div style={{ margin: "10px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
          <span>แสดง {shown.length} งาน · เลือก {picked.size}</span>
          <button type="button" className="btn sm" onClick={() => setPicked(new Set(shown.map((j) => j.id)))}>เลือกทั้งหมดที่แสดง</button>
          <button type="button" className="btn sm" onClick={() => setPicked(new Set())} disabled={!picked.size}>ล้างที่เลือก</button>
          <button type="button" className="btn sm" disabled={busy || !picked.size} onClick={prepareSelected} title="เฉพาะงาน READY TO ISSUE ที่บันทึกว่าตรวจแล้ว — สร้างเป็นร่างเท่านั้น">เตรียมร่างงานที่เลือก</button>
          {picked.size > 0 && <span style={{ color: "var(--ink-soft)" }}>“ตรวจงานถัดไป” จะเดินตามงานที่เลือก</span>}
        </div>
        {batchMsg.length > 0 && <ul style={{ fontSize: 12.5, margin: "0 0 10px", paddingLeft: 18 }}>{batchMsg.map((m, i) => <li key={i}>{m}</li>)}</ul>}

        <div className="grid-scroll">
          <table className="acct-table" aria-label="งานย้อนหลัง">
            <thead><tr><th style={{ width: 28 }} /><th>Job Sheet No.</th><th>วันที่</th><th>ไกด์</th><th>สถานะ</th><th>เหตุผล</th><th className="r">ต้องรับรอง</th><th /></tr></thead>
            <tbody>
              {shown.map((j) => (
                <tr key={j.id} style={openId === j.id ? { background: "#FAFAF9" } : undefined}>
                  <td><input type="checkbox" aria-label={`เลือก ${j.ref ?? j.id}`} checked={picked.has(j.id)} onChange={(e) => {
                    const n = new Set(picked); if (e.target.checked) n.add(j.id); else n.delete(j.id); setPicked(n);
                  }} /></td>
                  <td className="mono">{j.ref ?? "—"}</td>
                  <td className="num">{j.date}</td>
                  <td>{j.guideName}</td>
                  <td>
                    <Pill status={j.status} label={list.labels[j.status]} />
                    {j.status === "NOT_REQUIRED" && <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{j.confirmed ? "ADMIN ยืนยันแล้ว" : "รอ ADMIN ยืนยัน"}</div>}
                    {j.reopened && <div style={{ fontSize: 11, color: "var(--danger)" }}>เปิดใหม่: ใบงานเปลี่ยน</div>}
                    {j.reviewed && !j.completed && <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>ตรวจแล้ว</div>}
                  </td>
                  <td style={{ fontSize: 12, maxWidth: 360 }}>{j.firstReason ?? (j.certificate ? j.certificate.certificateNo : "")}{j.reasonCount > 1 ? ` (+${j.reasonCount - 1})` : ""}
                    {j.status === "NOT_REQUIRED" && (j.optInCount > 0
                      ? <div style={{ color: "#3730A3" }}>เลือกให้ใบรับรองครอบคลุมได้ {j.optInCount} แถว</div>
                      : j.firstStep && <div style={{ color: "var(--ink-soft)" }}>{j.firstStep}</div>)}
                  </td>
                  <td className="r num">{j.certifiable.count ? `${j.certifiable.count} แถว · ${baht(j.certifiable.totalSatang)}` : "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" className="btn sm" onClick={() => setOpenId(j.id)}>ตรวจ</button>{" "}
                    <a className="btn sm" href={j.jobSheetUrl} target="_blank" rel="noopener noreferrer">ใบงาน</a>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={8} style={{ color: "var(--ink-soft)" }}>ไม่มีงานตามตัวกรองนี้</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {openId && (
        <JobPanel key={openId} id={openId} reasons={list.notRequiredReasons} labels={list.labels}
          onClose={() => setOpenId(null)} onNext={() => setOpenId(nextAfter(openId))} onChanged={load} />
      )}
    </div>
  );
}

function JobPanel({ id, reasons, labels, onClose, onNext, onChanged }: {
  id: string; reasons: Record<string, string>; labels: Record<Status, string>;
  onClose: () => void; onNext: () => void; onChanged: () => Promise<void>;
}) {
  const [job, setJob] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** Payer choices on screen. Pre-filled with the rules' suggestion; NOT saved until confirmed. */
  const [choice, setChoice] = useState<Record<string, { payer: Payer | ""; reason: string }>>({});
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [source, setSource] = useState<Source>("ADMIN_RECORDED");
  /** Certificate ticks on screen: identity → wanted / receipt acknowledged. NOT saved until pressed. */
  const [tick, setTick] = useState<Record<string, { on: boolean; ack: boolean }>>({});

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/historical-evidence/${encodeURIComponent(id)}`, { cache: "no-store" });
    const d = (await r.json().catch(() => ({}))) as { job?: Detail; reasons?: string[] };
    if (!r.ok || !d.job) { setMsg(d.reasons ?? [`โหลดไม่สำเร็จ (${r.status})`]); return; }
    setJob(d.job);
    const c: Record<string, { payer: Payer | ""; reason: string }> = {};
    for (const row of d.job.classification.rows) if (row.needsPayerConfirmation) c[row.identity] = { payer: row.suggestion ?? "", reason: "" };
    setChoice(c);
    const t: Record<string, { on: boolean; ack: boolean }> = {};
    for (const row of d.job.classification.rows) if (row.optIn || row.requested) t[row.identity] = { on: Boolean(row.requested), ack: Boolean(row.requested?.receiptAcknowledged) };
    setTick(t);
    setReasonCode(d.job.classification.suggestedNotRequiredReason ?? "");
    setSource(d.job.classification.source.suggested);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (body: Record<string, unknown>, done: string) => {
    if (!job) return;
    setBusy(true);
    const r = await post(job.id, { ...body, snapshotHash: job.classification.snapshotHash });
    setMsg(r.ok ? [done] : r.reasons);
    setBusy(false);
    await load();
    await onChanged();
  };

  if (!job) return <aside className="card" style={{ padding: 16, marginTop: 14 }}>{msg.length ? msg.join(" ") : "กำลังโหลด…"}</aside>;
  const c = job.classification;
  const version = c.review?.version ?? 0;
  const pending = c.rows.filter((r) => r.needsPayerConfirmation);
  const toConfirm = pending.filter((r) => choice[r.identity]?.payer);
  // What the ticks would change, compared with what is saved.
  const tickable = c.rows.filter((r) => r.optIn || r.requested);
  const tickChanges = tickable.filter((r) => (tick[r.identity]?.on ?? false) !== Boolean(r.requested));
  const unackedReceipts = tickChanges.filter((r) => tick[r.identity]?.on && r.optIn === "HAS_RECEIPT" && !tick[r.identity]?.ack);
  const blockedTick = (r: Row) => r.needsPayerConfirmation || r.issues.length > 0;

  return (
    <aside className="card" style={{ padding: 16, marginTop: 14, borderColor: TONE[c.status].line }} aria-label="รายละเอียดงาน">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }} className="mono">{job.ref ?? job.id}</h2>
        <Pill status={c.status} label={labels[c.status]} />
        {c.status === "NOT_REQUIRED" && <span style={{ fontSize: 12 }}>{c.confirmed ? "ADMIN ยืนยันแล้ว" : "ข้อมูลชี้ว่าไม่ต้องใช้ — รอ ADMIN ยืนยัน"}</span>}
        <span style={{ flex: 1 }} />
        <a className="btn sm" href={job.jobSheetUrl} target="_blank" rel="noopener noreferrer">เปิดใบงาน</a>
        <button type="button" className="btn sm primary" onClick={onNext}>ตรวจงานถัดไป →</button>
        <button type="button" className="btn sm" onClick={onClose}>ปิด</button>
      </div>
      <div style={{ fontSize: 13, color: "var(--ink-soft)", margin: "6px 0 10px" }}>
        วันที่ปฏิบัติงาน {job.date} · ไกด์ {job.guideName} · {job.approved ? "อนุมัติแล้ว" : "ยังไม่อนุมัติ"} · รายงานของไกด์ {job.guideExpensesAt ? when(job.guideExpensesAt) : "ไม่มี"}{job.peakDocumentNo ? ` · PEAK ${job.peakDocumentNo}` : ""}
      </div>

      {c.reasons.length > 0 && (
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 13, color: c.status === "NEEDS_REVIEW" ? "var(--danger)" : "inherit" }}>
          {c.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      {c.review && (
        <div style={{ fontSize: 12.5, marginBottom: 10 }}>
          ผลที่บันทึกไว้: <b>{c.review.decision}</b>{c.review.reasonCode ? ` · ${reasons[c.review.reasonCode] ?? c.review.reasonCode}` : ""} โดย {c.review.decidedByName} เมื่อ {when(c.review.decidedAt)}
          {c.review.note ? ` — “${c.review.note}”` : ""} {c.review.current ? "(ตรงกับใบงานปัจจุบัน)" : <b style={{ color: "var(--danger)" }}>(ใบงานเปลี่ยนหลังจากนั้น — ใช้ไม่ได้แล้ว)</b>}
        </div>
      )}

      <h3 style={{ fontSize: 14, margin: "8px 0 4px" }}>รายการในใบงาน (operator)</h3>
      <div className="grid-scroll">
        <table className="acct-table" aria-label="รายการในใบงาน">
          <thead><tr><th>ที่</th><th>รายการ</th><th>ประเภท</th><th className="r">ราคา</th><th className="r">จำนวน</th><th className="r">ยอด</th><th>Paid By</th><th>หลักฐาน</th><th>ในรายงานไกด์</th><th>ใบรับรอง</th></tr></thead>
          <tbody>
            {c.rows.filter((r) => r.evidence !== "UNUSED").map((r) => (
              <tr key={`${r.index}-${r.identity}`}>
                <td className="num">{r.index + 1}</td>
                <td>{r.description || "—"}{r.issues.map((i, k) => <div key={k} style={{ fontSize: 11.5, color: "var(--danger)" }}>{i}</div>)}</td>
                <td>{r.expenseType || "—"}</td>
                <td className="r num">{r.price ?? "—"}</td>
                <td className="r num">{r.pax ?? "—"}</td>
                <td className="r num">{baht(r.amountSatang)}</td>
                <td style={{ minWidth: 190 }}>
                  <div>{PAYER_TH[r.storedPayer] ?? r.storedPayer}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>ที่มา: {r.storedPayer === "UNSPECIFIED" ? "ไม่มี — ยังไม่มีใครระบุ" : BASIS_TH[r.basis] ?? r.basis}</div>
                  {r.needsPayerConfirmation && (
                    <div style={{ marginTop: 4 }}>
                      <select aria-label={`Paid By แถว ${r.index + 1}`} value={choice[r.identity]?.payer ?? ""} onChange={(e) => setChoice({ ...choice, [r.identity]: { payer: e.target.value as Payer | "", reason: choice[r.identity]?.reason ?? "" } })}>
                        <option value="">— เลือกผู้จ่าย —</option>
                        {(["GUIDE_PERSONAL", "GUIDE_ADVANCE", "COMPANY_DIRECT"] as Payer[]).map((p) => <option key={p} value={p}>{PAYER_TH[p]}{r.suggestion === p ? " · ข้อเสนอ" : ""}</option>)}
                      </select>
                      <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>{r.suggestion ? `ข้อเสนอตามกฎ: ${PAYER_TH[r.suggestion]} — ยังไม่บันทึกจนกว่าจะกดยืนยัน` : "ประเภทนี้ระบบไม่เดา ต้องเลือกเอง"}</div>
                      {choice[r.identity]?.payer && r.suggestion !== choice[r.identity]?.payer && r.suggestion && (
                        <input aria-label={`เหตุผลแถว ${r.index + 1}`} placeholder="เหตุผลที่ต่างจากกฎ" value={choice[r.identity]?.reason ?? ""} onChange={(e) => setChoice({ ...choice, [r.identity]: { payer: choice[r.identity]!.payer, reason: e.target.value } })} style={{ marginTop: 4, width: "100%" }} />
                      )}
                    </div>
                  )}
                </td>
                <td>{EVIDENCE_TH[r.evidence] ?? r.evidence}</td>
                <td>{r.inGuideReport == null ? "—" : r.inGuideReport ? "ตรง" : <b style={{ color: "var(--danger)" }}>ไม่ตรง</b>}</td>
                <td style={{ minWidth: 170, fontSize: 12 }}>
                  {r.evidence === "NEEDS_CERTIFICATE" && !r.requested && <span>ต้องรวม (ไม่มีหลักฐาน)</span>}
                  {r.evidence === "CERTIFIED" && <span>มีใบรับรองแล้ว</span>}
                  {(r.optIn || r.requested) && !c.activeCertificate && (
                    <div>
                      <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input type="checkbox" aria-label={`ให้ใบรับรองครอบคลุมแถว ${r.index + 1}`} checked={tick[r.identity]?.on ?? false}
                          disabled={busy || (blockedTick(r) && !r.requested)}
                          onChange={(e) => setTick({ ...tick, [r.identity]: { on: e.target.checked, ack: tick[r.identity]?.ack ?? false } })} />
                        ให้ใบรับรองครอบคลุม
                      </label>
                      {r.optIn === "WAIVED" && <div style={{ color: "var(--ink-soft)" }}>ตอนนี้มีเพียงการยกเว้นของ ADMIN แบบเดิม ไม่มีเอกสาร</div>}
                      {r.hasReceipt && (tick[r.identity]?.on ?? false) && (
                        <div style={{ color: "var(--danger)", marginTop: 2 }}>
                          มีใบเสร็จแนบอยู่แล้ว ใบรับรองจะซ้ำกับหลักฐานที่มีอยู่
                          <label style={{ display: "flex", gap: 4, alignItems: "center", color: "inherit" }}>
                            <input type="checkbox" aria-label={`ยืนยันใบเสร็จแถว ${r.index + 1}`} checked={tick[r.identity]?.ack ?? false} disabled={busy || Boolean(r.requested)}
                              onChange={(e) => setTick({ ...tick, [r.identity]: { on: true, ack: e.target.checked } })} />
                            ยืนยันว่าต้องการใบรับรองแม้มีใบเสร็จ
                          </label>
                        </div>
                      )}
                      {blockedTick(r) && !r.requested && <div style={{ color: "var(--ink-soft)" }}>ยืนยัน Paid By / ตัวเลขก่อน</div>}
                      {r.requested && <div style={{ color: "var(--ink-soft)" }}>เลือกโดย {r.requested.byName} {when(r.requested.at)}</div>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pending.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={busy || !toConfirm.length} onClick={() => act({
            action: "confirm_payers",
            rows: toConfirm.map((r) => ({ identity: r.identity, payer: choice[r.identity]!.payer, ...(choice[r.identity]!.reason.trim() ? { reason: choice[r.identity]!.reason.trim() } : {}) })),
          }, `ยืนยัน Paid By ${toConfirm.length} แถวแล้ว`)}>ยืนยัน Paid By ({toConfirm.length} แถว)</button>
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>บันทึกลงใบงานในชื่อของคุณพร้อมเวลา แยกจากการรับรองใบรับรอง</span>
        </div>
      )}

      {tickChanges.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn primary" disabled={busy || unackedReceipts.length > 0} onClick={() => {
            const adding = tickChanges.filter((r) => tick[r.identity]?.on);
            const amount = adding.reduce((t, r) => t + r.amountSatang, 0);
            const receipts = adding.filter((r) => r.hasReceipt).length;
            const text = [
              adding.length ? `ให้ใบรับรองครอบคลุม ${adding.length} แถว รวม ${baht(amount)} บาท` : "",
              tickChanges.length - adding.length ? `นำออก ${tickChanges.length - adding.length} แถว` : "",
              receipts ? `\n⚠ ${receipts} แถวมีใบเสร็จอยู่แล้ว` : "",
              "\n\nบันทึกในชื่อของคุณพร้อมเวลา ยังไม่สร้างใบรับรอง — ไม่เปลี่ยน Paid By หรือยอดเงิน",
            ].filter(Boolean).join(" · ");
            if (!window.confirm(text)) return;
            void act({ action: "select_rows", rows: tickChanges.map((r) => ({ identity: r.identity, certify: tick[r.identity]?.on ?? false, ...(tick[r.identity]?.on && r.hasReceipt ? { acknowledgeReceipt: tick[r.identity]?.ack === true } : {}) })) },
              "บันทึกรายการที่ใบรับรองจะครอบคลุมแล้ว");
          }}>บันทึกรายการที่จะรับรอง ({tickChanges.length})</button>
          {unackedReceipts.length > 0 && <span style={{ fontSize: 12, color: "var(--danger)" }}>ต้องยืนยันใบเสร็จ {unackedReceipts.length} แถวก่อน</span>}
        </div>
      )}

      <h3 style={{ fontSize: 14, margin: "14px 0 4px" }}>รายงานของไกด์</h3>
      {job.guideReport ? (
        <div className="grid-scroll">
          <table className="acct-table" aria-label="รายงานของไกด์">
            <thead><tr><th>รายการ</th><th className="r">ราคา</th><th className="r">จำนวน</th><th className="r">ยอด</th><th>Paid By ที่ไกด์เลือก</th><th>ในใบงาน</th></tr></thead>
            <tbody>{job.guideReport.map((g, i) => (
              <tr key={i}><td>{g.description}</td><td className="r num">{g.price ?? "—"}</td><td className="r num">{g.pax ?? "—"}</td><td className="r num">{baht(g.amountSatang)}</td><td>{g.paidBy ?? "—"}</td><td>{g.inSheet ? "ตรง" : <b style={{ color: "var(--danger)" }}>ไม่ตรง</b>}</td></tr>
            ))}</tbody>
          </table>
          {job.guideExpensesNote && <div style={{ fontSize: 12.5, marginTop: 4 }}>หมายเหตุไกด์: {job.guideExpensesNote}</div>}
        </div>
      ) : <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>ไกด์ไม่ได้ส่งรายงานค่าใช้จ่ายผ่านบัญชีของตน</div>}

      <h3 style={{ fontSize: 14, margin: "14px 0 6px" }}>ผลของงานนี้</h3>
      <div style={{ display: "grid", gap: 10 }}>
        {c.status === "NOT_REQUIRED" && c.certificatePath.length > 0 && (
          <div style={{ fontSize: 13, background: "#EEF2FF", border: "1px solid #C7D2FE", borderRadius: 8, padding: "8px 10px" }}>
            <b>เส้นทางสู่ใบรับรองแทนใบเสร็จ</b>
            <ol style={{ margin: "4px 0 0", paddingLeft: 18 }}>{c.certificatePath.map((t, i) => <li key={i}>{t}</li>)}</ol>
          </div>
        )}
        {c.status === "NOT_REQUIRED" && !c.confirmed && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>หรือ ถ้าตรวจแล้วว่าไม่มีเงินไกด์ที่ต้องรับรองจริง:</span>
            <select aria-label="เหตุผลที่ไม่ต้องใช้ใบรับรอง" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">— เหตุผล —</option>
              {Object.entries(reasons).map(([k, v]) => <option key={k} value={k}>{v}{k === c.suggestedNotRequiredReason ? " · ตามข้อมูล" : ""}</option>)}
            </select>
            <input placeholder={reasonCode === "OTHER" ? "หมายเหตุ (จำเป็น)" : "หมายเหตุ (ถ้ามี)"} value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 240 }} />
            <button type="button" className="btn" disabled={busy || !reasonCode} onClick={() => act({ action: "not_required", reviewVersion: version, reasonCode, ...(note.trim() ? { note: note.trim() } : {}) }, "บันทึก NOT REQUIRED แล้ว")}>ยืนยัน NOT REQUIRED</button>
          </div>
        )}
        {c.status === "NOT_REQUIRED" && c.confirmed && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input placeholder="เหตุผลที่เปิดใหม่ (อย่างน้อย 10 ตัวอักษร)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
            <button type="button" className="btn" disabled={busy || note.trim().length < 10} onClick={() => act({ action: "reopen", reviewVersion: version, note: note.trim() }, "เปิดใหม่แล้ว")}>เปิดใหม่</button>
          </div>
        )}
        {!c.completed && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input placeholder="บันทึกการตรวจ (อย่างน้อย 10 ตัวอักษร)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
            <button type="button" className="btn" disabled={busy || note.trim().length < 10 || (c.review?.decision === "NOT_REQUIRED" && c.review.current)} onClick={() => act({ action: "reviewed", reviewVersion: version, note: note.trim() }, "บันทึกว่าตรวจแล้ว")}>บันทึกว่าตรวจแล้ว</button>
          </div>
        )}
        {c.status === "READY_TO_ISSUE" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select aria-label="ที่มาของรายการ" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              <option value="GUIDE_REPORTED" disabled={!c.source.guideReportedAvailable}>ไกด์ส่งรายงานผ่านบัญชีของตน{c.source.guideReportedAvailable ? "" : ` (${c.source.guideReportedReason})`}</option>
              <option value="ADMIN_RECORDED">ADMIN บันทึกย้อนหลังจากข้อมูลที่ตรวจสอบแล้ว</option>
            </select>
            <a className="btn sm" href={job.draftPdfUrl[source]} target="_blank" rel="noopener noreferrer">ดู PDF ร่าง</a>
            <button type="button" className="btn primary" disabled={busy} onClick={() => {
              if (window.confirm(`สร้างร่างใบรับรอง ${c.certifiable.count} แถว รวม ${baht(c.certifiable.totalSatang)} บาท?\n\nเป็นร่างเท่านั้น — รับรอง จัดเก็บ และ link ต่อใน Job Sheet`)) void act({ action: "prepare_certificate", source }, "สร้างร่างใบรับรองแล้ว — เปิดใบงานเพื่อรับรองต่อ");
            }}>สร้างร่างใบรับรอง</button>
          </div>
        )}
        {(c.status === "IN_PROGRESS" || (c.activeCertificate && c.status !== "LINKED")) && (
          <div style={{ fontSize: 13 }}>
            {c.activeCertificate?.certificateNo} ({c.activeCertificate?.status}) — <a href={job.jobSheetUrl} target="_blank" rel="noopener noreferrer">เปิดใบงาน</a> เพื่อรับรอง จัดเก็บ และ link ตามขั้นตอนเดิม
          </div>
        )}
        {c.status === "LINKED" && <div style={{ fontSize: 13 }}>{c.activeCertificate?.certificateNo} ใช้เป็นหลักฐานแล้ว (LINKED)</div>}
      </div>
      {msg.length > 0 && <ul style={{ marginTop: 10, paddingLeft: 18, fontSize: 13 }}>{msg.map((m, i) => <li key={i}>{m}</li>)}</ul>}
    </aside>
  );
}
