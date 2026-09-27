"use client";

import { useEffect, useState } from "react";

// Which certificate in lieu of receipt belongs to this job sheet — a pointer, not the document.
//
// ADMIN only, like everything about certificates: the server refuses anyone else, and the
// sheet only mounts this for an admin. It never creates anything. With no certificate it
// says what the existing panel is for; with one it names it and links its filed PDF.

type Cert = { id: string; certificateNo: string; status: string; labelTh?: string; driveUrl?: string | null; linkedAt?: string | null };
type Info = { certificates: Cert[]; rowsNeedingCertificate: unknown[] };

export default function CertificateReference({ guideId, date, slotIdx }: { guideId: string; date: string; slotIdx: number }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await fetch(`/api/jobsheet/certificate?guideId=${encodeURIComponent(guideId)}&date=${date}&slotIdx=${slotIdx}`, { cache: "no-store" });
      if (!live) return;
      if (!r.ok) { setFailed(true); return; }
      setInfo((await r.json()) as Info);
    })();
    return () => { live = false; };
  }, [guideId, date, slotIdx]);

  if (failed) return null;
  if (!info) return null;
  const active = info.certificates.find((c) => c.status !== "VOID") ?? null;
  const withdrawn = info.certificates.filter((c) => c.status === "VOID");
  const need = info.rowsNeedingCertificate.length;

  return (
    <div aria-label="ใบรับรองแทนใบเสร็จรับเงินของใบงานนี้" style={{ marginTop: 12, fontSize: 12.5, border: "1px solid var(--line,#d9d9d9)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>ใบรับรองแทนใบเสร็จรับเงิน <span style={{ fontWeight: 400, color: "var(--ink-soft,#777)" }}>· เอกสารประกอบบัญชีแยกจาก Job Sheet (เห็นเฉพาะ ADMIN)</span></div>
      {active ? (
        <div>
          เลขที่ <b className="mono">{active.certificateNo}</b> · {active.labelTh ?? active.status}
          {active.driveUrl ? <> · <a href={active.driveUrl} target="_blank" rel="noopener noreferrer">เปิดไฟล์ใน Drive</a></> : null}
        </div>
      ) : need > 0 ? (
        <div>
          ยังไม่มีใบรับรอง — ใบงานนี้มี {need} รายการที่ไกด์จ่ายเองโดยไม่มีใบเสร็จ ใช้ส่วน “ใบรับรองแทนใบเสร็จรับเงิน” ด้านบนตามขั้นตอนเดิม: สร้างร่าง → รับรอง → จัดเก็บใน Drive → link · ระบบไม่สร้างให้อัตโนมัติ
        </div>
      ) : (
        <div style={{ color: "var(--ink-soft,#666)" }}>ยังไม่มีใบรับรอง และตอนนี้ไม่มีรายการที่ต้องใช้ (เงินที่ไกด์จ่ายเองโดยไม่มีใบเสร็จ)</div>
      )}
      {withdrawn.length > 0 && (
        <div style={{ color: "var(--ink-soft,#666)", marginTop: 2 }}>ยกเลิกแล้ว: {withdrawn.map((c) => c.certificateNo).join(", ")}</div>
      )}
    </div>
  );
}
