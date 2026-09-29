"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthHeader } from "@/components/AuthHeader";

// One correction, one button: take a payment slip off the job it was wrongly attached to.
//
// Opening the page changes nothing. It shows what the row says now and what it will say
// after, what stays untouched, which notices would be withdrawn and how the Drive file would
// be renamed — then asks for a reason and an explicit confirmation. The server checks
// everything again when the button is pressed.

type Values = { status: string; paidAt: string | null; approvedBy: string | null; approvedAt: string | null; eslipUrl: string | null };
type Plan = {
  target: { guideId: string; date: string; slotIdx: number; tourPaymentId: string; driveFileId: string; rightfulGuideId: string };
  canApply: boolean; problems: string[]; jobRef: string | null;
  before: Values; after: Values;
  rightful: { guideId: string; tourPaymentId: string | null; status: string | null; peakRef: string | null; driveFileId: string | null; fileName: string | null };
  proof: { md5: string | null; sameBytes: boolean };
  notices: { id: string; kind: string; createdAt: string }[];
  drive: { fileId: string; oldName: string; newName: string } | null;
};
type Correction = { auditId: string; correctedAt: string; rename: { fileId: string; oldName: string; newName: string }; renamed: boolean };
type Drive = { status: "RENAMED" | "FAILED" | "ALREADY_RENAMED"; fileId: string; oldName: string; newName: string; error: string | null; retry: string | null };

const MIN_REASON = 20;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }) : "—");
const fileOf = (url: string | null) => (url ? (url.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ?? url) : "—");

export default function SlipCorrection() {
  const sp = useSearchParams();
  const q = ["guideId", "date", "slotIdx", "tourPaymentId", "driveFileId", "rightfulGuideId"].map((k) => [k, sp.get(k) ?? ""] as const);
  const qs = new URLSearchParams(q as [string, string][]).toString();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [error, setError] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ auditId: string; revoked: number; drive: Drive } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/admin/payment-corrections/detach-slip?${qs}`, { cache: "no-store" });
    const d = (await r.json().catch(() => ({}))) as { plan?: Plan | null; correction?: Correction | null; reasons?: string[] };
    if (!r.ok) { setError(d.reasons ?? [r.status === 403 || r.status === 401 ? "เฉพาะ ADMIN เท่านั้น" : `โหลดไม่สำเร็จ (${r.status})`]); return; }
    setError([]);
    setPlan(d.plan ?? null);
    setCorrection(d.correction ?? null);
  }, [qs]);
  useEffect(() => { void load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const r = await fetch("/api/admin/payment-corrections/detach-slip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown> & { reasons?: string[] };
    setBusy(false);
    return { ok: r.ok, d };
  };

  const apply = async () => {
    if (!plan) return;
    const { ok, d } = await post({ action: "detach", ...plan.target, reason: reason.trim() });
    if (!ok) { setError(d.reasons ?? ["ไม่สำเร็จ"]); await load(); return; }
    setDone({ auditId: String(d.auditId), revoked: (d.revokedNotificationIds as string[]).length, drive: d.drive as Drive });
    await load();
  };
  const retry = async () => {
    const id = plan?.target.tourPaymentId ?? sp.get("tourPaymentId") ?? "";
    const { ok, d } = await post({ action: "retry_rename", tourPaymentId: id });
    if (!ok) { setError(d.reasons ?? ["ไม่สำเร็จ"]); return; }
    setDone((x) => ({ auditId: x?.auditId ?? correction?.auditId ?? "", revoked: x?.revoked ?? 0, drive: d.drive as Drive }));
    await load();
  };

  const Row = ({ label, a, b }: { label: string; a: string; b: string }) => (
    <tr><td>{label}</td><td className="mono">{a}</td><td className="mono" style={{ color: a === b ? "inherit" : "var(--danger)" }}>{b}</td></tr>
  );

  const renamePending = correction && !correction.renamed;
  return (
    <div className="wrap">
      <AuthHeader backHref="/admin" />
      <section className="card" style={{ padding: 16 }} aria-label="แก้สลิปที่แนบผิดงาน">
        <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>แก้สลิปที่แนบผิดงาน</h1>
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
          เปลี่ยนงานที่ขึ้นว่าจ่ายแล้วเพราะสลิปของคนอื่นกลับเป็น “ยังไม่จ่าย” ถอดลิงก์สลิปออก และถอนแจ้งเตือนที่ยังไม่ได้อ่าน — ไม่ลบไฟล์ใน Drive และไม่แตะแถวของเจ้าของสลิป
        </div>

        {error.length > 0 && <ul role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>{error.map((e, i) => <li key={i}>{e}</li>)}</ul>}

        {correction && (
          <div style={{ marginTop: 12, fontSize: 13, background: "var(--green-bg)", border: "1px solid var(--green-line)", borderRadius: 8, padding: "8px 10px" }}>
            แก้แล้วเมื่อ {when(correction.correctedAt)} · AuditLog <span className="mono">{correction.auditId}</span> · ไฟล์ Drive: {correction.renamed ? "เปลี่ยนชื่อแล้ว" : <b style={{ color: "var(--danger)" }}>ยังไม่ได้เปลี่ยนชื่อ</b>}
          </div>
        )}

        {plan && !correction && (
          <>
            <h2 style={{ fontSize: 15, margin: "14px 0 4px" }}>งาน {plan.jobRef ?? "—"} · {plan.target.guideId} · {plan.target.date} slot {plan.target.slotIdx}</h2>
            <div className="grid-scroll">
              <table className="acct-table" aria-label="ค่าก่อนและหลัง">
                <thead><tr><th>ช่อง</th><th>ตอนนี้</th><th>หลังแก้</th></tr></thead>
                <tbody>
                  <Row label="สถานะ" a={plan.before.status} b={plan.after.status} />
                  <Row label="วันที่จ่าย" a={when(plan.before.paidAt)} b={when(plan.after.paidAt)} />
                  <Row label="ผู้อนุมัติ" a={plan.before.approvedBy ?? "—"} b={plan.after.approvedBy ?? "—"} />
                  <Row label="ไฟล์สลิป" a={fileOf(plan.before.eslipUrl)} b={fileOf(plan.after.eslipUrl)} />
                </tbody>
              </table>
            </div>
            <ul style={{ fontSize: 13, margin: "10px 0", paddingLeft: 18 }}>
              <li>แถวของเจ้าของสลิป <b>{plan.rightful.guideId}</b> ({plan.rightful.status ?? "—"}{plan.rightful.peakRef ? `, ${plan.rightful.peakRef}` : ""}) และสลิป <span className="mono">{plan.rightful.driveFileId ?? "—"}</span>: <b>ไม่เปลี่ยน</b></li>
              <li>สลิปสองไฟล์เป็นไฟล์เดียวกันทุกไบต์: {plan.proof.sameBytes ? "ใช่ (md5 ตรงกัน)" : <b style={{ color: "var(--danger)" }}>ไม่ใช่ / ตรวจไม่ได้</b>}</li>
              <li>แจ้งเตือนที่ยังไม่ได้อ่านซึ่งจะถูกถอน: {plan.notices.length} รายการ{plan.notices.map((n) => ` (${when(n.createdAt)})`).join("")}</li>
              {plan.drive && <li>ไฟล์ Drive <span className="mono">{plan.drive.fileId}</span> (file id เดิม ไม่ลบ): “{plan.drive.oldName}” → “{plan.drive.newName}” — เปลี่ยนหลังบันทึกฐานข้อมูลสำเร็จ</li>}
            </ul>
            {!plan.canApply && (
              <div role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
                <b>ยังแก้ไม่ได้:</b><ul>{plan.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            )}
            {plan.canApply && (
              <div style={{ display: "grid", gap: 8, maxWidth: 640 }}>
                <label style={{ display: "grid", gap: 2, fontSize: 13 }}>เหตุผลการแก้ไข (อย่างน้อย {MIN_REASON} ตัวอักษร)
                  <textarea aria-label="เหตุผลการแก้ไข" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
                </label>
                <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" aria-label="ยืนยันการแก้ไข" checked={sure} onChange={(e) => setSure(e.target.checked)} />
                  ตรวจค่าก่อน–หลังแล้ว และยืนยันให้แก้ในชื่อของฉัน
                </label>
                <div><button type="button" className="btn primary" disabled={busy || !sure || reason.trim().length < MIN_REASON} onClick={apply}>ถอดสลิปและเปลี่ยนเป็น PENDING</button></div>
              </div>
            )}
          </>
        )}

        {done && (
          <div aria-label="ผลการแก้ไข" style={{ marginTop: 12, fontSize: 13 }}>
            <div>บันทึกแล้ว · AuditLog <span className="mono">{done.auditId}</span> · ถอนแจ้งเตือน {done.revoked} รายการ</div>
            <div>ไฟล์ Drive: {done.drive.status === "FAILED" ? <b style={{ color: "var(--danger)" }}>เปลี่ยนชื่อไม่สำเร็จ ({done.drive.error})</b> : `เปลี่ยนชื่อแล้ว → “${done.drive.newName}”`}</div>
            {done.drive.retry && <div style={{ color: "var(--ink-soft)" }}>{done.drive.retry}</div>}
          </div>
        )}
        {renamePending && (
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy} onClick={retry}>ลองเปลี่ยนชื่อไฟล์อีกครั้ง</button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)", marginLeft: 8 }}>ใช้ไฟล์เดิมและชื่อใหม่ที่บันทึกไว้ ไม่แก้ฐานข้อมูลซ้ำ</span>
          </div>
        )}
      </section>
    </div>
  );
}
